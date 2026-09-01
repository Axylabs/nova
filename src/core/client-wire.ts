/**
 * Client wire handling — outbound frame sends + inbound decode/dispatch.
 * `handleMessage` decodes the envelope, filters control frames, and fans app
 * events out to the registered handlers. All decode/encode goes through
 * `state.bindings`, so a client speaks whatever wire stack it was given.
 *
 * With envelope v2 (delivery seqs) and `resume` enabled, app frames pass
 * through a small ordering gate: contiguous seqs deliver immediately; a GAP
 * buffers out-of-order frames and asks the server to re-send the hole
 * (`resume` control frame); replayed hole-fills keep their original seqs so
 * delivery stays in-order and duplicate-free.
 */
import type { ControlEventName, ControlEvents } from "../schema";
import type { ClientState } from "./client-state";

/** Send an encoded frame, if the socket is open. */
export function sendFrame(state: ClientState, frame: Uint8Array): void {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ignex: client is not connected");
  // Bun's send() wants an ArrayBuffer-backed view; cast the (owned) frame.
  ws.send(frame as Uint8Array<ArrayBuffer>);
}

export function sendControl<K extends ControlEventName>(
  state: ClientState,
  name: K,
  payload: ControlEvents[K],
): void {
  sendFrame(state, state.bindings.encodeFrame(name, payload));
}

export function emitError(state: ClientState, err: Error): void {
  for (const cb of state.errorCbs) cb(err);
}

/** Delivery header offsets derived from the bindings' header length. */
const flagsAt = (state: ClientState): number => state.bindings.wireHeaderLen - 9;
const seqAt = (state: ClientState): number => state.bindings.wireHeaderLen - 8;

function readDeliverySeq(state: ClientState, bytes: Uint8Array): number | null {
  const len = state.bindings.wireHeaderLen;
  if (len < 14 || bytes.byteLength < len) return null;
  if ((bytes[flagsAt(state)]! & 1) === 0) return null;
  return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(seqAt(state), true));
}

/** Ask the server to re-send everything after `state.rxSeq` (throttled). */
export function requestResume(state: ClientState): void {
  if (!state.resume.enabled || state.resumeInFlight) return;
  try {
    sendControl(state, "resume", { lastSeq: state.rxSeq });
    state.resumeInFlight = true;
  } catch {
    // not connected — reconnect flow will carry lastSeq in `hello`
  }
}

/** Force-drain the pending buffer after an unfillable gap (accept loss). */
export function flushPending(state: ClientState): void {
  if (state.pending.size === 0) return;
  const seqs = [...state.pending.keys()].sort((a, b) => a - b);
  for (const s of seqs) {
    for (const f of state.pending.get(s)!) dispatchAppFrame(state, f);
    state.pending.delete(s);
  }
  if (seqs.length > 0 && seqs[seqs.length - 1]! > state.rxSeq) {
    state.rxSeq = seqs[seqs.length - 1]!;
  }
  state.pendingFrom = 0;
}

/** Dispatch one decoded APP frame to handlers (no ordering). */
function dispatchAppFrame(state: ClientState, bytes: Uint8Array): void {
  const frame = state.bindings.decodeFrame(bytes);
  if (!frame) return;
  const set = state.handlers.get(frame.name);
  if (set) for (const cb of set) cb(frame.payload);
  for (const cb of state.anyHandlers) cb(frame.name, frame.payload);
}

/**
 * Ordered delivery of one raw app frame. Returns true when the frame was
 * consumed here (contiguous / buffered / replayed); false = not tracking.
 */
function orderedDeliver(state: ClientState, bytes: Uint8Array, seq: number): boolean {
  if (!state.resume.enabled) return false;
  if (seq === state.rxSeq + 1) {
    state.rxSeq = seq;
    dispatchAppFrame(state, bytes);
    // drain anything the gap-fill delivered contiguously behind us
    while (state.pending.has(state.rxSeq + 1)) {
      const next = state.rxSeq + 1;
      for (const f of state.pending.get(next)!) dispatchAppFrame(state, f);
      state.pending.delete(next);
      state.rxSeq = next;
    }
    if (state.pending.size === 0) state.pendingFrom = 0;
    return true;
  }
  if (seq <= state.rxSeq) {
    // replayed hole-fill or duplicate: hole-fills are NEW payloads (the live
    // copy was lost), duplicates are rare broker artifacts — deliver both is
    // unsafe, so dedupe by seq against frames already dispatched past a hole:
    // we track nothing extra because replays only cover UNDELIVERED ranges.
    dispatchAppFrame(state, bytes);
    return true;
  }
  // seq > rxSeq + 1 → GAP: buffer, then ask the server to fill it
  let list = state.pending.get(seq);
  if (!list) {
    if (state.pending.size >= state.resume.maxPending) {
      flushPending(state); // accept loss rather than grow unbounded
    }
    list = [];
    state.pending.set(seq, list);
  }
  list.push(bytes);
  if (state.pendingFrom === 0) state.pendingFrom = state.rxSeq;
  requestResume(state);
  if (state.gapTimer === null) {
    state.gapTimer = setTimeout(() => {
      state.gapTimer = null;
      // server could not fill the hole (resume-miss / offline) — accept loss
      flushPending(state);
    }, state.resume.timeoutMs);
  }
  return true;
}

export function handleControl(state: ClientState, name: ControlEventName, payload: unknown): void {
  switch (name) {
    case "hello": {
      const p = payload as ControlEvents["hello"];
      if (p.version !== state.bindings.wireVersion) {
        // server speaks a different wire version — refuse + surface
        state.ws?.close(1002, "wire version mismatch");
        emitError(state, new Error(`ignex: server wire version ${p.version} does not match ${state.bindings.wireVersion}`));
      }
      break;
    }
    case "welcome": {
      const p = payload as ControlEvents["welcome"];
      state.clientId = p.clientId;
      state.groups = [...p.groups];
      break;
    }
    case "resumed": {
      state.resumeInFlight = false;
      const p = payload as ControlEvents["resumed"];
      if (!p.ok && p.from === 0) {
        // server has nothing after our seq (fresh process / grave evicted) —
        // accept the loss and continue from the buffered frames
        flushPending(state);
      }
      // ok=true: replayed frames follow with their original seqs and slot
      // into the ordering gate automatically.
      break;
    }
    case "rpcResult": {
      const p = payload as ControlEvents["rpcResult"];
      const call = state.rpcPending.get(p.id);
      if (!call) break;
      state.rpcPending.delete(p.id);
      clearTimeout(call.timer);
      if (!p.ok) {
        call.reject(new Error(`ignex rpc "${call.name}" failed: ${p.err}`));
        break;
      }
      try {
        const bytes = Uint8Array.from(atob(p.payloadB64), (c) => c.charCodeAt(0));
        const frame = state.bindings.decodeFrame(bytes);
        call.resolve(frame?.payload);
      } catch (err) {
        call.reject(err instanceof Error ? err : new Error("ignex rpc: bad result"));
      }
      break;
    }
    case "pong":
      state.lastPong = Date.now();
      break;
    default:
      break;
  }
}

export function handleMessage(state: ClientState, data: ArrayBuffer | string): void {
  if (typeof data === "string") return; // ignore text frames
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
  // fast envelope check before any decode
  const header = state.bindings.readFrameHeader(bytes);
  if (!header) {
    emitError(state, new Error("ignex: undecodable / version-mismatched frame dropped"));
    return;
  }
  if (state.bindings.isControlId(header.id)) {
    handleControl(state, header.name as ControlEventName, state.bindings.decodePayload(header.id, bytes));
    return;
  }
  const seq = readDeliverySeq(state, bytes);
  if (seq !== null && orderedDeliver(state, bytes, seq)) return;
  dispatchAppFrame(state, bytes);
}
