/**
 * Redis state store (lazy `ioredis`). The production `ClusterStateStore` for
 * horizontally scaled deployments — every call is issued from the offload
 * queue, never from the WS hot path.
 */
import type { ClusterStateStore, RedisConnectionOptions } from "../types";
import { loadRedis } from "./redis-client";

export function createRedisStateStore(
  opts: RedisConnectionOptions = {},
): ClusterStateStore & { close(): Promise<void> } {
  const Redis = loadRedis();
  const r = new Redis(opts);
  return {
    async get(key) {
      const v = await r.get(key);
      return v == null ? null : String(v);
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) await r.set(key, value, "PX", ttlMs);
      else await r.set(key, value);
    },
    async del(key) {
      await r.del(key);
    },
    async sadd(key, member) {
      await r.sadd(key, member);
    },
    async srem(key, member) {
      await r.srem(key, member);
    },
    async smembers(key) {
      const v = await r.smembers(key);
      return Array.isArray(v) ? v.map(String) : [];
    },
    // redis EXPIRE is second-granularity — round up so short TTLs still hold
    async expire(key, ttlMs) {
      await r.expire(key, Math.max(1, Math.ceil(ttlMs / 1000)));
    },
    async close() {
      await r.quit();
    },
  };
}
