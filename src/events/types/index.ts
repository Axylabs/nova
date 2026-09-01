/**
 * Events layer types — barrel. One folder per concern:
 *
 *   client       — EventClient / ClientData / RemoteClient records
 *   emit-target  — EmitTarget addressing union
 *   context      — EventContext + handler signatures
 *   groups       — ClientGroup / UserGroup handles
 *   cluster      — ClusterTransport / ClusterStateStore ports
 *   metrics      — EventsMetricsSnapshot
 *   hub          — the public EventsHub API
 *   options      — EventsOptions / EventsClusterOptions inputs
 */

export type { ClientData, EventClient, RemoteClient } from "./client";
export type { EmitTarget, EmitTargetKind } from "./emit-target";
export type {
  EventContext,
  EventSource,
  EventHandler,
  ServerEventHandler,
} from "./context";
export type { ClientGroup, UserGroup } from "./groups";
export type {
  ClusterStateStore,
  ClusterTransport,
  RedisConnectionOptions,
} from "./cluster";
export type { EventsMetricsSnapshot } from "./metrics";
export type { EventsHub } from "./hub";
export type { EventsClusterOptions, EventsOptions } from "./options";
