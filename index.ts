/**
 * ignex-nova — public package root.
 *
 * Re-exports the full typed pub/sub API (server + client + NATS bridge +
 * schema types + generic bindings codegen) so a single `import ... from
 * "ignex-nova"` works in Bun projects.
 *
 * For leaner / target-specific imports use the subpath entrypoints — each
 * resolves to its own source file and tree-shakes independently:
 *
 *   import { createServer } from "ignex-nova/server";     // Bun-only (Rust FFI)
 *   import { createClient } from "ignex-nova/client";     // browser + Bun
 *   import { createNatsBridge } from "ignex-nova/nats";   // standalone bridge
 *   import { on, emit } from "ignex-nova/events";         // events layer + global emit
 *   import { generateBindings } from "ignex-nova/generate"; // ANY-schema codegen
 *   import { assembleBindings, defaultBindings } from "ignex-nova/bindings";
 *   import { encodeUtf8Into } from "ignex-nova/internal";   // codegen helpers
 *
 * Note: the root entry also pulls in the Bun-only server + FFI path, so
 * browser bundles should import "ignex-nova/client" instead.
 *
 * The README (and docs/publishing.md) covers consuming this from an npm
 * package: `bun add ignex-nova`, then use the subpaths above.
 */
export { createServer } from "./public/server";
export type {
  IgnServer,
  ClientInfo,
  IgnServerOptions,
  IgnBackpressureOptions,
  BackpressurePolicy,
  WsData,
  ClientMeta,
  AuthResult,
  MetricsSnapshot,
  Int64GuardMode,
} from "./public/server";
// events layer types (the runtime singleton API is `ignex-nova/events`)
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
} from "./public/server";

export { createClient } from "./public/client";
export type {
  IgnClient,
  IgnClientOptions,
  IgnReconnectOptions,
  ClientStatus,
} from "./public/client";

export { createNatsBridge, createSubjectBuilder } from "./public/nats";
export type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
  SubjectBuilder,
} from "./public/nats";

// ── generic bindings (ANY schema) ──────────────────────────────────────────
export { generateBindings } from "./public/generate";
export type { SchemaRegistry, GenerateOptions, GeneratedBindings } from "./public/generate";

export { assembleBindings, defaultBindings } from "./public/bindings";
export type {
  Bindings,
  BindingsParts,
  AssembleOptions,
  DirectTables,
  DirectCall,
  DirectEncoder,
  EventNameOf,
  ControlEventNameOf,
  EventsOf,
  ControlEventsOf,
  DefaultBindings,
} from "./public/bindings";

// runtime helpers used by generated code (also exported via `ignex-nova/internal`)
export { encodeUtf8Into, ensureCapacity, utf8Len } from "./public/internal";
export { checkInt64, setInt64GuardMode, pooledByteBuffer } from "./public/internal";

// Plain-object payload types consumers type against (e.g. `Events["quote"]`).
// Import as types only — the runtime `events` registry is transport-internal.
export type {
  Events,
  EventName,
  AnyEventName,
  ControlEvents,
  ControlEventName,
} from "./src/schema";
