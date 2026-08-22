/**
 * Events layer — internal barrel. Public entry: `public/events.ts`
 * (`ignex-nova/events`).
 */
export { createEventsHub } from "./hub";
export type { EventsHubInternal } from "./hub";
export { createClientData } from "./data";
export { createClientStore, createEventClient } from "./clients";
export { createHandlerRegistry } from "./registry";
export { createGroupManager } from "./groups";
export { createTaskQueue } from "./queue";
export { createEmitter, deliverLocal } from "./emit";
export {
  createClusterSync,
  createClusterSubjects,
  createMemoryStateStore,
  createNatsClusterTransport,
  createRedisClusterTransport,
  createRedisStateStore,
  decodeClusterMessage,
  encodeClusterMessage,
} from "./cluster";
export {
  bindEvents,
  emit,
  emitToClient,
  emitToGroup,
  emitToTopic,
  emitToUser,
  getEventsHub,
  isEventsBound,
  off,
  offAny,
  offServerEvent,
  on,
  onAny,
  onServerEvent,
  once,
  unbindEvents,
} from "./global";
export type {
  ClientData,
  ClientGroup,
  ClusterStateStore,
  ClusterTransport,
  EmitTarget,
  EmitTargetKind,
  EventClient,
  EventContext,
  EventHandler,
  EventsClusterOptions,
  EventsHub,
  EventsMetricsSnapshot,
  EventsOptions,
  EventSource,
  RedisConnectionOptions,
  RemoteClient,
  ServerEventHandler,
  UserGroup,
} from "./types";
