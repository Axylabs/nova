/**
 * Public server API — thin re-export shim (keeps the npm entrypoint + `dist`
 * build stable). The implementation lives in the functional modules under
 * `src/core/`; this file just exposes the public surface.
 *
 *   import { createServer } from "ignex-nova/server";
 *
 *   const server = createServer({ port: 3000 });
 *   server.publish("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2, ... });
 *   server.publishTo(ws, "trade", { ... });
 *   server.join("equities", ws); server.publishToTopic("equities", "quote", {...});
 *
 *   // your own schema (see ignex-nova/generate):
 *   const server = createServer({ port: 3000, bindings });
 *   server.publish("yourEvent", {...}); // typed against YOUR Events
 *
 * Bun-only (bun:ffi + Bun.serve).
 */
export { createServer, type IgnServer, type ClientInfo } from "../src/core/server";
export type {
  IgnServerOptions,
  IgnBackpressureOptions,
  BackpressurePolicy,
  WsData,
  ClientMeta,
  AuthResult,
} from "../src/core/state";
export type { MetricsSnapshot } from "../src/core/metrics";
export type { Int64GuardMode } from "../src/core/int64-guard";
// NATS bridge — re-exported so `nats` options on `createServer` are typed
// without a separate import (a standalone entrypoint is `ignex-nova/nats`).
export { createNatsBridge } from "../src/bridge/nats";
export type {
  NatsBridgeOptions,
  NatsBridge,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
} from "../src/bridge/nats";
// Events layer — re-exported so `createServer({ events })` is fully typed
// without a separate import (the runtime API is `ignex-nova/events`).
export type {
  EventsHub,
  EventsOptions,
  EventsClusterOptions,
  EventsMetricsSnapshot,
  EventClient,
  ClientData,
  ClientGroup,
  UserGroup,
  EventContext,
  EventHandler,
  ServerEventHandler,
  EmitTarget,
  EmitTargetKind,
  RemoteClient,
  ClusterTransport,
  ClusterStateStore,
  RedisConnectionOptions,
} from "../src/events/types";
