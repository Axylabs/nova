/**
 * Redis pub/sub cluster transport (lazy `ioredis`, optional peer dependency).
 * Binary-safe (Buffer replies via `returnBuffers`), pattern-subscribes the
 * cluster channel (`{prefix}.cluster.*`), fire-and-forget publishes — never
 * blocks the caller. Async publish failures are reported to `onError`.
 *
 * NATS-style wildcards (`foo.>`) are translated to Redis pattern
 * subscriptions (`foo.*`) so both brokers share one subject grammar.
 */
import type { ClusterTransport, RedisConnectionOptions } from "../types";
import { loadRedis, redisConnArgs, type IoredisClient } from "./redis-client";

type MessageListener = (data: Uint8Array) => void;

/** Convert an ioredis message payload into bytes (binary-safe). */
function toBytes(msg: unknown): Uint8Array {
  const b = msg instanceof Uint8Array ? msg : Buffer.from(String(msg));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export function createRedisClusterTransport(
  opts: RedisConnectionOptions,
  onError?: (err: Error) => void,
): ClusterTransport {
  const Redis = loadRedis();
  const listeners = new Map<string, Set<MessageListener>>();
  const patternListeners = new Map<string, Set<MessageListener>>();
  let closed = false;

  // two connections: publishers must not block on subscriber-mode connections
  const make = (): IoredisClient => {
    const c = redisConnArgs(opts);
    return c.url ? new Redis(c.url, { returnBuffers: true }) : new Redis({ ...c.options, returnBuffers: true });
  };
  const pub = make();
  const sub = make();

  /** Dispatch a broker message to every listener registered for `channel`. */
  const dispatch = (table: Map<string, Set<MessageListener>>, channel: string, msg: unknown): void => {
    const cbs = table.get(channel);
    if (!cbs) return;
    const data = toBytes(msg);
    for (const cb of cbs) cb(data);
  };

  sub.on("message", (channel: unknown, msg: unknown) => {
    dispatch(listeners, String(channel), msg);
  });
  sub.on("pmessage", (_pattern: unknown, channel: unknown, msg: unknown) => {
    dispatch(patternListeners, String(channel), msg);
  });

  /**
   * Shared subscribe bookkeeping: register `cb`, dial the broker once per
   * channel, and return an unsubscribe that tears the subscription down when
   * the last listener goes away.
   */
  const subscribeWith = (
    table: Map<string, Set<MessageListener>>,
    key: string,
    dial: (k: string) => void,
    hangUp: (k: string) => void,
    cb: MessageListener,
  ): (() => void) => {
    let set = table.get(key);
    if (!set) {
      set = new Set();
      table.set(key, set);
      dial(key);
    }
    set.add(cb);
    return () => {
      const s = table.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        table.delete(key);
        hangUp(key);
      }
    };
  };

  return {
    get connected(): boolean {
      return !closed && pub.status === "ready" && sub.status === "ready";
    },
    publish(subject, data) {
      if (closed) return;
      void pub
        .publish(subject, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
        .catch((err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))));
    },
    subscribe(subject, cb) {
      if (subject.includes(">")) {
        // NATS-style wildcard → Redis pattern subscription
        const pattern = subject.replace(/\.>+$/, ".*");
        return subscribeWith(
          patternListeners,
          pattern,
          (p) => void sub.psubscribe(p),
          (p) => void sub.punsubscribe(p),
          cb,
        );
      }
      return subscribeWith(
        listeners,
        subject,
        (s) => void sub.subscribe(s),
        (s) => void sub.unsubscribe(s),
        cb,
      );
    },
    async close() {
      closed = true;
      listeners.clear();
      patternListeners.clear();
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
