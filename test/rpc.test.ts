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
