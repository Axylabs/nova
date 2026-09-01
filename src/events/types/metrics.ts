/**
 * Events-layer metrics snapshot type (folded into `server.getMetrics().events`).
 *
 * Type-only module (part of the `src/events/types` barrel). The assembly
 * runtime lives in `src/events/hub/metrics-snapshot.ts`.
 */
import type { EmitTargetKind } from "./emit-target";

/** Events-layer counters (folded into `server.getMetrics().events`). */
export interface EventsMetricsSnapshot {
  /** emit calls (all targets) */
  emitted: number;
  emittedByTarget: Record<EmitTargetKind, number>;
  /** frames written to local sockets by the events layer */
  deliveredLocal: number;
  /** frames handed to the cluster transport */
  clusterPublished: number;
  /** frames received from other instances */
  clusterReceived: number;
  /** frames dropped because they originated on this instance */
  clusterDroppedSelf: number;
  /** duplicate cluster messages dropped (broker redelivery dedupe window) */
  clusterDroppedDupe: number;
  /** targeted emits routed ONLY to owning instances instead of the full mesh */
  clusterRouted: number;
  /** cluster transport / decode failures */
  clusterErrors: number;
  /** offload-queue: tasks accepted */
  queueQueued: number;
  /** offload-queue: tasks dropped (overflow) */
  queueDropped: number;
  /** offload-queue: task failures */
  queueErrors: number;
  /** handler exceptions (caught + isolated) */
  handlerErrors: number;
  /** handler retries scheduled by the reliability layer (`handlers.retries`) */
  handlerRetries: number;
  /** events dead-lettered after exhausting the retry budget */
  dlqCount: number;
  /** emits currently scheduled via `hub.schedule` */
  scheduledActive: number;
  /** cross-instance rpc calls sent / received */
  rpcSent: number;
  rpcReceived: number;
  /** local connected clients */
  connectedClients: number;
  /** remote clients known via cluster presence */
  remoteClients: number;
  /** active client groups / user groups */
  clientGroups: number;
  userGroups: number;
}
