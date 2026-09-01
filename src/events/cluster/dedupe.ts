/**
 * Broker-redelivery dedupe window — bounded recent-message-id tracking.
 *
 * Durable brokers may redeliver; every processed message id is recorded in a
 * ring + set pair and duplicates are dropped. Encapsulated factory (like
 * `createMetrics`) — the state is private, the surface is one pure predicate.
 */
import { RingBuffer } from "../../core/ring";

export interface DedupeWindow {
  /**
   * Record `id` and report whether it was ALREADY seen (true → drop the
   * message). Empty ids and a zero-size window disable tracking entirely.
   */
  markSeen(id: string): boolean;
}

/**
 * @param size how many message ids to remember (0 disables; values < 16 are
 *   clamped up so the ring has usable capacity).
 */
export function createDedupeWindow(size: number): DedupeWindow {
  const window = Math.max(0, size);
  if (window === 0) return { markSeen: () => false };

  const ring = new RingBuffer<string>(Math.max(16, window), true);
  const seen = new Set<string>();

  return {
    markSeen(id: string): boolean {
      if (id === "") return false;
      if (seen.has(id)) return true;
      // evict the oldest id when the window is full (FIFO — matches redelivery)
      if (ring.length >= window) {
        const evict = ring.shift();
        if (evict !== undefined) seen.delete(evict);
      }
      ring.push(id);
      seen.add(id);
      return false;
    },
  };
}
