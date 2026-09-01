/**
 * Stability / resilience tests — failure modes and resource hygiene that the
 * happy-path suites don't pin down:
 *   - a subscriber dying mid-burst never disturbs the other fan-out targets
 *   - rapid same-client-id reconnect cycles converge to a consistent registry
 *   - RingBuffer degenerate shapes (capacity 1, clear() after heavy wraparound)
 *   - snapshotRequest floods stay bounded (per-request replay ≤ historySize)
 *   - maxMessageSize exact boundary (== passes, +1 closes 1009) on BINARY frames
 *   - subscription churn (hundreds of topics) leaves no phantom rooms behind
 *   - server.stop()/drain() while publishers are mid-flight
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { RingBuffer } from "../src/core/ring";
import { decodeFrame } from "../src/generated/registry";
import { encodeEvent } from "../src/transport/transport";
import { openWs, quote, tryConnect, waitFor } from "./helpers";

function ctl(ws: WebSocket, name: Parameters<typeof encodeEvent>[0], payload: unknown): void {
  ws.send(encodeEvent(name, payload) as Uint8Array<ArrayBuffer>);
}

function decodeWs(ev: MessageEvent): ReturnType<typeof decodeFrame> {
  return decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
}

describe("fan-out resilience", () => {
  test("a subscriber dying mid-burst does not disturb the other subscribers", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const mk = async (): Promise<{ ws: WebSocket; got: number[] }> => {
      const ws = await openWs(url);
      const got: number[] = [];
      ws.onmessage = (ev) => {
        const d = decodeWs(ev);
        if (d?.name === "quote") got.push((d.payload as { ts: number }).ts);
      };
      ctl(ws, "subscribe", { topic: "burst" });
      return { ws, got };
    };
    const s1 = await mk();
    const s2 = await mk();
    const s3 = await mk(); // the one that dies mid-burst
    // topics() flips true on the FIRST join — gate instead on processed
    // control frames so every subscribe is guaranteed handled before publishing
    await waitFor(() => server.getMetrics().inboundControl >= 3);
    expect(server.topics()).toEqual(["burst"]);

    server.publishToTopic("burst", "quote", quote("AAPL", { ts: 0 }));
    await waitFor(() => s1.got.length >= 1 && s2.got.length >= 1 && s3.got.length >= 1);

    s3.ws.close(); // die between membership check and further sends
    for (let i = 1; i <= 200; i++) {
      server.publishToTopic("burst", "quote", quote("AAPL", { ts: i }));
      if (i === 50) await Bun.sleep(20); // let the close land mid-stream
    }
    await waitFor(() => s1.got.length >= 201 && s2.got.length >= 201);

    expect(s1.got).toEqual(Array.from({ length: 201 }, (_, i) => i)); // every frame, in order
    expect(s2.got).toEqual(Array.from({ length: 201 }, (_, i) => i));
    expect(server.topics()).toEqual(["burst"]); // room survives; only the member left

    s1.ws.close();
    s2.ws.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);
});

describe("client-identity churn", () => {
  test("rapid reconnect cycles with a pinned id converge to a consistent registry", async () => {
    const server = createServer({
      port: 0,
      authenticate: (req) => {
        const token = new URL(req.url).searchParams.get("token");
        return token === "k" ? { id: "pinned-id" } : false;
      },
    });
    const base = `ws://localhost:${server.port}/ws`;

    // NOTE: the upgrade gate rejects a duplicate live id with 409 BEFORE open,
    // so a stale socket can never delete a newer registration — these cycles
    // exercise the close/reopen interleave around that gate.
    for (let cycle = 0; cycle < 10; cycle++) {
      const ws = await openWs(`${base}?token=k`);
      await waitFor(() => server.clientCount === 1);
      expect(server.getClient("pinned-id")?.id).toBe("pinned-id");
      ws.close();
      await waitFor(() => server.clientCount === 0);
    }

    // registry still fully functional afterwards
    const final = await openWs(`${base}?token=k`);
    await waitFor(() => server.clientCount === 1);
    const got: number[] = [];
    final.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d?.name === "quote") got.push((d.payload as { ts: number }).ts);
    };
    server.publishToClient("pinned-id", "quote", quote("AAPL", { ts: 99 }));
    await waitFor(() => got.includes(99));

    // wrong-token auth while the pinned session is live → rejected cleanly
    expect(await tryConnect(`${base}?token=nope`)).toBe(false);
    expect(server.clientCount).toBe(1);

    final.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 15_000);
});

describe("RingBuffer degenerate shapes", () => {
  test("capacity 1 bounded ring keeps exactly the newest element", () => {
    const r = new RingBuffer<string>(1, true);
    r.push("a");
    expect(r.length).toBe(1);
    r.push("b"); // overwrites in place
    expect(r.length).toBe(1);
    expect([...r]).toEqual(["b"]);
    expect(r.shift()).toBe("b");
    expect(r.shift()).toBeUndefined();
    // keep-last-N semantics at N=1 under interleaving
    for (let i = 0; i < 100; i++) r.push(`v${i}`);
    expect([...r]).toEqual([`v99`]);
  });

  test("clear() after heavy wraparound returns the ring to pristine FIFO", () => {
    const r = new RingBuffer<number>(3, true);
    for (let i = 0; i < 50; i++) r.push(i); // head wrapped many times
    expect([...r]).toEqual([47, 48, 49]);
    r.clear();
    expect(r.length).toBe(0);
    expect([...r]).toEqual([]);
    const out: number[] = [];
    for (let i = 0; i < 7; i++) {
      r.push(i);
      if (r.length > 2) out.push(r.shift()!);
    }
    expect(out).toEqual([0, 1, 2, 3, 4]); // FIFO order intact after reuse
    expect([...r]).toEqual([5, 6]);
  });
});

describe("snapshotRequest flood boundedness", () => {
  test("repeated snapshot requests replay at most historySize each; server stays responsive", async () => {
    const server = createServer({ port: 0, replay: { historySize: 8 } });
    const url = `ws://localhost:${server.port}/ws`;
    for (let i = 0; i < 40; i++) server.publishToTopic("snp", "quote", quote("AAPL", { ts: i }));

    const ws = await openWs(url);
    let snapshots = 0;
    ws.onmessage = (ev) => {
      if (decodeWs(ev)?.name === "quote") snapshots++;
    };
    ctl(ws, "subscribe", { topic: "snp" });
    await waitFor(() => snapshots >= 8); // join-replay: last 8 only

    // flood: each request must replay ≤ 8 frames (bounded by the topic ring)
    for (let i = 0; i < 25; i++) ctl(ws, "snapshotRequest", { topic: "snp", fromSeq: 0 });
    await waitFor(() => snapshots >= 8 + 25 * 8);
    await Bun.sleep(120); // drain any excess
    expect(snapshots).toBeLessThanOrEqual(8 + 25 * 8 + 1); // strictly bounded

    // still healthy
    let pongs = 0;
    ws.onmessage = (ev) => {
      const name = decodeWs(ev)?.name;
      if (name === "quote") snapshots++;
      if (name === "pong") pongs++;
    };
    ctl(ws, "ping", { ts: 7 });
    await waitFor(() => pongs >= 1);
    expect(server.clientCount).toBe(1);

    ws.close();
    server.stop();
  }, 15_000);
});

describe("maxMessageSize binary boundary", () => {
  test("frame == limit is accepted; limit+1 closes 1009", async () => {
    const probe = encodeEvent("quote", quote());
    const limit = probe.byteLength;
    const server = createServer({ port: 0, maxMessageSize: limit });
    const url = `ws://localhost:${server.port}/ws`;

    const ws = await openWs(url);
    const got: string[] = [];
    server.on("quote", (p) => got.push((p as { symbol: string }).symbol));
    server.allowInbound("quote");

    ws.send(probe as Uint8Array<ArrayBuffer>); // exactly at the boundary — accepted
    await waitFor(() => got.length >= 1);
    expect(got[0]).toBe("AAPL");

    const big = new Uint8Array(limit + 1);
    big.set(probe);
    let closeCode = 0;
    ws.onclose = (ev) => {
      closeCode = ev.code;
    };
    ws.send(big as Uint8Array<ArrayBuffer>); // one byte over — closed as too big
    await waitFor(() => closeCode === 1009);
    await waitFor(() => server.clientCount === 0);

    server.stop();
  }, 10_000);
});

describe("subscription churn hygiene", () => {
  test("hundreds of subscribe/unsubscribe cycles leave zero phantom rooms", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);

    for (let i = 0; i < 300; i++) {
      ctl(ws, "subscribe", { topic: `churn-${i}` });
      ctl(ws, "unsubscribe", { topic: `churn-${i}` });
    }
    // a few topics kept alive at the end
    ctl(ws, "subscribe", { topic: "kept-a" });
    ctl(ws, "subscribe", { topic: "kept-b" });
    await waitFor(() => server.topics().length === 2);

    expect(server.topics().sort()).toEqual(["kept-a", "kept-b"]);
    expect(server.getMetrics().inboundControl).toBeGreaterThanOrEqual(602);

    ws.close();
    await waitFor(() => server.clientCount === 0);
    expect(server.topics()).toEqual([]); // everything pruned once the client left
    server.stop();
  }, 15_000);
});

describe("shutdown under load", () => {
  test("stop(true) during active publishing neither hangs nor throws", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    await waitFor(() => server.clientCount === 1);

    let published = 0;
    const timer = setInterval(() => {
      server.publish("quote", quote("AAPL", { ts: published++ }));
    }, 1);
    await Bun.sleep(30); // some frames in flight
    clearInterval(timer);

    expect(() => server.stop(true)).not.toThrow();
    await Bun.sleep(50);
    ws.close();
  }, 10_000);

  test("drain() always resolves within its bounded timeout, even with live clients", async () => {
    const server = createServer({ port: 0 });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    await waitFor(() => server.clientCount === 1);
    // idle connected clients do NOT close on their own — drain must still
    // return deterministically at the deadline (never hang), then force-close.
    const t0 = Date.now();
    await server.drain(800);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    await waitFor(() => server.clientCount === 0); // force-stop closed everyone
    ws.close();
  }, 10_000);
});

