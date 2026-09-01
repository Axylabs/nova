/**
 * Event trace — a fixed-capacity, structure-of-arrays ring that records every
 * fired nova event (emitted, published, received) so a debugger can answer
 * "what fired, when, where did it go, how big" without touching the hot path.
 *
 * Design goals (GC pressure ≈ zero):
 *   - ALL scalars live in pre-allocated TypedArrays sized once at creation
 *     (instantiation-time allocation, never per event).
 *   - Strings (event name / target key / captured payload) are stored as
 *     REFERENCES into pre-allocated slot arrays — writing a record moves no
 *     memory and allocates nothing; old strings are reclaimed naturally when
 *     the ring wraps over their slots.
 *   - Row objects are materialized ONLY on read (`recent` / `stats`) — the
 *     debugger's poll pays the allocation, the event loop never does.
 *
 * Recording is bounded work: a monotonic seq, six typed-array stores and a
 * couple of reference stores (~tens of ns) — safe to leave ON in development
 * and production alike (`IGNEX_NOVA_TRACE=0` disables it globally).
 */
import type { EmitTargetKind } from "./types";

/** Where a traced event came from / went. Encoded as one byte per record. */
export type TraceDirection =
  | "out.publish" // server API publish* (fan-out to local sockets)
  | "out.emit" // events-layer emit (targeted fan-out)
  | "in.client" // decoded from a local socket frame
  | "in.remote" // cluster sync frame from another instance
  | "in.bridge"; // NATS bridge inbound

/** Numeric encoding (TypedArray storage) for {@link TraceDirection}. */
const DIRS = ["out.publish", "out.emit", "in.client", "in.remote", "in.bridge"] as const;

const DIR_CODES: Record<TraceDirection, number> = {
  "out.publish": 0,
  "out.emit": 1,
  "in.client": 2,
  "in.remote": 3,
  "in.bridge": 4,
};

/** Numeric encoding for {@link EmitTargetKind} (+ none for inbound rows). */
const TARGET_CODES: Record<string, number> = {
  broadcast: 0,
  topic: 1,
  group: 2,
  user: 3,
  client: 4,
};
const TARGET_NAMES = ["broadcast", "topic", "group", "user", "client"] as const;

/** Options — all resolved at creation (instantiation time). */
export interface EventTraceOptions {
  /** Ring capacity in records. Default 1024 (≈ a few hundred KB total). */
  capacity?: number;
  /** Master switch. Default true unless `IGNEX_NOVA_TRACE=0`. */
  enabled?: boolean;
  /**
   * Capture a truncated JSON preview of the payload per record. Default 0
   * (off) — capture costs a stringify per recorded event.
   */
  capturePayloadChars?: number;
}

/** One materialized trace row (allocated on read, never on write). */
export interface EventTraceRow {
  /** monotonic sequence (ring-global ordering) */
  seq: number;
  /** epoch ms when the event was recorded */
  ts: number;
  direction: TraceDirection;
  /** wire event name ("quote.tick", "subscribe", …) */
  name: string;
  /** emit target kind (absent for plain inbound rows) */
  target?: EmitTargetKind;
  /** topic / group / userId / clientId the event was addressed to */
  key?: string;
  /** encoded frame size in bytes (0 for rows without a frame) */
  bytes: number;
  /** truncated JSON payload preview (only when capture is enabled) */
  payload?: string;
}

/** Aggregate counters over the records currently retained by the ring. */
export interface EventTraceStats {
  enabled: boolean;
  capacity: number;
  /** records retained (≤ capacity; full once the ring has wrapped) */
  size: number;
  /** total records written since creation (incl. overwritten ones) */
  total: number;
  inCount: number;
  outCount: number;
  bytes: number;
  /** per-event counts over the retained window (name → n) */
  byName: Record<string, number>;
  /** last recorded event (name + ts) for at-a-glance panels */
  last: { name: string; ts: number } | null;
}

/** Filter + limit options shared by `recent()` and server-level getters. */
export interface TraceQueryOptions {
  /** max rows (default 100, capped by capacity) */
  limit?: number;
  /** keep only this direction */
  direction?: TraceDirection;
  /** keep only this wire event name */
  name?: string;
}

/** The trace surface owned by a server's state (created once per server). */
export interface EventTrace {
  readonly enabled: boolean;
  readonly capacity: number;
  /** true when payload previews are being captured (call sites stringify then) */
  readonly captures: boolean;
  /**
   * Record one event. Allocation-free: scalars go into TypedArrays, strings
   * are held by reference in reused slots. `payloadText` (pre-truncated JSON)
   * is stored only when capture is enabled.
   */
  record(
    direction: TraceDirection,
    name: string,
    target: EmitTargetKind | undefined,
    key: string | undefined,
    bytes: number,
    payloadText?: string,
  ): void;
  /** Materialize up to `limit` rows, newest first, optionally filtered. */
  recent(options?: TraceQueryOptions): EventTraceRow[];
  /** Aggregate over the retained window (computed on read). */
  stats(): EventTraceStats;
  /** Drop every retained record (counters survive). */
  clear(): void;
}

/** True unless explicitly disabled (`IGNEX_NOVA_TRACE=0`). */
export const traceEnabledDefault = (): boolean => process.env.IGNEX_NOVA_TRACE !== "0";

/** Truncate-and-stringify used by call sites when capture is enabled. */
export const capturePayload = (payload: unknown, maxChars: number): string => {
  try {
    const text = JSON.stringify(payload) ?? String(payload);
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return "[unserializable]";
  }
};

export function createEventTrace(options: EventTraceOptions = {}): EventTrace {
  const enabled = options.enabled ?? traceEnabledDefault();
  const capacity = Math.max(1, options.capacity ?? 1024);
  const captureChars = Math.max(0, options.capturePayloadChars ?? 0);

  // ── pre-allocated storage (the only allocation this module ever makes) ──
  const seqArr = new Float64Array(capacity); // seq can exceed 2^31 safely
  const tsArr = new Float64Array(capacity);
  const dirArr = new Uint8Array(capacity);
  const targetArr = new Uint8Array(capacity); // 255 = none
  const bytesArr = new Int32Array(capacity);
  const nameSlots: Array<string | undefined> = Array.from({ length: capacity });
  const keySlots: Array<string | undefined> = Array.from({ length: capacity });
  const payloadSlots: Array<string | undefined> =
    captureChars > 0 ? Array.from({ length: capacity }) : [];

  let head = 0; // next slot to overwrite
  let size = 0; // records retained (≤ capacity)
  let totalWritten = 0;
  let totalBytes = 0;
  let lastSeq = 0;

  return {
    enabled,
    capacity,
    captures: captureChars > 0,

    record(direction, name, target, key, bytes, payloadText) {
      if (!enabled) return;
      const i = head;
      seqArr[i] = ++lastSeq;
      tsArr[i] = Date.now();
      dirArr[i] = DIR_CODES[direction];
      targetArr[i] = target === undefined ? 255 : (TARGET_CODES[target] ?? 255);
      bytesArr[i] = bytes;
      nameSlots[i] = name;
      keySlots[i] = key;
      if (captureChars > 0 && payloadText !== undefined) payloadSlots[i] = payloadText;
      head = i + 1 === capacity ? 0 : i + 1;
      if (size < capacity) size++;
      totalWritten++;
      totalBytes += bytes;
    },

    recent(options = {}) {
      if (!enabled || size === 0) return [];
      const limit = Math.max(0, Math.min(options.limit ?? 100, size));
      const dirFilter = options.direction !== undefined ? DIR_CODES[options.direction] : -1;
      const nameFilter = options.name;
      const out: EventTraceRow[] = [];
      // walk backwards from the newest slot (head - 1), wrapping as needed
      let i = head === 0 ? capacity - 1 : head - 1;
      for (let seen = 0; seen < size && out.length < limit; seen++) {
        const dir = dirArr[i] ?? 255;
        const name = nameSlots[i];
        if (
          (dirFilter < 0 || dir === dirFilter) &&
          (nameFilter === undefined || name === nameFilter)
        ) {
          const targetCode = targetArr[i] ?? 255;
          const row: EventTraceRow = {
            seq: seqArr[i] ?? 0,
            ts: tsArr[i] ?? 0,
            direction: DIRS[dir] ?? "out.publish",
            name: name ?? "?",
            bytes: bytesArr[i] ?? 0,
          };
          if (targetCode !== 255) {
            const t = TARGET_NAMES[targetCode];
            if (t !== undefined) row.target = t;
          }
          const key = keySlots[i];
          if (key !== undefined) row.key = key;
          if (captureChars > 0) {
            const p = payloadSlots[i];
            if (p !== undefined) row.payload = p;
          }
          out.push(row);
        }
        i = i === 0 ? capacity - 1 : i - 1;
      }
      return out;
    },

    stats() {
      const byName: Record<string, number> = {};
      let inCount = 0;
      let outCount = 0;
      let windowBytes = 0;
      let lastName: string | undefined;
      let lastTs = 0;
      let newestSeq = -1;
      if (enabled) {
        let i = head === 0 ? capacity - 1 : head - 1;
        for (let seen = 0; seen < size; seen++) {
          const name = nameSlots[i];
          const seq = seqArr[i] ?? 0;
          if (name !== undefined) {
            byName[name] = (byName[name] ?? 0) + 1;
            if (seq > newestSeq) {
              newestSeq = seq;
              lastName = name;
              lastTs = tsArr[i] ?? 0;
            }
          }
          const dir = dirArr[i] ?? 255;
          if (dir <= 1) outCount++;
          else inCount++;
          windowBytes += bytesArr[i] ?? 0;
          i = i === 0 ? capacity - 1 : i - 1;
        }
      }
      return {
        enabled,
        capacity,
        size: enabled ? size : 0,
        total: totalWritten,
        inCount,
        outCount,
        bytes: windowBytes,
        byName,
        ...(lastName !== undefined ? { last: { name: lastName, ts: lastTs } } : { last: null }),
      };
    },

    clear() {
      head = 0;
      size = 0;
      nameSlots.fill(undefined);
      keySlots.fill(undefined);
      if (captureChars > 0) payloadSlots.fill(undefined);
    },
  };
}
