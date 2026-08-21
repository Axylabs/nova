/**
 * ignex-nova — public package root.
 *
 * Re-exports the full typed pub/sub API (server + client + NATS bridge +
 * schema types) so a single `import ... from "ignex-nova"` works in Bun
 * projects.
 *
 * For leaner / target-specific imports use the subpath entrypoints — each
 * resolves to its own source file and tree-shakes independently:
 *
 *   import { createServer } from "ignex-nova/server";   // Bun-only (Rust FFI)
 *   import { createClient } from "ignex-nova/client";   // browser + Bun
 *   import { createNatsBridge } from "ignex-nova/nats"; // standalone bridge
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

// Plain-object payload types consumers type against (e.g. `Events["quote"]`).
// Import as types only — the runtime `events` registry is transport-internal.
export type {
  Events,
  EventName,
  AnyEventName,
  ControlEvents,
  ControlEventName,
} from "./src/schema";