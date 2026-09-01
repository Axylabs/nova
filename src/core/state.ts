/**
 * Server state + public option types. `createServerState(options)` produces the
 * single explicit state object that every server action function reads/mutates
 * (functional composition — no class, no `this`).
 *
 * The option types (IgnServerOptions / IgnBackpressureOptions / WsData) are the
 * PUBLIC surface and are re-exported by `public/server.ts`.
 */
import type { ServerWebSocket } from "bun";
import { defaultBindings } from "../bindings/default";
import type { Bindings, DefaultBindings, EventNameOf } from "../bindings/types";
import type { NatsBridge, NatsBridgeOptions } from "../bridge/nats";
import { createEventTrace, type EventTrace, type EventTraceOptions } from "../events/trace";
import { createTransport, defaultTransport, type Transport } from "../transport/transport";
import type { Int64GuardMode } from "./int64-guard";
import { createMetrics, type Metrics } from "./metrics";
import { resolveRateLimit, type RateLimitOptions, type ResolvedRateLimit } from "./rate-limit";
import type { RingBuffer } from "./ring";

/**
 * Optional identity metadata a client may carry for targeting / grouping.
 * Returned from the `authenticate` hook (or filled in programmatically).
 */
export interface ClientMeta {
  /** explicit client id; omitted → auto-assigned `crypto.randomUUID()` */
  id?: string;
  /**
   * The identity this connection acts ON BEHALF OF (e.g. the logged-in user).
   * Several connections may share a `userId` (multi-tab / multi-device) — the
   * events layer groups them for user-targeted emits (`hub.emitToUser`).
   */
  userId?: string;
  /** server-side groups this client belongs to on connect */
  groups?: string[];
  /** arbitrary app metadata (exposed via `getClient` / `getClients`) */
  meta?: Record<string, unknown>;
}

/** What `authenticate` may return: `true`/`false` (old behavior) or metadata. */
export type AuthResult = boolean | ClientMeta;

/** Per-socket metadata carried on the upgraded WebSocket (`ws.data`). */
export interface WsData {
  /** wire version the client announced in its hello (undefined until then) */
  version?: number;
  /** last sequence the client has seen (0 = none) — used for replay */
  lastSeq: number;
  /** topics this socket has joined (client-joinable rooms) */
  topics: Set<string>;
  /** server-side groups this socket belongs to (auth-seeded + programmatic) */
  groups: Set<string>;
  /** stable client id (auth metadata or auto-generated UUID) */
  id: string;
  /** identity this connection acts on behalf of (undefined = anonymous) */
  userId?: string;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  meta?: Record<string, unknown>;
  /** epoch ms when the socket opened (for `getClients` ordering/uptime) */
  connectedAt: number;
  /** drop-oldest backpressure queue (only non-empty while the socket is saturated) */
  queue?: RingBuffer<Uint8Array>;
  /** per-connection inbound rate limiter (lazily created on first frame) */
  rate?: import("./rate-limit").RateLimiter;
  /**
   * Next per-connection delivery seq to stamp (envelope v2). Starts at 1;
   * continues a previous session's stream when a grave is adopted.
   */
  sendSeq: number;
  /** bounded sent-frame history for gap recovery (lazily created, resume only) */
  history?: import("./ring").RingBuffer<import("./resume").SentFrame>;
}

/** Slow-consumer policy (see `IgnBackpressureOptions`). */
export type BackpressurePolicy = "drop-oldest" | "drop-newest" | "disconnect";

export interface IgnBackpressureOptions {
  /** per-socket buffered bytes that trigger backpressure, default 1 MiB */
  highWaterMark?: number;
  /** what to do with a slow consumer, default "drop-oldest" */
  policy?: BackpressurePolicy;
  /** max queued frames per slow socket (drop-oldest only), default 256 */
  maxQueue?: number;
}

export interface IgnServerOptions<B extends Bindings = DefaultBindings> {
  port: number;
  hostname?: string;
  /** seconds; 0 = no timeout */
  idleTimeout?: number;
  /** websocket path, default "/ws" */
  path?: string;
  /**
   * The wire stack (event ids, decoders, encoders). Defaults to the built-in
   * registry; pass your own (from `generateBindings` + `assembleBindings`) to
   * serve YOUR schema. When provided, the server API (`publish` / `on` / ...)
   * is typed against your `Events`.
   */
  bindings?: B;
  /** app events clients are ALLOWED to send; control events are always allowed. default [] */
  inbound?: EventNameOf<B>[];
  /** slow-consumer protection. default: off (unbounded buffering) */
  backpressure?: IgnBackpressureOptions;
  /**
   * Per-topic history for last-value snapshots on subscribe (and reconnect
   * replay). When set, every `publishToTopic` records an owned copy of the
   * frame (bounded to `historySize`), and a socket that joins the topic
   * immediately receives the recorded frames (oldest → newest) before live
   * traffic. Off by default to keep the hot path allocation-free.
   */
  replay?: { historySize?: number };
  /**
   * Gap-free delivery (envelope v2 seq + resume). When set, every frame sent
   * to a socket carries a per-connection delivery seq, the connection keeps a
   * bounded sent-history ring, and closed sessions park that ring in a
   * per-client-id graveyard so reconnects can resume missed frames.
   */
  resume?: { historySize?: number; ttlMs?: number };
  /**
   * Durable topic log behind the replay ring (`src/core/topic-log.ts`). When
   * set, every recorded topic frame is appended and `snapshotRequest`s older
   * than the ring hydrate from the log. Default: none (ring-only).
   */
  topicLog?: import("./topic-log").TopicLog;
  /**
   * Async auth hook run BEFORE the WebSocket upgrade. Return `false` to reject
   * the connection (401) — a hook that throws (or rejects) denies it too.
   * Return `true` to allow it (client gets an auto-
   * generated id), or a `ClientMeta` object to pin the client id / seed its
   * server-side groups / attach metadata. Inspect `req` as needed.
   */
  authenticate?: (req: Request) => boolean | ClientMeta | Promise<boolean | ClientMeta>;
  /** if set, only these exact `Origin` header values may connect (403 otherwise) */
  allowedOrigins?: string[];
  /**
   * Optional built-in bearer-token auth: either a literal token, or a
   * predicate `(token) => boolean` checking the `Authorization: Bearer` header.
   */
  token?: string | ((token: string) => boolean);
  /** maximum concurrent WebSocket clients (reject with 503 beyond) */
  maxConnections?: number;
  /** maximum inbound frame size in bytes (close 1009 beyond) */
  maxMessageSize?: number;
  /**
   * Per-connection inbound rate limiting (token bucket over ALL frames — app
   * AND control). Default: off (zero hot-path overhead). Over-limit frames are
   * dropped (default) or the socket is closed (`policy: "close"`, code 1008);
   * either way the event is counted in `metrics.rateLimited`.
   */
  rateLimit?: RateLimitOptions;
  /**
   * Authorize a client's topic (room) join — enforced for EVERY join path:
   * `subscribe` control frames, programmatic `server.join`, and auth-seeded
   * topics. Return false to reject (the frame/ call is ignored and counted in
   * `metrics.rejectedJoins`). Default: allow all.
   */
  authorizeTopic?: (topic: string, ws: ServerWebSocket<WsData>) => boolean;
  /** Authorize a server-side group join (same contract as `authorizeTopic`). */
  authorizeGroup?: (group: string, ws: ServerWebSocket<WsData>) => boolean;
  /**
   * Lossless-int64 guard for plain `number` int64 fields: values outside the
   * safe-integer range (±2^53-1) throw / warn at encode time (default "off" —
   * no overhead; the exact fix is `Type.Integer({ bigint: true })` fields).
   */
  int64Guard?: Int64GuardMode;
  /** Bun.serve TLS options (keyFile/certFile) — enables `wss://` */
  tls?: Bun.ServeOptions<unknown>["tls"];
  /**
   * Optional NATS bridge — either `NatsBridgeOptions` (a built-in bridge is
   * created eagerly and connects in the background) or a pre-built
   * `NatsBridge` (e.g. `createNatsBridge(opts, transport)` with a custom /
   * fake transport — handy for tests). Every broadcast / topic / group
   * publish is ALSO published (as the same FlatBuffer wire frame) to a NATS
   * subject for other applications, and (when `inbound` is set) NATS subjects
   * are forwarded to clients. Best-effort: the WS hot path never blocks on
   * NATS.
   */
  nats?: NatsBridgeOptions | NatsBridge;
  /**
   * Enable the events layer (typed event handlers + the global emit, client
   * records with per-connection data, groups, optional cluster sync). Exposed
   * as `server.events`; the module-global `emit`/`on` singleton
   * (`ignex-nova/events`) is bound by default.
   */
  events?: import("../events/types").EventsOptions<B>;
  /**
   * Event trace ring — records every fired event (emitted / published /
   * received) into a pre-allocated structure-of-arrays buffer so a debugger
   * (ignex debugbar, MCP) can see what fired without any hot-path allocation.
   * Default: on with capacity 1024; `IGNEX_NOVA_TRACE=0` disables globally.
   */
  trace?: EventTraceOptions;
  /** additional HTTP handler for non-ws routes (e.g. serving a static demo page) */
  fetch?: (req: Request) => Response | Promise<Response>;
}

type InboundHandler = (payload: unknown, ws: ServerWebSocket<WsData>) => void;

/** The full, explicit server state — created once per server, passed to actions. */
export interface ServerState {
  /** the wire stack this server speaks (ids / decoders / encoders). */
  bindings: Bindings;
  /** per-server encoder (scratch + FFI binding or pure-JS fallback). */
  transport: Transport;
  path: string;
  inbound: Set<string>;
  bp: Required<IgnBackpressureOptions> | null;
  metrics: Metrics;
  startedAt: number;
  authenticate?: (req: Request) => boolean | ClientMeta | Promise<boolean | ClientMeta>;
  allowedOrigins?: string[];
  token?: string | ((token: string) => boolean);
  maxConnections?: number;
  maxMessageSize?: number;
  rateLimit: ResolvedRateLimit | null;
  authorizeTopic?: (topic: string, ws: ServerWebSocket<WsData>) => boolean;
  authorizeGroup?: (group: string, ws: ServerWebSocket<WsData>) => boolean;
  replay: { historySize: number } | null;
  resume: { historySize: number; ttlMs: number } | null;
  sockets: Set<ServerWebSocket<WsData>>;
  /** id → live socket (client registry for targeted sends / introspection) */
  clients: Map<string, ServerWebSocket<WsData>>;
  rooms: Map<string, Set<ServerWebSocket<WsData>>>;
  /** group → member sockets (server-side targeting dimension, no replay) */
  groups: Map<string, Set<ServerWebSocket<WsData>>>;
  /** optional NATS bridge (wired in createServer when `options.nats` is set) */
  bridge?: NatsBridge;
  inboundHandlers: Map<string, InboundHandler>;
  topicHistory: Map<string, RingBuffer<{ seq: number; frame: Uint8Array }>>;
  replaySeq: number;
  /** optional durable topic log (wired in createServer when `options.topicLog` is set) */
  topicLog?: import("./topic-log").TopicLog;
  /**
   * Responder registry for request/response (`rpcCall` control frames):
   * inner event name → async responder. Registered via `server.handle` /
   * `hub.onRequest`.
   */
  rpcHandlers: Map<string, (payload: unknown, ws: ServerWebSocket<WsData>) => Promise<unknown>>;
  /** parked sent-history rings of closed sessions (cross-connection resume) */
  graves: Map<string, { history: RingBuffer<import("./resume").SentFrame>; nextSeq: number; expiresAt: number }>;
  /** events-layer lifecycle hooks (wired by createServer when `events` is set) */
  onConnect?: (ws: ServerWebSocket<WsData>) => void;
  onDisconnect?: (ws: ServerWebSocket<WsData>) => void;
  /** fired on ANY group membership change (auth seed, control frames, programmatic) */
  onGroupChange?: (group: string, ws: ServerWebSocket<WsData>, joined: boolean) => void;
  /** event trace ring (debugger visibility; pre-allocated, zero-GC writes) */
  trace: EventTrace;
}

export function createServerState<B extends Bindings = DefaultBindings>(
  options: IgnServerOptions<B>,
): ServerState {
  const bindings = options.bindings ?? defaultBindings;
  return {
    bindings,
    transport: bindings === defaultBindings ? defaultTransport : createTransport(bindings),
    path: options.path ?? "/ws",
    inbound: new Set(options.inbound ?? []),
    bp: options.backpressure
      ? {
          highWaterMark: options.backpressure.highWaterMark ?? 1024 * 1024,
          policy: options.backpressure.policy ?? "drop-oldest",
          maxQueue: options.backpressure.maxQueue ?? 256,
        }
      : null,
    metrics: createMetrics(),
    startedAt: Date.now(),
    ...(options.authenticate !== undefined ? { authenticate: options.authenticate } : {}),
    ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    ...(options.maxMessageSize !== undefined ? { maxMessageSize: options.maxMessageSize } : {}),
    rateLimit: resolveRateLimit(options.rateLimit),
    ...(options.authorizeTopic !== undefined ? { authorizeTopic: options.authorizeTopic } : {}),
    ...(options.authorizeGroup !== undefined ? { authorizeGroup: options.authorizeGroup } : {}),
    ...(options.topicLog !== undefined ? { topicLog: options.topicLog } : {}),
    replay: options.replay ? { historySize: options.replay.historySize ?? 64 } : null,
    resume: options.resume ? { historySize: options.resume.historySize ?? 256, ttlMs: options.resume.ttlMs ?? 60_000 } : null,
    sockets: new Set(),
    clients: new Map(),
    rooms: new Map(),
    groups: new Map(),
    inboundHandlers: new Map(),
    topicHistory: new Map(),
    replaySeq: 0,
    rpcHandlers: new Map(),
    graves: new Map(),
    trace: createEventTrace(options.trace),
  };
}
