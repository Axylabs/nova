/**
 * Dispatch-path A/B: pre-optimization implementations vs current ones.
 *
 * Two metrics, deliberately:
 *   - min-of-N batched ns/op   → best-case CPU cost (JSC FTL hot path)
 *   - long-run ops/sec         → steady-state cost INCLUDING GC: the old
 *     paths allocate per event (snapshot arrays, fresh ctx + closures,
 *     intermediate socket lists). Single-op timing hides that garbage —
 *     JSC's eden allocator makes dead objects "free" until they aren't;
 *     sustained throughput is where the collector bills you.
 *
 * The "old" implementations are faithful replicas of the pre-change code
 * (same invoke() error-isolation wrapper, same snapshot iteration, same
 * per-dispatch context construction).
 *
 *   bun run bench/dispatch.ts            (JIT on)
 *   BUN_JSC_useJIT=0 bun bench/dispatch.ts   (baseline/LLInt only)
 */
import { capturePayload, createEventTrace } from "../src/events/trace";
import { createHandlerRegistry } from "../src/events/registry";

/* ── shared machinery ────────────────────────────────────────────────────── */

/** Error isolation exactly as both old and new registries invoke handlers. */
function invoke(h: (p: unknown, c: unknown) => void | Promise<void>, p: unknown, c: unknown): void {
  try {
    const r = h(p, c);
    if (r && typeof (r as Promise<void>).then === "function") void (r as Promise<void>).catch(() => {});
  } catch {
    // counted upstream
  }
}

interface ApiStub {
  emit(): void;
  emitToGroup(): void;
  emitToUser(): void;
  emitToClient(): void;
  emitToTopic(): void;
}
const api: ApiStub = {
  emit() {},
  emitToGroup() {},
  emitToUser() {},
  emitToClient() {},
  emitToTopic() {},
};

/* ── OLD: Set registry + snapshot iteration + fresh ctx per dispatch ─────── */

function oldHub() {
  const handlers = new Map<string, Set<(p: unknown, c: unknown) => void>>();
  const anyHandlers = new Set<(n: string, p: unknown, c: unknown) => void>();
  let work = 0;
  {
    const s = new Set<(p: unknown, c: unknown) => void>();
    s.add((_, __) => void work++);
    s.add((_, __) => void work++);
    s.add((_, __) => void work++);
    handlers.set("trade", s);
  }
  anyHandlers.add((_n, _p, _c) => void work++);
  return {
    dispatch(name: string, payload: unknown): number {
      // OLD makeCtx — a fresh object + six closures EVERY dispatch
      const ctx = {
        source: "client",
        hub: api,
        server: api,
        emit: () => api.emit(),
        emitToGroup: () => api.emitToGroup(),
        emitToUser: () => api.emitToUser(),
        emitToClient: () => api.emitToClient(),
        emitToTopic: () => api.emitToTopic(),
      };
      const set = handlers.get(name);
      if (set) {
        const snapshot = [...set];
        for (let i = 0; i < snapshot.length; i++) {
          const h = snapshot[i];
          if (h !== undefined) invoke(h, payload, ctx);
        }
      }
      if (anyHandlers.size > 0) {
        const snapshot = [...anyHandlers];
        for (let i = 0; i < snapshot.length; i++) {
          const h = snapshot[i];
          if (h !== undefined)
            invoke(
              (p2) => {
                h(name, p2, ctx);
              },
              payload,
              ctx,
            );
        }
      }
      return work;
    },
  };
}

/* ── NEW: COW registry + cached ctx ─────────────────────────────────────── */

function newHub() {
  const reg = createHandlerRegistry();
  let work = 0;
  const h = (): void => {
    work++;
  };
  reg.on("trade", h);
  reg.on("trade", h);
  reg.on("trade", h);
  reg.onAny(() => void work++);
  // NEW hub behavior: one ctx per client record, built once (WeakMap hit),
  // plus one shared client-less ctx per source.
  const ctxCache = new WeakMap<object, unknown>();
  const client = { id: "c-1" };
  const buildCtx = (): unknown => ({ source: "client", hub: api, server: api });
  return {
    warmCtx(): void {
      if (!ctxCache.has(client)) ctxCache.set(client, buildCtx());
    },
    dispatch(name: string, payload: unknown): number {
      let ctx = ctxCache.get(client);
      if (ctx === undefined) {
        ctx = buildCtx();
        ctxCache.set(client, ctx);
      }
      reg.dispatch(name, payload, ctx);
      return work;
    },
  };
}

/* ── user-targeted delivery bookkeeping ─────────────────────────────────── */

interface FakeWs {
  sent: number;
}
const byId = new Map<number, FakeWs>();
for (let i = 0; i < 10_000; i++) byId.set(i, { sent: 0 });
const userIds = new Map<string, number[]>([["u-1", [5, 100, 900, 8000]]]);

function oldDeliver(uid: string): number {
  const ids = userIds.get(uid);
  if (!ids) return 0;
  const list: FakeWs[] = [];
  for (const id of ids) {
    const ws = byId.get(id);
    if (ws) list.push(ws);
  }
  for (const ws of list) ws.sent++;
  return list.length;
}

function newDeliver(uid: string): number {
  const ids = userIds.get(uid);
  if (ids === undefined || ids.length === 0) return 0;
  let n = 0;
  for (const id of ids) {
    const ws = byId.get(id);
    if (ws !== undefined) {
      ws.sent++;
      n++;
    }
  }
  return n;
}

/* ── measurement ─────────────────────────────────────────────────────────── */

/** Min-of-N batched single-op latency (best case, timer-noise-free). */
function minNsPerOp(batch: number, rounds: number, fn: () => void): number {
  for (let i = 0; i < batch * 4; i++) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) fn();
    const dt = Number(process.hrtime.bigint() - t0) / batch;
    if (dt < best) best = dt;
  }
  return best;
}

/**
 * Sustained throughput over a fixed window (GC included): this is where
 * per-event garbage actually costs — the collector runs INSIDE the window.
 */
function sustainedOpsPerSec(ms: number, fn: () => void): { opsPerSec: number } {
  Bun.gc(true);
  const t0 = process.hrtime.bigint();
  const deadline = t0 + BigInt(Math.floor(ms * 1e6));
  let ops = 0;
  let now = t0;
  while (now < deadline) {
    for (let i = 0; i < 10_000; i++) fn();
    ops += 10_000;
    now = process.hrtime.bigint();
  }
  const sec = Number(now - t0) / 1e9;
  return { opsPerSec: ops / sec };
}

const fmt = (x: number, unit: string): string => {
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M ${unit}`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k ${unit}`;
  return `${x.toFixed(1)} ${unit}`;
};

function report(label: string, oldFn: () => void, newFn: () => void, warmNew?: () => void): void {
  warmNew?.();
  const oldMin = minNsPerOp(500, 300, oldFn);
  const newMin = minNsPerOp(500, 300, newFn);
  const oldSus = sustainedOpsPerSec(400, oldFn);
  const newSus = sustainedOpsPerSec(400, newFn);
  const susGain = ((newSus.opsPerSec - oldSus.opsPerSec) / oldSus.opsPerSec) * 100;
  console.log(`${label}`);
  console.log(
    `   min/op   old ${oldMin.toFixed(1)} ns · new ${newMin.toFixed(1)} ns (${(oldMin / newMin).toFixed(2)}× faster best-case)`,
  );
  console.log(
    `   sustained old ${fmt(oldSus.opsPerSec, "ops/s")} · new ${fmt(newSus.opsPerSec, "ops/s")} (${susGain >= 0 ? "+" : ""}${susGain.toFixed(1)}% incl. GC)`,
  );
}

console.log(`dispatch-path A/B — pid ${process.pid}, bun ${Bun.version}`);
if (process.env.BUN_JSC_useJIT === "0") console.log("(JSC JIT disabled — baseline/LLInt only)");
console.log("");

report(
  "1. inbound dispatch (3 handlers + onAny)",
  (() => {
    const h = oldHub();
    return (): number => h.dispatch("trade", { symbol: "MSFT" });
  })(),
  (() => {
    const h = newHub();
    h.warmCtx();
    return (): number => h.dispatch("trade", { symbol: "MSFT" });
  })(),
);

report(
  "2. user-targeted delivery bookkeeping (4 sockets / 10k clients)",
  () => oldDeliver("u-1"),
  () => newDeliver("u-1"),
);

{
  const traceOn = createEventTrace({ capacity: 4096 });
  const traceOff = createEventTrace({ enabled: false });
  const recOn = (): void => traceOn.record("out.emit", "quote", "user", "u-1", 64);
  const recOff = (): void => traceOff.record("out.emit", "quote", "user", "u-1", 64);
  console.log(`3. event-trace record (added visibility, its own cost)`);
  console.log(`   min/op   on ${(minNsPerOp(500, 300, recOn)).toFixed(1)} ns · off ${(minNsPerOp(500, 300, recOff)).toFixed(1)} ns`);
  console.log(`   sustained on ${fmt(sustainedOpsPerSec(400, recOn).opsPerSec, "rec/s")}`);
}

{
  const payload = { symbol: "AAPL", bid: 1, ask: 2, bidSize: 3, askSize: 4, ts: 1 };
  console.log(`4. payload preview capture (opt-in): ${(minNsPerOp(200, 200, () => capturePayload(payload, 2000))).toFixed(1)} ns/event — off by default`);
}
