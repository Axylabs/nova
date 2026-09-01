/**
 * Events-layer option types — `createServer({ events })` input.
 *
 * Type-only module (part of the `src/events/types` barrel). Resolved by
 * `createEventsHub` (`src/events/hub/index.ts`).
 */
import type { Bindings, DefaultBindings, EventNameOf } from "../../bindings/types";
import type { NatsBridgeOptions, NatsBridge } from "../../bridge/nats";
import type { ClusterTransport, ClusterStateStore, RedisConnectionOptions } from "./cluster";
import type { EventClient } from "./client";
import type { DeliveryPolicy } from "../delivery";

/**
 * `createServer({ events: EventsOptions })` — enables the events layer and
 * exposes it as `server.events`. The module-global `emit` / `on` singleton is
 * bound by default (`global: false` to opt out).
 */
export interface EventsOptions<B extends Bindings = DefaultBindings> {
  /**
   * App events clients are allowed to send to the hub. Default: every event
   * registered via `hub.on(...)` is auto-allowed on first use.
   */
  inbound?: EventNameOf<B>[];
  /** bind the module-global `emit`/`on` singleton (default true) */
  global?: boolean;
  /** called after a connection's client record is attached (seed `data`, …) */
  onConnect?: (client: EventClient) => void;
  /** called after a connection's client record is detached (cleanup) */
  onDisconnect?: (client: EventClient) => void;
  /** handler reliability: retries with backoff + dead-letter sink (default off) */
  handlers?: DeliveryPolicy;
  /** horizontal-scaling sync (server ⇄ server) */
  cluster?: EventsClusterOptions;
  /** offload-queue limits (the queue keeps cluster/state work off hot paths) */
  queue?: { workers?: number; maxPending?: number };
}

export interface EventsClusterOptions {
  /** stable id of this instance (default: random UUID) — self-dedupe */
  instanceId?: string;
  /** subject prefix (default: bindings subject prefix or "ignex") */
  prefix?: string;
  /**
   * NATS-based cluster messaging. `true` reuses the server's NATS bridge
   * connection (set `options.nats` too); pass `NatsBridgeOptions` to create a
   * dedicated bridge; pass a `NatsBridge` to reuse an existing one.
   */
  nats?: boolean | NatsBridgeOptions | NatsBridge;
  /** Redis pub/sub cluster messaging (lazy `ioredis`; subjects mirror NATS) */
  redis?: RedisConnectionOptions;
  /** pluggable messaging transport (tests / custom brokers) */
  transport?: ClusterTransport;
  /**
   * Shared-state store for presence / cluster group membership / client data.
   * Default: per-instance memory. Production: `createRedisStateStore(...)`.
   */
  state?: ClusterStateStore;
  /** presence re-announce + prune cadence (ms, default 15_000) */
  heartbeatMs?: number;
  /** remote presence TTL (ms, default 60_000) */
  presenceTtlMs?: number;
}
