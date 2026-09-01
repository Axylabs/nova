/**
 * Efficiency tests — allocation discipline, buffer-reuse invariants, and
 * bounded-memory guarantees that the functional perf floors can't pin down:
 *
 *   - zero-alloc steady-state encode (heap growth ≈ 0 after GC)
 *   - scratch capacity is reused (grow-to-peak, never thrash/shrink)
 *   - replay history + backpressure queue hold OWNED copies (a later encode
 *     that overwrites the shared scratch must never corrupt retained frames)
 *   - NATS bridge publishes copies, never the live scratch view
 *   - bounded retention: replay ring holds ≤ historySize; slow-socket queue
 *     holds ≤ maxQueue even under a sustained flood
 *   - task queue: exact processing, drop-newest accounting, event-driven
 *     wake latency, idle park (no work executed while idle)
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createNatsBridge, type NatsTransport } from "../src/bridge/nats";
import { RingBuffer } from "../src/core/ring";
import { sendFrame } from "../src/core/outbound";
import { createMetrics } from "../src/core/metrics";
import { createTaskQueue } from "../src/events/queue";
import { decodeFrame } from "../src/generated/registry";
import { createServer } from "../public/server";
import type { ServerState } from "../src/core/state";
import { openWs, quote, waitFor } from "./helpers";
import { encodeEvent, encodeToScratch } from "../src/transport/transport";

describe("encode allocation discipline", () => {
  test("steady-state direct-path encode allocates ~nothing after GC", () => {
    const p = quote("ALLOC");
    for (let i = 0; i < 20_000; i++) encodeToScratch("quote", p); // warm + grow to steady state
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const N = 100_000;
    let sink = 0;
    for (let i = 0; i < N; i++) {
      // subarray view only — the loop must not retain anything per call
      sink += encodeToScratch("quote", p).byteLength;
    }
    Bun.gc(true);
    const delta = process.memoryUsage().heapUsed - before;
    expect(sink).toBeGreaterThan(0); // keep the loop from being optimized away
    // 100k encodes of a ~60B frame would be ~6MB if the payload were copied.
    // JIT/JSC variance tolerated, but payload-sized garbage must not exist.
    expect(delta).toBeLessThan(4 * 1024 * 1024);
  });

  test("scratch capacity grows to peak and is REUSED (no shrink/thrash)", () => {
    const small = quote("S");
    const big = {
      accountId: "BIG",
      positions: Array.from({ length: 200 }, (_, i) => ({
        symbol: `SYM-${i}`,
        quantity: i,
        avgPrice: 1.5,
        pnl: 0.5,
      })),
      totalValue: 1,
      cash: 2,
      ts: 3,
      updatedBy: "bench",
    };
    encodeToScratch("quote", small);
    const peak = encodeToScratch("portfolio", big).buffer.byteLength;
    expect(peak).toBeGreaterThan(4096);
    // subsequent small encodes reuse the SAME backing buffer — capacity stays
    for (let i = 0; i < 100; i++) {
      const view = encodeToScratch("quote", small);
      expect(view.buffer.byteLength).toBeGreaterThanOrEqual(peak);
    }
    // re-growing to a bigger need still works and stays stable afterwards
    const bigger = encodeToScratch("portfolio", {
      ...big,
      positions: Array.from({ length: 400 }, (_, i) => ({
        symbol: `SYM-${i}`,
        quantity: i,
        avgPrice: 1.5,
        pnl: 0.5,
      })),
    });
    expect(bigger.byteLength).toBeGreaterThan(0);
    expect(encodeToScratch("quote", small).buffer.byteLength).toBeGreaterThanOrEqual(
      bigger.buffer.byteLength,
    );
  });
});

describe("retained frames are owned copies (scratch-aliasing net)", () => {
  test("replay history survives later encodes overwriting the scratch", async () => {
    const server = createServer({ port: 0, replay: { historySize: 8 } });
    const url = `ws://localhost:${server.port}/ws`;

    const q1 = quote("FIRST", { bid: 111 });
    const q2 = quote("SECOND", { bid: 222 });
    server.publishToTopic("room", "quote", q1); // recorded → scratch reused below
    server.publishToTopic("room", "quote", q2);

    // a subscriber joining NOW replays both frames — each must decode to its
    // own payload (if history stored scratch views, both would read SECOND)
    const ws = await openWs(url);
    const seen: unknown[] = [];
    ws.onmessage = (ev) => {
      const f = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
      if (f && !f.name.startsWith("hello") && f.name === "quote") seen.push(f.payload);
    };
    ws.send(encodeEvent("subscribe", { topic: "room" }) as Uint8Array<ArrayBuffer>);
    await waitFor(() => seen.length >= 2);

    const first = seen[0] as { symbol: string };
    const second = seen[1] as { symbol: string };
    expect(first.symbol).toBe("FIRST");
    expect(second.symbol).toBe("SECOND");

    ws.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);

  test("NATS bridge publish copies the frame — later scratch writes don't leak in", () => {
    const captured: Uint8Array[] = [];
    const fake: NatsTransport = {
      connected: true,
      publish: (_subject, data) => captured.push(data),
      subscribe: () => () => {},
      close: async () => {},
    };
    const bridge = createNatsBridge({}, fake);
    const backing = new Uint8Array(64);
    const view = backing.subarray(0, 16);

    bridge.publish("s.a", view);
    view.fill(0xff); // mutate the source AFTER publishing (scratch reuse analog)
    bridge.publish("s.b", view.subarray(0, 16));

    expect(captured[0] !== captured[1]).toBe(true);
    expect(captured[0]!.some((b) => b === 0xff)).toBe(false); // first copy untouched
    expect(captured[1]!.every((b) => b === 0xff)).toBe(true); // second copied post-mutation
    bridge.close();
  });

  test("end-to-end: bridged broadcasts stay byte-exact across consecutive publishes", async () => {
    const captured: Uint8Array[] = [];
    const fake: NatsTransport = {
      connected: true,
      publish: (_subject, data) => captured.push(data),
      subscribe: () => () => {},
      close: async () => {},
    };
    const server = createServer({ port: 0, nats: createNatsBridge({}, fake) });
    const payloads = [
      quote("BRIDGE-A"),
      quote("BRIDGE-B"),
      quote("BRIDGE-C"),
    ];
    for (const p of payloads) server.publish("quote", p);
    await Bun.sleep(50);

    expect(captured.length).toBe(payloads.length);
    captured.forEach((frame, i) => {
      const dec = decodeFrame(frame);
      expect(dec?.name).toBe("quote");
      expect((dec!.payload as { symbol: string }).symbol).toBe(payloads[i]!.symbol);
    });
    server.stop();
  }, 10_000);
});

describe("bounded retention under flood", () => {
  test("slow-socket drop-oldest queue never exceeds maxQueue", () => {
    // drive outbound.sendFrame directly with a saturated fake socket
    const state = {
      bp: { highWaterMark: 1, policy: "drop-oldest" as const, maxQueue: 32 },
      metrics: createMetrics(),
    } as unknown as ServerState;
    const sent: Uint8Array[] = [];
    const data: { queue?: RingBuffer<Uint8Array> } = {};
    const fakeWs = {
      data,
      getBufferedAmount: () => Number.MAX_SAFE_INTEGER, // permanently saturated
      send: (f: Uint8Array) => sent.push(f),
      close: () => {},
    } as never;

    const frame = encodeEvent("quote", quote("FLOOD"));
    for (let i = 0; i < 10_000; i++) sendFrame(state, fakeWs, frame);

    // every push after capacity drops the oldest head: 10_000 pushed - 32 held
    expect(state.metrics.droppedOldest).toBe(10_000 - 32);
    expect(state.metrics.sent).toBe(0); // saturated socket never got a direct write
    expect(data.queue!.length).toBe(32); // hard-bounded — memory cannot balloon
  });

  test("replay ring retains at most historySize frames per topic", async () => {
    const server = createServer({ port: 0, replay: { historySize: 4 } });
    const url = `ws://localhost:${server.port}/ws`;
    for (let i = 0; i < 500; i++) {
      server.publishToTopic("t", "quote", quote(`V${i}`));
    }
    // a fresh subscriber receives exactly the LAST 4 values, oldest → newest
    const ws = await openWs(url);
    const symbols: string[] = [];
    let settled: (() => void) | undefined;
    const donePromise = new Promise<void>((r) => (settled = r));
    ws.onmessage = (ev) => {
      const f = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
      if (f?.name === "quote") {
        symbols.push((f.payload as { symbol: string }).symbol);
        if (symbols.length === 4) settled?.();
      }
    };
    ws.send(encodeEvent("subscribe", { topic: "t" }) as Uint8Array<ArrayBuffer>);
    await Promise.race([donePromise, Bun.sleep(2000)]);
    expect(symbols).toEqual(["V496", "V497", "V498", "V499"]);

    ws.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);
});

describe("task queue efficiency", () => {
  test("processes every task exactly once with exact accounting", async () => {
    const q = createTaskQueue({ workers: 2, maxPending: 20_000 });
    let ran = 0;
    const inc = (): void => {
      ran++;
    };
    for (let i = 0; i < 10_000; i++) q.enqueue(inc);    await q.drain();
    expect(ran).toBe(10_000);
    expect(q.stats()).toMatchObject({ queued: 10_000, processed: 10_000, dropped: 0, errors: 0 });
    expect(q.pending).toBe(0);
    q.close();
  });

  test("drop-newest over maxPending is counted, never throws", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const q = createTaskQueue({ workers: 1, maxPending: 8 });
    let done = 0;
    const inc = (): void => {
      done++;
    };
    q.enqueue(async () => {
      await gate; // block the single worker
      done++;
    });
    await Bun.sleep(20); // let the worker pick up the blocker
    for (let i = 0; i < 100; i++) q.enqueue(inc); // 92 dropped
    expect(q.stats().dropped).toBe(92);
    expect(q.stats().queued).toBe(9); // blocker + 8 accepted
    release?.();
    await q.drain();
    expect(done).toBe(9);
    q.close();
  });

  test("error isolation: failing tasks are counted + forwarded, queue survives", async () => {
    const errors: Error[] = [];
    const q = createTaskQueue({ workers: 1, onError: (e) => errors.push(e) });
    let ran = 0;
    const inc = (): void => {
      ran++;
    };
    for (let i = 0; i < 50; i++) {
      const shouldThrow = i % 2 === 0;
      const label = `boom-${i}`;
      q.enqueue(() => {
        if (shouldThrow) throw new Error(label);
        inc();
      });
    }
    await q.drain();
    await Bun.sleep(30); // allow async onError forwards
    expect(ran).toBe(25);
    expect(errors.length).toBe(25);
    expect(q.stats().errors).toBe(25);
    // still healthy afterwards
    q.enqueue(() => {
      ran++;
    });
    await q.drain();
    expect(ran).toBe(26);
    q.close();
  });

  test("event-driven wake: parked workers resume promptly (<25ms)", async () => {
    const q = createTaskQueue({ workers: 2 });
    await Bun.sleep(50); // workers now PARKED (idle)
    let ran = false;
    const t0 = performance.now();
    q.enqueue(() => {
      ran = true;
    });
    await q.drain();
    const elapsed = performance.now() - t0;
    expect(ran).toBe(true);
    expect(elapsed).toBeLessThan(25);
    // idle park proof: no further work executes, pending stays zero
    await Bun.sleep(80);
    expect(q.pending).toBe(0);
    expect(q.stats().processed).toBe(1);
    q.close();
  });
});
