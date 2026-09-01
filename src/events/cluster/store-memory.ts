/**
 * In-memory state store — per-process default `ClusterStateStore`.
 * Pass a SHARED `Map` to simulate a cross-instance store in tests /
 * single-process multi-instance setups.
 *
 * TTLs are modeled with a parallel `__ttl:` key checked lazily on read.
 */
import type { ClusterStateStore } from "../types";

export function createMemoryStateStore(
  shared?: Map<string, unknown>,
): ClusterStateStore & { close(): Promise<void> } {
  const data = shared ?? new Map<string, unknown>();

  const ttlKey = (key: string): string => `__ttl:${key}`;

  /** Lazily expire: drop the key when its TTL has passed; report liveness. */
  const alive = (key: string): boolean => {
    const ttl = data.get(ttlKey(key));
    if (ttl === undefined) return true;
    if (Date.now() > Number(ttl)) {
      data.delete(key);
      data.delete(ttlKey(key));
      return false;
    }
    return true;
  };

  return {
    async get(key) {
      if (!alive(key)) return null;
      const v = data.get(key);
      return typeof v === "string" ? v : null;
    },
    async set(key, value, ttlMs) {
      data.set(key, value);
      if (ttlMs !== undefined) data.set(ttlKey(key), Date.now() + ttlMs);
    },
    async del(key) {
      data.delete(key);
      data.delete(ttlKey(key));
    },
    async sadd(key, member) {
      let s = data.get(key);
      if (!(s instanceof Set)) {
        s = new Set<string>();
        data.set(key, s);
      }
      (s as Set<string>).add(member);
    },
    async srem(key, member) {
      const s = data.get(key);
      if (s instanceof Set) (s as Set<string>).delete(member);
    },
    async smembers(key) {
      if (!alive(key)) return [];
      const s = data.get(key);
      return s instanceof Set ? [...(s as Set<string>)] : [];
    },
    async expire(key, ttlMs) {
      data.set(ttlKey(key), Date.now() + ttlMs);
    },
    async close() {
      data.clear();
    },
  };
}
