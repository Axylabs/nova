/**
 * Per-topic replay history (last-value snapshots on subscribe / reconnect).
 * Pure data operations on `state.topicHistory` — no socket writes here
 * (`rooms.joinRoom` reads the recorded frames via `replayFrames`).
 *
 * History is a bounded `RingBuffer` (capacity = historySize): recording is O(1)
 * and, once full, the OLDEST frame is overwritten automatically — same
 * semantics as the old `push` + `shift`, but without the O(n) array shift.
 *
 * DURABILITY SEAM: an optional {@link TopicLog} (see `topic-log.ts`) receives
 * every recorded frame so history can outlive the ring window. When a client
 * asks for a seq the ring no longer holds, `topicHistoryFrom` hydrates the
 * missing prefix from the log.
 */
import { RingBuffer } from "./ring";
import type { ServerState } from "./state";

/** Record an owned copy of `frame` for `topic`, bounded to historySize. */
export function recordReplay(state: ServerState, topic: string, frame: Uint8Array): void {
  if (!state.replay) return;
  let hist = state.topicHistory.get(topic);
  if (!hist) {
    hist = new RingBuffer<{ seq: number; frame: Uint8Array }>(state.replay.historySize, true);
    state.topicHistory.set(topic, hist);
  }
  const seq = ++state.replaySeq;
  hist.push({ seq, frame: frame.slice() }); // owned copy for replay
  state.topicLog?.append(topic, frame, seq);
}

/** The recorded frames for `topic`, oldest → newest (already owned copies). */
export function replayFrames(state: ServerState, topic: string): Uint8Array[] {
  const hist = state.topicHistory.get(topic);
  if (!hist || hist.length === 0) return [];
  const out: Uint8Array[] = [];
  for (const e of hist) out.push(e.frame);
  return out;
}

/**
 * Recorded frames for `topic` strictly after `fromSeq` (0 = everything
 * retained), oldest → newest. Synchronous: serves from the in-memory ring;
 * when the ring's oldest entry leaves a hole above `fromSeq` and a durable
 * {@link TopicLog} is configured, the missing prefix is hydrated from the log
 * (blocking briefly is acceptable on this control path).
 */
export function topicHistoryFrom(
  state: ServerState,
  topic: string,
  fromSeq: number,
): Uint8Array[] {
  const hist = state.topicHistory.get(topic);
  const ring: Array<{ seq: number; frame: Uint8Array }> = [];
  if (hist) for (const e of hist) if (e.seq > fromSeq) ring.push(e);
  if (ring.length === 0) {
    // nothing in the ring at/after the resume point — try the durable log
    const log = state.topicLog;
    if (log && fromSeq > 0) return log.range(topic, fromSeq).map((e) => e.frame);
    return [];
  }
  const oldest = ring[0]!.seq;
  if (oldest > fromSeq + 1 && oldest > 1) {
    // hole between fromSeq and the ring window — hydrate the prefix
    const log = state.topicLog;
    if (log) {
      const prefix = log.range(topic, fromSeq, oldest - fromSeq - 1);
      return [...prefix.map((e) => e.frame), ...ring.map((e) => e.frame)];
    }
  }
  return ring.map((e) => e.frame);
}
