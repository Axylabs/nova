/**
 * Durable topic-log seam — the pluggable backend behind the bounded replay
 * ring. The ring keeps the LAST N frames per topic in memory; a {@link TopicLog}
 * receives the same frames so subscribers can resume from points the ring has
 * already forgotten.
 *
 * Contract (deliberately narrow):
 *   - `append` is SYNCHRONOUS and must never throw onto the publish hot path —
 *     implementations buffer internally and flush on their own schedule (the
 *     memory impl appends to an array; a file impl would hand off to a writer;
 *     a NATS JetStream / Redis Streams impl would enqueue a publish).
 *   - `range(topic, afterSeq, limit?)` returns frames strictly AFTER `afterSeq`
 *     oldest → newest, synchronously. Adapters over remote stores should
 *     maintain a local read-through cache so this stays sync-friendly.
 *   - `latestSeq(topic)` mirrors the server's replay-seq counter for the topic
 *     (0 = unknown/empty).
 *
 * Ship-with implementation: {@link createMemoryTopicLog} — per-topic bounded
 * array (drop-oldest), process-local durability (survives ring overflow, not a
 * restart). Production adapters (JetStream / Redis Streams / filesystem)
 * implement the same three methods — see docs/architecture.md ("Durability").
 */
import { RingBuffer } from "./ring";

/** One durably-retained topic frame. */
export interface LoggedFrame {
  /** global replay seq (the same counter stamped into the topic history) */
  seq: number;
  frame: Uint8Array;
}

export interface TopicLog {
  /** Record a frame for `topic` (fire-and-forget; never throws). */
  append(topic: string, frame: Uint8Array, seq: number): void;
  /** Frames strictly after `afterSeq`, oldest → newest (at most `limit`). */
  range(topic: string, afterSeq: number, limit?: number): LoggedFrame[];
  /** Highest seq retained for `topic` (0 = none). */
  latestSeq(topic: string): number;
  /** Release resources (flush buffers, close files/connections). */
  close(): void;
}

export interface MemoryTopicLogOptions {
  /** max frames retained PER TOPIC (drop-oldest beyond), default 10_000 */
  maxPerTopic?: number;
}

/** Process-local durable log: survives ring overflow, not a restart. */
export function createMemoryTopicLog(
  opts: MemoryTopicLogOptions = {},
): TopicLog {
  const max = Math.max(1, opts.maxPerTopic ?? 10_000);
  const topics = new Map<string, { frames: RingBuffer<LoggedFrame>; latest: number }>();
  const ensure = (topic: string) => {
    let t = topics.get(topic);
    if (!t) {
      t = { frames: new RingBuffer<LoggedFrame>(max, true), latest: 0 };
      topics.set(topic, t);
    }
    return t;
  };
  return {
    append(topic, frame, seq) {
      const t = ensure(topic);
      t.frames.push({ seq, frame: frame.slice() });
      if (seq > t.latest) t.latest = seq;
    },
    range(topic, afterSeq, limit) {
      const t = topics.get(topic);
      if (!t) return [];
      const out: LoggedFrame[] = [];
      for (const e of t.frames) {
        if (e.seq <= afterSeq) continue;
        out.push(e);
        if (limit !== undefined && out.length >= limit) break;
      }
      return out;
    },
    latestSeq(topic) {
      return topics.get(topic)?.latest ?? 0;
    },
    close() {
      topics.clear();
    },
  };
}
