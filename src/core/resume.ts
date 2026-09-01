/**
 * Delivery-sequence + resume — gap-free delivery over the WS transport.
 *
 * Every frame the SERVER writes to a socket carries a per-connection,
 * monotonically increasing delivery seq (envelope v2 `[flags:1][seq:u64 LE]`,
 * stamped in place just before `ws.send` — Bun copies synchronously). Clients
 * track the seq stream and detect loss (backpressure drops, reconnect
 * boundaries) as gaps.
 *
 * Recovery has two halves:
 *   - SAME-connection gaps → client sends the `resume` control frame with its
 *     last contiguous seq; the server replays from the connection's bounded
 *     sent-history ring (`ws.data.history`), frames keeping their ORIGINAL
 *     seqs so the client's stream stays gap-free and duplicate-free.
 *   - RECONNECT → on close the ring + counter move to a per-client-id
 *     "graveyard" (bounded, TTL'd). A reconnecting socket whose auth-pinned id
 *     has a grave adopts it, so `hello { lastSeq }` resumes across sessions.
 *
 * The stamping helpers derive offsets from `bindings.wireHeaderLen`, so v1
 * bindings (header 5, no seq field) simply never stamp and never resume.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings } from "../bindings/types";
import { RingBuffer } from "./ring";
import type { ServerState, WsData } from "./state";

/** One entry of a connection's sent-frame history (frame is an owned copy). */
export interface SentFrame {
  seq: number;
  frame: Uint8Array;
}

const FLAGS_OFFSET_BACK = 9; // [..][flags:1][seq:u64 LE] tail of the header
const SEQ_OFFSET_BACK = 8;

/**
 * Stamp `seq` into `frame`'s delivery header IN PLACE (flags bit0 = 1).
 * Callers must own or exclusively borrow the buffer at this instant:
 * `ws.send` copies synchronously, and queued/replayed frames are stamped
 * before their owned copy is taken. Returns false when the bindings have no
 * delivery header (v1) — callers then skip resume bookkeeping.
 */
export function stampSeq(bindings: Bindings, frame: Uint8Array, seq: number): boolean {
  const len = bindings.wireHeaderLen;
  if (len < FLAGS_OFFSET_BACK + 1 || frame.byteLength < len) return false;
  frame[len - FLAGS_OFFSET_BACK] = (frame[len - FLAGS_OFFSET_BACK] ?? 0) | 1;
  // u64 LE via two u32 halves — no BigInt/DataView allocation per frame
  // (this runs once per app frame PER SOCKET on the fan-out loop)
  const off = len - SEQ_OFFSET_BACK;
  const lo = seq % 0x100000000;
  const hi = Math.floor(seq / 0x100000000);
  frame[off] = lo & 0xff;
  frame[off + 1] = (lo >>> 8) & 0xff;
  frame[off + 2] = (lo >>> 16) & 0xff;
  frame[off + 3] = (lo >>> 24) & 0xff;
  frame[off + 4] = hi & 0xff;
  frame[off + 5] = (hi >>> 8) & 0xff;
  frame[off + 6] = (hi >>> 16) & 0xff;
  frame[off + 7] = (hi >>> 24) & 0xff;
  return true;
}

/** Read a frame's delivery seq; null when unstamped / not present. */
export function readSeq(bindings: Bindings, frame: Uint8Array): number | null {
  const len = bindings.wireHeaderLen;
  if (len < FLAGS_OFFSET_BACK + 1 || frame.byteLength < len) return null;
  if ((frame[len - FLAGS_OFFSET_BACK]! & 1) === 0) return null;
  const off = len - SEQ_OFFSET_BACK;
  const lo =
    frame[off]! | (frame[off + 1]! << 8) | (frame[off + 2]! << 16) | (frame[off + 3]! << 24);
  const hi =
    frame[off + 4]! | (frame[off + 5]! << 8) | (frame[off + 6]! << 16) | (frame[off + 7]! << 24);
  return (lo >>> 0) + hi * 0x100000000;
}

/** Lazily create the per-connection sent-history ring (resume enabled only). */
export function ensureHistory(state: ServerState, ws: ServerWebSocket<WsData>): RingBuffer<SentFrame> | undefined {
  if (!state.resume) return undefined;
  let h = ws.data.history;
  if (h === undefined) {
    h = new RingBuffer<SentFrame>(state.resume.historySize, true);
    ws.data.history = h;
  }
  return h;
}

/**
 * Record a stamped frame in the connection's history (owned copy — the caller
 * may be handing a reused scratch view to `ws.send`). No-op when resume is off
 * or the frame could not be stamped.
 */
export function recordSent(
  _state: ServerState,
  ws: ServerWebSocket<WsData>,
  frame: Uint8Array,
  seq: number,
): void {
  const h = ws.data.history;
  if (!h) return;
  h.push({ seq, frame: frame.slice() });
}

// ── graveyard (cross-connection resume) ─────────────────────────────────────

const GRAVE_MAX = 1000;

function pruneGraves(state: ServerState): void {
  const now = Date.now();
  for (const [id, g] of state.graves) {
    if (g.expiresAt <= now) state.graves.delete(id);
  }
}

/**
 * On disconnect (resume enabled): park the connection's history under its
 * client id so a future session can adopt it. Bounded: beyond `GRAVE_MAX`
 * entries (or past TTL) the OLDEST grave is dropped first.
 */
export function burySession(state: ServerState, ws: ServerWebSocket<WsData>): void {
  const ttlMs = state.resume?.ttlMs ?? 0;
  const history = ws.data.history;
  if (!state.resume || !history || history.length === 0) return;
  pruneGraves(state);
  if (state.graves.size >= GRAVE_MAX) {
    // drop the soonest-expiring grave (Map preserves insertion order)
    const oldest = state.graves.keys().next();
    if (!oldest.done) state.graves.delete(oldest.value);
  }
  state.graves.set(ws.data.id, {
    history,
    nextSeq: ws.data.sendSeq,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * On open (resume enabled): adopt a parked history for this client id, if any.
 * Returns true when the connection now continues a previous seq stream.
 */
export function adoptGrave(state: ServerState, ws: ServerWebSocket<WsData>): boolean {
  if (!state.resume) return false;
  const g = state.graves.get(ws.data.id);
  if (!g) return false;
  if (g.expiresAt <= Date.now()) {
    state.graves.delete(ws.data.id);
    return false;
  }
  state.graves.delete(ws.data.id);
  ws.data.history = g.history;
  ws.data.sendSeq = g.nextSeq;
  return true;
}

/**
 * Replay every retained frame strictly after `lastSeq` to `ws` (original seqs
 * preserved). Returns `{ ok, replayed, from }`; `ok=false` means the requested
 * hole is older than the ring (partial recovery — the client should
 * resubscribe topics for a fresh snapshot).
 */
export function replayAfter(
  _state: ServerState,
  ws: ServerWebSocket<WsData>,
  lastSeq: number,
): { ok: boolean; replayed: number; from: number } {
  const h = ws.data.history;
  if (!h || h.length === 0) return { ok: false, replayed: 0, from: 0 };
  let ok = true;
  let replayed = 0;
  let from = 0;
  for (const e of h) {
    if (e.seq <= lastSeq) continue;
    if (from === 0) from = e.seq;
    // a hole before/at the oldest retained frame cannot be filled
    if (e.seq !== lastSeq + replayed + 1) ok = false;
    // direct write — bypasses stamping (frames keep their original seq) and
    // backpressure (dropping a resume into a saturated queue defeats it)
    ws.send(e.frame);
    replayed++;
  }
  return { ok, replayed, from };
}
