/**
 * Outbound write path — the ONLY place that talks to `ws.send` and mutates the
 * per-socket backpressure queue / send counters. `sendFrame` executes the pure
 * `decide()` result; `doSend` is the single accounting point.
 */
import type { ServerWebSocket } from "bun";
import type { ControlEventName, ControlEvents } from "../schema";
import { decide } from "./backpressure";
import { RingBuffer } from "./ring";
import { ensureHistory, recordSent, stampSeq } from "./resume";
import type { ServerState, WsData } from "./state";

/** Actual socket write + counters (single accounting point). */
export function doSend(state: ServerState, ws: ServerWebSocket<WsData>, frame: Uint8Array): void {
  ws.send(frame);
  state.metrics.sent++;
  state.metrics.bytesSent += frame.byteLength;
}

/**
 * Send one frame to a socket, honoring the configured backpressure policy AND
 * (when resume is enabled) stamping a per-connection delivery seq into the
 * envelope v2 header first. Only APP frames are stamped: the delivery seq is
 * an app-delivery guarantee, and control frames (ping/pong/welcome/resume
 * acks) must never create ordering obligations for the client's gap gate.
 *
 * The stamp mutates the shared scratch view IN PLACE — safe because every
 * external copy (bridge / cluster / replay history) is taken before this
 * point, and `ws.send` copies synchronously.
 *
 * Pass `seq` to send a pre-stamped frame verbatim (resume replays keep their
 * original delivery seqs and are not re-recorded).
 */
export function sendFrame(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  frame: Uint8Array,
  opts?: { readonly seq?: number },
): void {
  if (opts?.seq !== undefined) {
    // pre-stamped replay frame — write it as-is
    const bp0 = state.bp;
    if (!bp0) {
      doSend(state, ws, frame);
      return;
    }
    const d0 = decide(bp0, ws);
    if (d0.kind === "send") doSend(state, ws, frame);
    else if (d0.kind === "close") {
      state.metrics.disconnectedSlow++;
      ws.close(1013, "slow consumer");
    }
    return;
  }
  if (
    state.resume !== null &&
    state.resume !== undefined &&
    !isControlFrame(state.bindings, frame) &&
    ensureHistory(state, ws) !== undefined
  ) {
    const seq = ws.data.sendSeq++;
    if (stampSeq(state.bindings, frame, seq)) {
      recordSent(state, ws, frame, seq);
      state.metrics.stampedSeq++;
    }
  }
  const bp = state.bp;
  if (!bp) {
    doSend(state, ws, frame);
    return;
  }
  const d = decide(bp, ws);
  switch (d.kind) {
    case "send":
      doSend(state, ws, frame);
      return;
    case "close":
      state.metrics.disconnectedSlow++;
      ws.close(1013, "slow consumer");
      return;
    case "drop-newest":
      state.metrics.droppedNewest++;
      return;
    case "enqueue": {
      // RingBuffer: O(1) push + drop-from-head (no array shift() memmove).
      let q = ws.data.queue;
      if (q === undefined) {
        q = new RingBuffer<Uint8Array>();
        ws.data.queue = q;
      }
      q.push(frame.slice()); // owned copy for the queue (already seq-stamped)
      for (let i = 0; i < d.dropHead; i++) {
        q.shift();
        state.metrics.droppedOldest++;
      }
      return;
    }
  }
}

/** Cheap envelope-id probe: true when `frame` is a transport-internal event. */
function isControlFrame(bindings: ServerState["bindings"], frame: Uint8Array): boolean {
  if (frame.byteLength < 5) return false;
  const id =
    (frame[1]! | (frame[2]! << 8) | (frame[3]! << 16) | (frame[4]! << 24)) >>> 0;
  return bindings.isControlId(id);
}

/** Flush a slow socket's drop-oldest queue as the OS buffers drain. */
export function drainSocket(state: ServerState, ws: ServerWebSocket<WsData>): void {
  const q = ws.data.queue;
  if (!q || q.length === 0 || !state.bp) return;
  while (q.length > 0) {
    if (ws.getBufferedAmount() > state.bp.highWaterMark) break; // still backed up
    doSend(state, ws, q.shift()!);
  }
}

/** Send a control frame (hello / subscribe / ping / ...) through the same outbound path. */
export function sendControl<K extends ControlEventName>(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  name: K,
  payload: ControlEvents[K],
): void {
  sendFrame(state, ws, state.transport.encodeToScratch(name, payload));
}
