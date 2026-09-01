/**
 * Cluster sync port types — the broker transport and shared-state store
 * contracts used by `src/events/cluster/`.
 *
 * Type-only module (part of the `src/events/types` barrel).
 */

/**
 * Cross-instance messaging transport (server ⇄ server). NATS and Redis
 * adapters are provided; any broker that supports named channels + byte
 * payloads can be plugged in (tests use an in-memory bus). All calls are
 * fire-and-forget and are invoked from the offload queue, never from the WS
 * hot path.
 */
export interface ClusterTransport {
  readonly connected: boolean;
  /** synchronously hand bytes to the broker (throws → caller counts an error) */
  publish(subject: string, data: Uint8Array): void;
  /** subscribe; `cb` receives raw message bytes; returns an unsubscribe fn */
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

/**
 * Optional shared-state store (presence / cluster group membership / client
 * data). A memory implementation is used by default (per-instance); Redis is
 * the production choice for horizontally scaled deployments (`createRedisStateStore`).
 */
export interface ClusterStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, ttlMs: number): Promise<void>;
}

/** Redis connection options — a URL string or an ioredis options object. */
export type RedisConnectionOptions = string | Record<string, unknown>;
