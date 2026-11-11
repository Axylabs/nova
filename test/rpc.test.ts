/**
 * Request/response (WS-level RPC):
 *   - client.request(name, payload) ⇄ server.handle / hub.onRequest round-trip
 *   - async responders
 *   - timeout rejection
 *   - no-responder error path
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

describe("request/response over the event wire", () => {
  test("round-trip via server.handle", async () => {
    const server = createServer({ port: 0 });
    server.handle("quote", async (payload) => {
      // echo-style responder: same schema in, same schema out
      return { ...payload, symbol: `RES:${payload.symbol}` };
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);

    const res = await c.request("quote", quote("AAPL"));
    expect(res.payload.symbol).toBe("RES:AAPL");
    expect(res.payload.bid).toBe(1);

    c.close();
    server.stop(true);
  });

  test("round-trip via hub.onRequest (events layer) with ctx", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    server.events!.onRequest("quote", async (payload, ctx) => {
      return { ...payload, symbol: `${ctx.client?.id ?? "anon"}` };
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(20); // let the client record attach

    const res = await c.request("quote", quote("X"));
    expect(res.payload.symbol).toBe(c.clientId);

    c.close();
    server.stop(true);
  });

  test("timeout rejects when the responder stalls", async () => {
    const server = createServer({ port: 0 });
    server.handle("quote", () => new Promise(() => {})); // never resolves
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);

    const t0 = Date.now();
    await c.request("quote", quote("SLOW"), { timeoutMs: 120 }).then(
      () => expect.unreachable(),
      (err: Error) => {
        expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
        expect(err.message).toContain("timed out");
      },
    );

    c.close();
    server.stop(true);
  });

  test("missing responder → descriptive error", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);

    await c.request("quote", quote("NOONE")).then(
      () => expect.unreachable(),
      (err: Error) => expect(err.message).toContain('no handler for "quote"'),
    );

    c.close();
    server.stop(true);
  });

  test("concurrent requests are correlated correctly", async () => {
    const server = createServer({ port: 0 });
    server.handle("quote", (p) => new Promise((r) => setTimeout(() => r(p), 10 + Math.random() * 30)));
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);

    const symbols = ["A", "B", "C", "D", "E"];
    const results = await Promise.all(symbols.map((s) => c.request("quote", quote(s))));
    for (let i = 0; i < symbols.length; i++) {
      expect(results[i]!.payload.symbol).toBe(symbols[i]!);
    }

    c.close();
    server.stop(true);
  });
});


describe("request/response hardening", () => {
  test("rejects an inner frame whose event differs from the responder name", async () => {
    const { decodeFrame } = await import("../src/generated/registry");
    const { encodeEvent } = await import("../src/transport/transport");
    const { bytesToB64 } = await import("../src/core/client-rpc");
    const { openWs } = await import("./helpers");
    const server = createServer({ port: 0 });
    let calls = 0;
    server.handle("quote", (payload) => {
      calls++;
      return payload;
    });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    const result = new Promise<{ ok: boolean; err: string }>((resolve) => {
      ws.onmessage = (ev) => {
        const frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (frame?.name === "rpcResult") resolve(frame.payload as { ok: boolean; err: string });
      };
    });
    const inner = encodeEvent("trade", {
      symbol: "NOT-A-QUOTE",
      price: 1,
      volume: 1,
      side: "buy",
      ts: 1,
    });
    ws.send(encodeEvent("rpcCall", {
      id: "mismatch",
      name: "quote",
      payloadB64: bytesToB64(inner),
    }) as Uint8Array<ArrayBuffer>);
    const reply = await result;
    expect(reply.ok).toBe(false);
    expect(reply.err).toContain("does not match");
    expect(calls).toBe(0);
    ws.close();
    server.stop(true);
  });

  test("bounds concurrent responders per connection without leaking the slot", async () => {
    const server = createServer({ port: 0, maxRpcInFlight: 1 });
    let release = (): void => {};
    let entered = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.handle("quote", async (payload) => {
      entered++;
      await gate;
      return payload;
    });
    const client = createClient(`ws://localhost:${server.port}/ws`);
    client.connect();
    await waitFor(() => server.clientCount === 1);
    const first = client.request("quote", quote("FIRST"));
    await waitFor(() => entered === 1);
    await client.request("quote", quote("SECOND")).then(
      () => expect.unreachable(),
      (err: Error) => expect(err.message).toContain("too many concurrent RPC calls"),
    );
    release();
    expect((await first).payload.symbol).toBe("FIRST");
    expect((await client.request("quote", quote("THIRD"))).payload.symbol).toBe("THIRD");
    expect(server.getMetrics().rpcRejected).toBe(1);
    client.close();
    server.stop(true);
  });
});
