/**
 * Server composition root — wires `createServerState` + the action modules
 * (auth / rooms / outbound / routing) into `Bun.serve`, and returns a plain
 * `IgnServer` API object (no class, no `this`). This is the ONLY place that
 * knows how the pieces fit together; each concern lives in its own module:
 *
 *   client-info.ts       — ClientInfo snapshot type + pure mapper
 *   http-routes.ts       — fetch handler (health / clients / fallback)
 *   socket-lifecycle.ts  — open/close handlers as `(state, ws)` actions
 *   metrics-view.ts      — pure MetricsSnapshot assembly
 *
 * Generic over the wire stack: `createServer({ bindings })` with your own
 * generated bindings types `publish` / `on` / ... against YOUR events. The
 * default is the built-in registry, so existing code keeps working unchanged.
 *
 * Public entry: `public/server.ts` re-exports `createServer` + the types.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../../bindings/types";
import { createNatsBridge } from "../../bridge/nats";
import { createEventsHub, type EventsHubInternal } from "../../events/hub";
import type {
  EventTraceRow,
  EventTraceStats,
  TraceQueryOptions,
} from "../../events/trace";
import { joinGroup as addToGroup } from "../groups";
import { setInt64GuardMode } from "../int64-guard";
import type { MetricsSnapshot } from "../metrics";
import { drainSocket, sendFrame } from "../outbound";
import {
  activeGroups,
  groupMembers as groupMemberIds,
  publishToGroup as publishToGroupState,
  leaveGroup as removeFromGroup,
} from "../groups";
import { joinRoom, leaveRoom, publishToRoom, roomTopics } from "../rooms";
import { handleMessage } from "../routing";
import { createServerState, type IgnServerOptions, type WsData } from "../state";
import { toClientInfo, type ClientInfo } from "./client-info";
import { handleHttpRequest } from "./http-routes";
import { buildServerMetrics } from "./metrics-view";
import { onSocketClose, onSocketOpen } from "./socket-lifecycle";

export type { ClientInfo } from "./client-info";

/** The public server API (returned by `createServer`). */
export interface IgnServer<B extends Bindings = DefaultBindings> {
  readonly port: number;
  readonly clientCount: number;
  getMetrics(): MetricsSnapshot;
  /** Broadcast a typed event to every connected client (zero-alloc on the happy path). */
  publish<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
  /** Send a typed event to a single socket (zero-alloc on the happy path). */
  publishTo<K extends EventNameOf<B>>(
    ws: ServerWebSocket<WsData>,
    name: K,
    payload: EventsOf<B>[K],
  ): void;
  /** Publish a typed event to every socket subscribed to `topic`. */
  publishToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
  /** Send a typed event to a specific client by id. Returns false if that client is offline. */
  publishToClient<K extends EventNameOf<B>>(id: string, name: K, payload: EventsOf<B>[K]): boolean;
  /**
   * Allow clients to send `name` (adds it to the inbound allowlist at runtime).
   * The events layer calls this automatically when `server.events.on(name)` is
   * first used.
   */
  allowInbound<K extends EventNameOf<B>>(name: K): IgnServer<B>;
  /** Programmatic room membership (clients can also join via subscribe frames). */
  join(topic: string, ws: ServerWebSocket<WsData>): void;
  leave(topic: string, ws: ServerWebSocket<WsData>): void;
  /** Live topic names (with at least one subscriber). */
  topics(): string[];
  /** Server-side group membership (targeted fan-out, no replay). */
  joinGroup(id: string, group: string): void;
  leaveGroup(id: string, group: string): void;
  /** Publish a typed event to every client in a server-side group. */
  publishToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  /** Live server-side group names (with at least one member). */
  groups(): string[];
  /** Client ids currently in `group`. */
  groupMembers(group: string): string[];
  /** Groups a client belongs to ([] if offline/unknown). */
  clientGroups(id: string): string[];
  /** Active-client introspection. */
  getClient(id: string): ClientInfo | undefined;
  getClients(): ClientInfo[];
  /** Force-close a specific client socket (e.g. from a policy / admin action). */
  closeClient(ws: ServerWebSocket<WsData>): void;
  /** Disconnect a client by id. Returns false if that client is offline. */
  disconnectClient(id: string): boolean;
  /** Register a handler for an inbound app event (must be in `options.inbound`). */
  on<K extends EventNameOf<B>>(
    name: K,
    handler: (payload: EventsOf<B>[K], ws: ServerWebSocket<WsData>) => void,
  ): IgnServer<B>;
  off<K extends EventNameOf<B>>(name: K): IgnServer<B>;
  /**
   * Register a request/response responder for `name`: clients call it via
   * `client.request(name, payload)` and receive the returned payload (encoded
   * with the SAME event schema). Request/response share the event's schema.
   */
  handle<K extends EventNameOf<B>>(
    name: K,
    responder: (payload: EventsOf<B>[K], ws: ServerWebSocket<WsData>) => Promise<EventsOf<B>[K]> | EventsOf<B>[K],
  ): IgnServer<B>;
  /**
   * The event trace ring — what fired recently (emitted / published /
   * received), with per-event aggregates. Debugger-facing (ignex debugbar,
   * MCP); rows are materialized on read only.
   */
  getEventTrace(options?: TraceQueryOptions): {
    enabled: boolean;
    capacity: number;
    stats: EventTraceStats;
    recent: EventTraceRow[];
  };
  /** Drop all retained trace records (counters survive). */
  clearEventTrace(): void;
  /**
   * The events hub — present when `createServer({ events: {...} })` is used:
   * typed handlers (`server.events.on`), client records, groups, and the
   * cluster-aware emit surface.
   */
  readonly events: import("../../events/types").EventsHub<B> | undefined;
  /** Graceful drain: stop accepting, wait up to `timeoutMs` for queues to flush. */
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
}

export function createServer<B extends Bindings = DefaultBindings>(
  options: IgnServerOptions<B>,
): IgnServer<B> {
  const state = createServerState(options);
  setInt64GuardMode(options.int64Guard ?? "off");
  const bindings = state.bindings;
  const trace = state.trace; // hot-path local (one property load, ever)

  // NATS bridge (optional, best-effort — created eagerly, connects in the background)
  const natsOpt = options.nats;
  if (natsOpt)
    // discriminate on `subjects` (bridge-only surface): both bridges AND raw
    // transports have `publish`, so a publish-based probe misclassifies
    state.bridge = "subjects" in natsOpt ? natsOpt : createNatsBridge(natsOpt, undefined, bindings);

  // Encode once. EXTERNAL copies (NATS bridge / cluster envelope) are taken
  // BEFORE any per-socket delivery-seq stamping mutates the scratch header —
  // external consumers must see pristine frames.

  /** Encode + count + trace a broadcast frame (no delivery yet). */
  function fanOutAll(name: string, payload: unknown): Uint8Array {
    const frame = state.transport.encodeToScratch(name, payload);
    state.metrics.published++;
    trace.record("out.publish", name, "broadcast", undefined, frame.byteLength);
    return frame;
  }

  /** Deliver an already-encoded frame to every connected socket. */
  function fanOutAllLocal(frame: Uint8Array): void {
    for (const ws of state.sockets) sendFrame(state, ws, frame);
  }

  let eventsHub: EventsHubInternal<B> | undefined;

  if (state.bridge) {
    state.bridge.setOnInbound((name, payload) => {
      // trace: the event ARRIVED from the bridge, then is fanned out locally
      // by fanOutAll below (which records its own out.publish row).
      const id = bindings.anyEventNameToId[name];
      if (id !== undefined) trace.record("in.bridge", name, undefined, undefined, 0);
      const frame = fanOutAll(name, payload);
      fanOutAllLocal(frame);
      // server-side handling of externally-published events (the events layer)
      eventsHub?.dispatchBridgeInbound(name, payload);
    });
  }

  const bun = Bun.serve<WsData>({
    port: options.port,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    idleTimeout: options.idleTimeout ?? 30,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    fetch: (req, srv) => handleHttpRequest(state, req, srv, options.fetch),
    websocket: {
      open: (ws) => onSocketOpen(state, ws),
      close: (ws) => onSocketClose(state, ws),
      message: (ws, msg) => handleMessage(state, ws, msg),
      drain: (ws) => drainSocket(state, ws),
    },
  });

  // ── publish actions (encode once → bridge copy → local fan-out) ──────

  const api: IgnServer<B> = {
    get port(): number {
      return bun.port ?? 0;
    },
    get clientCount(): number {
      return state.sockets.size;
    },
    getMetrics(): MetricsSnapshot {
      return buildServerMetrics(state, eventsHub?.metrics());
    },
    getEventTrace(options?: TraceQueryOptions) {
      return {
        enabled: state.trace.enabled,
        capacity: state.trace.capacity,
        stats: state.trace.stats(),
        recent: state.trace.recent(options),
      };
    },
    clearEventTrace() {
      state.trace.clear();
    },
    publish(name, payload) {
      const frame = fanOutAll(name, payload);
      // pristine frame out FIRST (bridge copies), then seq-stamped local sends
      state.bridge?.publish(state.bridge.subjects.broadcast(name), frame);
      fanOutAllLocal(frame);
    },
    publishTo(ws, name, payload) {
      state.metrics.published++;
      const frame = state.transport.encodeToScratch(name, payload);
      trace.record("out.publish", name, "client", ws.data.id, frame.byteLength);
      sendFrame(state, ws, frame);
    },
    publishToTopic(topic, name, payload) {
      const frame = state.transport.encodeToScratch(name, payload);
      state.metrics.published++;
      trace.record("out.publish", name, "topic", topic, frame.byteLength);
      state.bridge?.publish(state.bridge.subjects.topic(topic, name), frame);
      publishToRoom(state, topic, frame);
    },
    publishToClient(id, name, payload) {
      const ws = state.clients.get(id);
      if (!ws) return false;
      state.metrics.published++;
      const frame = state.transport.encodeToScratch(name, payload);
      trace.record("out.publish", name, "client", id, frame.byteLength);
      sendFrame(state, ws, frame);
      return true;
    },
    allowInbound(name) {
      state.inbound.add(name);
      return api;
    },
    join(topic, ws) {
      joinRoom(state, ws, topic);
    },
    leave(topic, ws) {
      leaveRoom(state, ws, topic);
    },
    topics() {
      return roomTopics(state);
    },
    joinGroup(id, group) {
      const ws = state.clients.get(id);
      if (ws) addToGroup(state, ws, group);
    },
    leaveGroup(id, group) {
      const ws = state.clients.get(id);
      if (ws) removeFromGroup(state, ws, group);
    },
    publishToGroup(group, name, payload) {
      const frame = state.transport.encodeToScratch(name, payload);
      state.metrics.published++;
      trace.record("out.publish", name, "group", group, frame.byteLength);
      state.bridge?.publish(state.bridge.subjects.group(group, name), frame);
      publishToGroupState(state, group, frame);
    },
    groups() {
      return activeGroups(state);
    },
    groupMembers(group) {
      return groupMemberIds(state, group);
    },
    clientGroups(id) {
      const ws = state.clients.get(id);
      return ws ? [...ws.data.groups] : [];
    },
    getClient(id) {
      const ws = state.clients.get(id);
      return ws ? toClientInfo(ws) : undefined;
    },
    getClients() {
      return [...state.clients.values()].map(toClientInfo);
    },
    closeClient(ws) {
      ws.close(1000, "closed by server");
    },
    disconnectClient(id) {
      const ws = state.clients.get(id);
      if (!ws) return false;
      ws.close(1000, "closed by server");
      return true;
    },
    on(name, handler) {
      state.inboundHandlers.set(
        name,
        handler as (payload: unknown, ws: ServerWebSocket<WsData>) => void,
      );
      return api;
    },
    off(name) {
      state.inboundHandlers.delete(name);
      return api;
    },
    handle(name, responder) {
      state.rpcHandlers.set(
        name,
        responder as (
          payload: unknown,
          ws: ServerWebSocket<WsData>,
        ) => Promise<unknown>,
      );
      return api;
    },
    get events() {
      return eventsHub;
    },
    async drain(timeoutMs = 2000): Promise<void> {
      bun.stop(false); // stop listening; keep active sockets draining
      await eventsHub?.close();
      await state.bridge?.close();
      const deadline = Date.now() + timeoutMs;
      while (state.sockets.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      bun.stop(true);
    },
    stop(force = true): void {
      bun.stop(force);
      void eventsHub?.close();
      void state.bridge?.close();
    },
  };

  // ── events layer (opt-in) ────────────────────────────────────────────
  if (options.events) {
    eventsHub = createEventsHub({
      state,
      server: api,
      bindings,
      ...(state.bridge !== undefined ? { serverBridge: state.bridge } : {}),
      options: options.events,
    });
    state.onConnect = (ws) => {
      eventsHub!.attach(ws);
    };
    state.onDisconnect = (ws) => {
      eventsHub!.detach(ws);
    };
    state.onGroupChange = (group, ws, joined) => {
      eventsHub!.onGroupChange(group, ws, joined);
    };
  }

  return api;
}
