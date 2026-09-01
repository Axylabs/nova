/**
 * Metrics snapshot assembly — a PURE function folding every events-layer
 * counter source into one {@link EventsMetricsSnapshot}. No mutation, no I/O:
 * the hub calls it with current values whenever `hub.metrics()` is polled.
 */
import type { EventsMetricsSnapshot } from "../types";
import type { EmitCounters } from "../emit";
import type { DispatchCounters } from "./dispatch";

/** One queue-stats shape (`queue.stats()`), duplicated structurally. */
interface QueueStats {
  queued: number;
  processed: number;
  dropped: number;
  errors: number;
}

/** Cluster sync counters (`cluster.stats()`), all optional (unclustered → 0). */
interface ClusterStats {
  received: number;
  droppedSelf: number;
  droppedDupe: number;
  errors: number;
}

/** Cross-instance rpc counters (`clusterRpc.stats()`). */
interface RpcStats {
  sent: number;
  received: number;
}

export interface MetricsSnapshotInputs {
  /** hub-level emit counters */
  counters: EmitCounters;
  /** cluster transport failures seen by the hub itself */
  transportErrors: number;
  /** dispatch reliability counters (retries + dead letters) */
  dispatch: DispatchCounters;
  /** handler exceptions observed by the registry */
  handlerErrors: number;
  /** emits currently scheduled (`scheduler.size`) */
  scheduledActive: number;
  cluster?: ClusterStats;
  queue: QueueStats;
  rpc?: RpcStats;
  /** local connected clients */
  connectedClients: number;
  /** remote clients known via presence */
  remoteClients: number;
  /** active client-group / user-group counts */
  clientGroups: number;
  userGroups: number;
}

/** Sum of cluster-sync errors + hub-side transport errors. */
const totalClusterErrors = (c: MetricsSnapshotInputs): number =>
  (c.cluster?.errors ?? 0) + c.transportErrors;

export function buildMetricsSnapshot(c: MetricsSnapshotInputs): EventsMetricsSnapshot {
  return {
    emitted: c.counters.emitted,
    emittedByTarget: { ...c.counters.emittedByTarget },
    deliveredLocal: c.counters.deliveredLocal,
    clusterPublished: c.counters.clusterPublished,
    clusterReceived: c.cluster?.received ?? 0,
    clusterDroppedSelf: c.cluster?.droppedSelf ?? 0,
    clusterDroppedDupe: c.cluster?.droppedDupe ?? 0,
    clusterRouted: c.counters.clusterRouted,
    clusterErrors: totalClusterErrors(c),
    queueQueued: c.queue.queued,
    queueDropped: c.queue.dropped,
    queueErrors: c.queue.errors,
    handlerErrors: c.handlerErrors,
    handlerRetries: c.dispatch.handlerRetries,
    dlqCount: c.dispatch.dlqCount,
    scheduledActive: c.scheduledActive,
    rpcSent: c.rpc?.sent ?? 0,
    rpcReceived: c.rpc?.received ?? 0,
    connectedClients: c.connectedClients,
    remoteClients: c.remoteClients,
    clientGroups: c.clientGroups,
    userGroups: c.userGroups,
  };
}
