/**
 * Server composition root — wires `createServerState` + the action modules
 * (auth / rooms / outbound / routing) into `Bun.serve`, and returns a plain
 * `IgnServer` API object (no class, no `this`). This is the ONLY place that
 * knows how the pieces fit together.
 *
 * Public entry: `public/server.ts` re-exports `createServer` + the types.
 */
import type { ServerWebSocket } from "bun";
import { WIRE_VERSION } from "../generated/registry";
import type { Events, EventName } from "../schema";
import { getEncodeStats, encodeToScratch } from "../transport/transport";
import { setInt64GuardMode } from "./int64-guard";
import type { MetricsSnapshot } from "./metrics";
import { checkUpgrade } from "./auth";
import { drainSocket, sendControl, sendFrame } from "./outbound";
import { handleMessage } from "./routing";
import { joinRoom, leaveRoom, publishToRoom, roomTopics } from "./rooms";
import {
  activeGroups,
  groupMembers as groupMemberIds,
  joinGroup as addToGroup,
  leaveGroup as removeFromGroup,
  publishToGroup as publishToGroupState,
} from "./groups";
import { createServerState, type IgnServerOptions, type WsData } from "./state";
import { createNatsBridge } from "../bridge/nats";

/** A snapshot of an active client (from `getClient` / `getClients` / GET /clients). */
export interface ClientInfo {
  id: string;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  meta?: Record<string, unknown>;
  /** server-side groups this client belongs to */
  groups: string[];
  /** topics/rooms this client has joined */
  topics: string[];
  /** epoch ms the socket connected */
  connectedAt: number;
  /** remote IP (from the socket) */
  ip: string;
}

function toClientInfo(ws: ServerWebSocket<WsData>): ClientInfo {
  return {
    id: ws.data.id,
    meta: ws.data.meta,
    groups: [...ws.data.groups],
    topics: [...ws.data.topics],
    connectedAt: ws.data.connectedAt,
    ip: ws.remoteAddress,
  };
}

/** The public server API (returned by `createServer`). */
export interface IgnServer {
  readonly port: number;
  readonly clientCount: number;
  getMetrics(): MetricsSnapshot;
  /** Broadcast a typed event to every connected client (zero-alloc on the happy path). */
  publish<K extends EventName>(name: K, payload: Events[K]): void;
  /** Send a typed event to a single socket (zero-alloc on the happy path). */
  publishTo<K extends EventName>(ws: ServerWebSocket<WsData>, name: K, payload: Events[K]): void;
  /** Publish a typed event to every socket subscribed to `topic`. */
  publishToTopic<K extends EventName>(topic: string, name: K, payload: Events[K]): void;
  /** Send a typed event to a specific client by id. Returns false if that client is offline. */
  publishToClient<K extends EventName>(id: string, name: K, payload: Events[K]): boolean;
  /** Programmatic room membership (clients can also join via subscribe frames). */
  join(topic: string, ws: ServerWebSocket<WsData>): void;
  leave(topic: string, ws: ServerWebSocket<WsData>): void;
  /** Live topic names (with at least one subscriber). */
  topics(): string[];
  /** Server-side group membership (targeted fan-out, no replay). */
  joinGroup(id: string, group: string): void;
  leaveGroup(id: string, group: string): void;
  /** Publish a typed event to every client in a server-side group. */
  publishToGroup<K extends EventName>(group: string, name: K, payload: Events[K]): void;
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
  on<K extends EventName>(name: K, handler: (payload: Events[K], ws: ServerWebSocket<WsData>) => void): IgnServer;
  off<K extends EventName>(name: K): IgnServer;
  /** Graceful drain: stop accepting, wait up to `timeoutMs` for queues to flush. */
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
}

export function createServer(options: IgnServerOptions): IgnServer {
  const state = createServerState(options);
  setInt64GuardMode(options.int64Guard ?? "off");

  // NATS bridge (optional, best-effort — created eagerly, connects in the background)
  const natsOpt = options.nats;
  if (natsOpt) state.bridge = "publish" in natsOpt ? natsOpt : createNatsBridge(natsOpt);

  // Encode once + broadcast to every connected client (NO bridge) — the shared
  // hot path for `publish` and NATS-inbound forwarding. Loop prevention: inbound
  // events reach clients but are never re-bridged to NATS.
  function fanOutAll(name: Parameters<typeof encodeToScratch>[0], payload: unknown): Uint8Array {
    const frame = encodeToScratch(name, payload);
    state.metrics.published++;
    for (const ws of state.sockets) sendFrame(state, ws, frame);
    return frame;
  }

  if (state.bridge) {
    state.bridge.setOnInbound((name, payload) => {
      fanOutAll(name, payload);
    });
  }

  const bun = Bun.serve<WsData>({
    port: options.port,
    hostname: options.hostname,
    idleTimeout: options.idleTimeout ?? 30,
    tls: options.tls,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === state.path) return checkUpgrade(state, req, srv);
      if (url.pathname === "/health") {
        const h = state.metrics.snapshot(state.sockets.size);
        return new Response(
          JSON.stringify({ status: "ok", clients: h.connectedClients, uptimeMs: h.uptimeMs }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/clients") {
        return new Response(JSON.stringify([...state.clients.values()].map(toClientInfo)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (options.fetch) return options.fetch(req);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        state.sockets.add(ws);
        // belt-and-suspenders: an auth race could double-register an id — kick the stale session
        const existing = state.clients.get(ws.data.id);
        if (existing && existing !== ws) existing.close(1000, "replaced by newer session");
        state.clients.set(ws.data.id, ws);
        for (const g of ws.data.groups) addToGroup(state, ws, g);
        // announce our wire version + capabilities so clients can negotiate
        sendControl(state, ws, "hello", { version: WIRE_VERSION, caps: [], lastSeq: 0 });
        // then assign identity so the client knows its id + server-side groups
        sendControl(state, ws, "welcome", { clientId: ws.data.id, groups: [...ws.data.groups] });
      },
      close: (ws) => {
        state.sockets.delete(ws);
        state.clients.delete(ws.data.id);
        for (const g of ws.data.groups) removeFromGroup(state, ws, g);
        ws.data.groups.clear();
        for (const t of ws.data.topics) leaveRoom(state, ws, t);
        ws.data.topics.clear();
        delete ws.data.queue;
      },
      message: (ws, msg) => handleMessage(state, ws, msg),
      drain: (ws) => drainSocket(state, ws),
    },
  });

  const api: IgnServer = {
    get port(): number {
      return bun.port ?? 0;
    },
    get clientCount(): number {
      return state.sockets.size;
    },
    getMetrics(): MetricsSnapshot {
      const stats = getEncodeStats();
      for (const [name, n] of Object.entries(stats.direct)) {
        if (n > 0) state.metrics.countPath(name, "direct");
      }
      for (const [name, n] of Object.entries(stats.json)) {
        if (n > 0) state.metrics.countPath(name, "json");
      }
      const snapshot = state.metrics.snapshot(state.sockets.size);
      const b = state.bridge;
      if (b) {
        snapshot.bridged = b.stats.bridged;
        snapshot.bridgedBytes = b.stats.bridgedBytes;
        snapshot.bridgeErrors = b.stats.bridgeErrors;
        snapshot.bridgeInbound = b.stats.bridgeInbound;
        snapshot.bridgeInboundErrors = b.stats.bridgeInboundErrors;
        snapshot.natsStatus = b.status;
      }
      return snapshot;
    },
    publish(name, payload) {
      const frame = fanOutAll(name, payload);
      state.bridge?.publish(state.bridge.subjects.broadcast(name), frame);
    },
    publishTo(ws, name, payload) {
      state.metrics.published++;
      sendFrame(state, ws, encodeToScratch(name, payload));
    },
    publishToTopic(topic, name, payload) {
      const frame = encodeToScratch(name, payload);
      state.metrics.published++;
      publishToRoom(state, topic, frame);
      state.bridge?.publish(state.bridge.subjects.topic(topic, name), frame);
    },
    publishToClient(id, name, payload) {
      const ws = state.clients.get(id);
      if (!ws) return false;
      state.metrics.published++;
      sendFrame(state, ws, encodeToScratch(name, payload));
      return true;
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
      const frame = encodeToScratch(name, payload);
      state.metrics.published++;
      publishToGroupState(state, group, frame);
      state.bridge?.publish(state.bridge.subjects.group(group, name), frame);
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
      state.inboundHandlers.set(name, handler as (payload: unknown, ws: ServerWebSocket<WsData>) => void);
      return api;
    },
    off(name) {
      state.inboundHandlers.delete(name);
      return api;
    },
    async drain(timeoutMs = 2000): Promise<void> {
      bun.stop(false); // stop listening; keep active sockets draining
      await state.bridge?.close();
      const deadline = Date.now() + timeoutMs;
      while (state.sockets.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      bun.stop(true);
    },
    stop(force = true): void {
      bun.stop(force);
      void state.bridge?.close();
    },
  };

  return api;
}
