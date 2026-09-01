/**
 * Cluster sync — barrel. Horizontal scaling for the events layer, decomposed
 * by concern:
 *
 *   kinds           — routing-kind constants + wire ids
 *   envelope        — the self-describing binary frame codec (pure)
 *   subjects        — broker channel names derived from the prefix
 *   presence        — presence message codec (join/leave/sync)
 *   presence-table  — in-memory remote-presence index with TTL pruning
 *   dedupe          — bounded broker-redelivery dedupe window
 *   keys            — shared-state key builders
 *   sync            — createClusterSync composition root
 *   transport-nats / transport-redis — ClusterTransport adapters
 *   store-memory / store-redis       — ClusterStateStore adapters
 *
 * All cross-instance work is deferred to the offload queue — the emit call
 * never blocks on a broker.
 */

export { CLUSTER_ENV_VERSION, CLUSTER_KINDS, CLUSTER_KIND_ID, clusterKindFromId, type ClusterKind } from "./kinds";
export { decodeClusterMessage, encodeClusterMessage, type ClusterEnvelope } from "./envelope";
export { createClusterSubjects, type ClusterSubjects } from "./subjects";
export {
  decodePresence,
  encodePresence,
  type PresenceJoin,
  type PresenceLeave,
  type PresenceMessage,
  type PresenceSync,
} from "./presence";
export { createPresenceTable, type PresenceTable } from "./presence-table";
export { createDedupeWindow, type DedupeWindow } from "./dedupe";
export {
  clientDataKey,
  clientGroupStateKey,
  parsePresenceMember,
  presenceInstanceKey,
  presenceUserKey,
  userGroupStateKey,
} from "./keys";
export {
  createClusterSync,
  type ClusterMsgMeta,
  type ClusterSync,
  type ClusterSyncOptions,
} from "./sync";
export { createNatsClusterTransport } from "./transport-nats";
export { createRedisClusterTransport } from "./transport-redis";
export { createMemoryStateStore } from "./store-memory";
export { createRedisStateStore } from "./store-redis";
