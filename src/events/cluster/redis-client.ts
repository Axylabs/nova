/**
 * Lazy `ioredis` loader — shared by the Redis cluster transport and the Redis
 * state store. Redis is an OPTIONAL peer dependency: it is never bundled and
 * only loaded when a Redis option is actually used.
 *
 * The structural types below describe the small slice of ioredis nova uses;
 * they are intentionally loose (the library is untyped here) but ABI-exact.
 */
import { createRequire } from "node:module";
import type { RedisConnectionOptions } from "../types";

const nodeRequire = createRequire(import.meta.url);

/** Structural type of the ioredis client surface nova relies on. */
export interface IoredisClient {
  publish(channel: string, data: Buffer): Promise<unknown>;
  subscribe(...channels: string[]): Promise<unknown>;
  psubscribe(...patterns: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  punsubscribe(...patterns: string[]): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  get(key: string): Promise<unknown>;
  set(...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
  readonly status: string;
}

/** Synchronously load the ioredis constructor (throws with install guidance). */
export function loadRedis(): new (...args: unknown[]) => IoredisClient {
  try {
    return nodeRequire("ioredis") as new (...args: unknown[]) => IoredisClient;
  } catch {
    throw new Error(
      "ignex events cluster: Redis configured but 'ioredis' is not installed — run `bun add ioredis` (or pass a custom cluster.transport / cluster.state)",
    );
  }
}

/** Split connection options into ioredis ctor args ({url} vs {options}). */
export function redisConnArgs(opts: RedisConnectionOptions): {
  url?: string;
  options?: Record<string, unknown>;
} {
  return typeof opts === "string" ? { url: opts } : { options: opts };
}
