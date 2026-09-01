/**
 * Performance regression guards (generous floors — CI-safe, regression-sensitive).
 *
 * These are NOT microbenchmarks (see `bench/` + `bench/BASELINE.md` for the
 * calibrated gates); they pin ORDERS OF MAGNITUDE so a pathological
 * regression (accidental O(n²), per-frame allocation, sync IO on the hot
 * path) fails loudly in `bun test` instead of waiting for a bench run:
 *
 *   - encode throughput floor (Rust FFI direct path)
 *   - decode throughput floor (flatc unpack path)
 *   - end-to-end broadcast fan-out over real WebSockets
 *   - event-trace record cost (debugger visibility must stay ~free)
 *   - RingBuffer O(1) vs Array.shift O(n) at queue depth
 *   - rate-limiter hot-path cost (per-frame security tax)
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { createEventTrace } from "../src/events/trace";
import { RingBuffer } from "../src/core/ring";
import { createRateLimiter, resolveRateLimit } from "../src/core/rate-limit";
import { decodeFrame } from "../src/generated/registry";
import { encodeEvent, encodeToScratch } from "../src/transport/transport";
import { openWs, quote } from "./helpers";

/** Median-of-3 wall-clock ms for `fn` (simple JIT-noise damping). */
function timeMs(fn: () => void): number {
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    runs.push(performance.now() - t0);
  }
  return runs.sort((a, b) => a - b)[1]!;
}

describe("encode / decode throughput floors", () => {
  test("direct-path encode sustains >200k msg/s (baseline ≈4M)", () => {
    const p = quote("PERF");
    for (let i = 0; i < 5_000; i++) encodeToScratch("quote", p); // warm tiering
    const N = 50_000;
    const ms = timeMs(() => {
      for (let i = 0; i < N; i++) encodeToScratch("quote", p);
    });
    const ops = (N / ms) * 1000;
    expect(ops).toBeGreaterThan(200_000);
  });

  test("decode sustains >100k frames/s", () => {
    const frame = encodeEvent("quote", quote("PERF")).slice();
    for (let i = 0; i < 2_000; i++) decodeFrame(frame);
    const N = 20_000;
    const ms = timeMs(() => {
      for (let i = 0; i < N; i++) decodeFrame(frame);
    });
    const ops = (N / ms) * 1000;
    expect(ops).toBeGreaterThan(100_000);
  });

  test("packed-vector events sustain >50k msg/s through the direct path", () => {
    const payload = {
      accountId: "perf",
      positions: Array.from({ length: 10 }, (_, i) => ({
        symbol: `S${i}`,
        quantity: i,
        avgPrice: 10 + i,
        pnl: 1.5 * i,
      })),
      totalValue: 100,
      cash: 10,
      ts: Date.now(),
      updatedBy: "bench",
    };
    for (let i = 0; i < 1_000; i++) encodeToScratch("portfolio", payload);
    const N = 10_000;
    const ms = timeMs(() => {
      for (let i = 0; i < N; i++) encodeToScratch("portfolio", payload);
    });
    expect((N / ms) * 1000).toBeGreaterThan(50_000);
  });
});

describe("broadcast fan-out (real sockets)", () => {
  test("8 subscribers × 2,000 broadcasts deliver promptly and completely", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const N_CLIENTS = 8;
    const M = 2_000;

    const received: number[] = Array.from({ length: N_CLIENTS }, () => 0);
    const sockets: WebSocket[] = [];
    const done: Promise<void>[] = [];

    for (let c = 0; c < N_CLIENTS; c++) {
      const ws = await openWs(url);
      sockets.push(ws);
      done.push(
        new Promise<void>((resolve) => {
          // hello/welcome arrive first; count only the M app frames after them
          let n = 0;
          ws.onmessage = () => {
            n++;
            if (n > 2) received[c] = n - 2;
            if (n === M + 2) resolve();
          };
        }),
      );
    }

    const t0 = performance.now();
    const payload = quote("FAN");
    for (let i = 0; i < M; i++) server.publish("quote", payload);
    await Promise.all(done);
    const elapsed = performance.now() - t0;

    for (const r of received) expect(r).toBe(M);
    // 16k frame deliveries — floor is extremely generous (< 3s); the baseline
    // does this in well under a second.
    expect(elapsed).toBeLessThan(3_000);

    for (const ws of sockets) ws.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 15_000);
});

describe("trace record cost", () => {
  test("100k records complete in <250ms (baseline ≈43ns/rec)", () => {
    const trace = createEventTrace({ capacity: 1024 });
    const ms = timeMs(() => {
      for (let i = 0; i < 100_000; i++) trace.record("out.publish", "quote", "broadcast", undefined, 64);
    });
    expect(ms).toBeLessThan(250);
    // timeMs runs the batch 3× — every record must have landed in the ring
    expect(trace.stats().total).toBe(300_000);
  });

  test("disabled trace is near-free (<50ms per 100k)", () => {
    const trace = createEventTrace({ capacity: 1024, enabled: false });
    const ms = timeMs(() => {
      for (let i = 0; i < 100_000; i++) trace.record("out.publish", "quote", undefined, undefined, 64);
    });
    expect(ms).toBeLessThan(50);
  });
});

describe("RingBuffer stays O(1) under depth", () => {
  test("ring push+shift beats Array.shift memmove at depth 4096", () => {
    const DEPTH = 4096;
    const OPS = 8192;

    const ring = new RingBuffer<number>(64);
    for (let i = 0; i < DEPTH; i++) ring.push(i);
    const array: number[] = [];
    for (let i = 0; i < DEPTH; i++) array.push(i);

    const ringMs = timeMs(() => {
      for (let i = 0; i < OPS; i++) {
        ring.push(i);
        ring.shift();
      }
    });
    const arrayMs = timeMs(() => {
      for (let i = 0; i < OPS; i++) {
        array.push(i);
        array.shift();
      }
    });
    // both hold depth constant; the ring must not pay the O(n) memmove tax
    expect(ringMs).toBeLessThan(arrayMs);
  }, 20_000);
});

describe("rate limiter overhead", () => {
  test("allow() costs are negligible (>1M checks/s)", () => {
    const rl = resolveRateLimit({ messagesPerSecond: 1_000_000, burst: 1_000_000 })!;
    const limiter = createRateLimiter(rl);
    let now = 0;
    let ok = 0;
    const ms = timeMs(() => {
      for (let i = 0; i < 500_000; i++) {
        now += 0.001; // sub-refill steps, exercises the consume branch
        if (limiter.allow(now)) ok++;
      }
    });
    expect(ok).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});

// local helper (avoids importing waitFor into a perf-only file)
function waitFor(fn: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (fn()) return resolve();
      setTimeout(tick, 5);
    };
    tick();
  });
}
