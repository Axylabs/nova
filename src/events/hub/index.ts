/**
 * Events hub — composition root for the events layer. Created by
 * `createServer({ events: {...} })` (exposed as `server.events`) and, by
 * default, bound to the module-global `emit` / `on` singleton.
 *
 * Wires the pieces together (each lives in its own module):
 *   - `clients` (`../clients`) — the active-connection registry (who is
 *     connected, on whose behalf, per-connection data);
 *   - `registry` (`../registry`) — multi-handler dispatch;
 *   - `dispatcher` (`./dispatch`) — reliability-aware dispatch (retry + DLQ
 *     when configured, plain fire-and-forget otherwise);
 *   - `emitter` (`../emit`) — encode-once + local fan-out + bridge +
 *     offloaded cluster publish;
 *   - `groups` (`../groups`) — client groups and user groups;
 *   - `cluster` (`../cluster`) — optional cross-instance sync with presence,
 *     all off the hot path via the offload queue;
 *   - `contexts` (`./context-factory`) — cached handler contexts;
 *   - `scheduler` (`../schedule`) — time-based emits;
 *   - `clusterRpc` (`../cluster-rpc`) — cross-instance request/response.
 *
 * Lifecycle is driven by the server: `attach`/`detach` on socket open/close,
 * `onGroupChange` on any group mutation (auth seed, control frames,
 * programmatic), `dispatchBridgeInbound` for NATS-inbound events.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf } from "../../bindings/types";
import type { NatsBridge } from "../../bridge/nats";
import type { IgnServer } from "../../core/server";
import type { WsData } from "../../core/state";
import { createClientStore } from "../clients";
import {
  createClusterSync,
  createMemoryStateStore,
  type ClusterSync,
} from "../cluster";
import { createClusterRpc, type ClusterRpc } from "../cluster-rpc";
import { createEmitter, deliverLocal, type EmitCounters } from "../emit";
import { bindEvents, unbindEvents } from "../global";
import { createGroupManager, type GroupManager } from "../groups";
import { createTaskQueue } from "../queue";
import { createHandlerRegistry, type HandlerRegistry } from "../registry";
import { createScheduler, type Scheduler } from "../schedule";
import type {
  ClusterStateStore,
  ClusterTransport,
  EmitTarget,
  EventClient,
  EventContext,
  EventsOptions,
} from "../types";
import { createContextFactory, type ContextFactory } from "./context-factory";
import { createDispatcher, resolveDispatchPolicy, type Dispatcher } from "./dispatch";
import type { CreateEventsHubOptions, EventsHubInternal } from "./internal";
import { buildMetricsSnapshot } from "./metrics-snapshot";
import { resolveClusterTransport } from "./resolve-cluster";

export type { CreateEventsHubOptions, EventsHubInternal } from "./internal";

/** Fresh zeroed emit counters (one per hub). */
const zeroCounters = (): EmitCounters => ({
  emitted: 0,
  emittedByTarget: { broadcast: 0, topic: 0, group: 0, user: 0, client: 0 },
  deliveredLocal: 0,
  clusterPublished: 0,
  clusterRouted: 0,
});

/** Queue options come in sparse — normalize to the factory's full form. */
const resolveQueueOpts = (
  queue: EventsOptions<never>["queue"],
): { workers?: number; maxPending?: number } => ({
  ...(queue?.workers !== undefined ? { workers: queue.workers } : {}),
  ...(queue?.maxPending !== undefined ? { maxPending: queue.maxPending } : {}),
});

/** `{ id, userId? }` projection used for cluster presence announcements. */
const clientIdentity = (c: EventClient): { id: string; userId?: string } => ({
  id: c.id,
  ...(c.userId !== undefined ? { userId: c.userId } : {}),
});

/** Map a remote envelope kind/key pair onto a local emit target. */
const targetFromRemote = (kind: string, key: string): EmitTarget => {
  switch (kind) {
    case "broadcast":
      return { type: "broadcast" };
    case "topic":
      return { type: "topic", topic: key };
    case "group":
      return { type: "group", group: key };
    case "user":
      return { type: "user", userId: key };
    default:
      return { type: "client", clientId: key };
  }
};

/**
 * ROUTED targeted delivery helper: for client/user targets return the owning
 * instance ids via presence ([] → null so callers fall back to full mesh).
 */
const makeRouteInstances =
  (cluster: ClusterSync) =>
  (target: EmitTarget): readonly string[] | null => {
    const owned = (instances: string[]): readonly string[] | null =>
      instances.length > 0 ? instances : null;
    if (target.type === "client") return owned(cluster.instancesForClient(target.clientId));
    if (target.type === "user") return owned(cluster.instancesForUser(target.userId));
    return null;
  };

export function createEventsHub<B extends Bindings = DefaultBindings>(
  opts: CreateEventsHubOptions<B>,
): EventsHubInternal<B> {
  const { state, server, bindings, serverBridge } = opts;
  const eOpts = opts.options;

  // ── identity + infrastructure ─────────────────────────────────────────
  const instanceId = eOpts.cluster?.instanceId ?? crypto.randomUUID();
  const prefix = eOpts.cluster?.prefix ?? bindings.subjectPrefix ?? "ignex";
  const queue = createTaskQueue(resolveQueueOpts(eOpts.queue));
  const counters: EmitCounters = zeroCounters();

  let closed = false;
  let boundGlobal = false;
  let transportErrors = 0;

  const reportClusterError = (err: Error): void => {
    transportErrors++;
    void err;
  };

  // ── handler registry + reliable dispatch ──────────────────────────────
  const registry: HandlerRegistry & { settleDispatch: HandlerRegistry["settleDispatch"] } =
    createHandlerRegistry();
  // reliability counters (retries + dead letters), folded into metrics
  const dispatchCounters = { handlerRetries: 0, dlqCount: 0 };
  const dispatcher: Dispatcher<B> = createDispatcher<B>({
    registry,
    policy: resolveDispatchPolicy(eOpts.handlers, dispatchCounters),
    counters: dispatchCounters,
  });

  // ── client store ──────────────────────────────────────────────────────
  const clients = createClientStore();
  /** Callback-style user targeting — no intermediate array per emit (zero alloc). */
  const eachUserSocket = (
    userId: string,
    each: (ws: ServerWebSocket<WsData>) => void,
  ): number =>
    clients.forEachByUser(userId, (client) => {
      each(client.ws);
    });

  // ── contexts ──────────────────────────────────────────────────────────
  const contexts: ContextFactory<B> = createContextFactory<B>({
    server,
    getHub: () => api,
  });

  // ── inbound dispatch (client-sent events → handlers) ──────────────────
  const dispatchers = new Set<string>();

  const dispatchClientEvent = (
    name: string,
    payload: unknown,
    ws: ServerWebSocket<WsData>,
  ): void => {
    const client = clients.get(ws.data.id) ?? attach(ws);
    dispatcher.client(name, payload, contexts.make(client, "client"));
  };

  const ensureDispatcher = (name: string): void => {
    if (dispatchers.has(name)) return;
    dispatchers.add(name);
    server.allowInbound(name as never);
    server.on(
      name as never,
      ((payload: unknown, ws: ServerWebSocket<WsData>) =>
        dispatchClientEvent(name, payload, ws)) as never,
    );
  };

  // ── cluster (optional) ────────────────────────────────────────────────
  let cluster: ClusterSync | undefined;
  let ownBridge: NatsBridge | undefined;
  let stateStore: ClusterStateStore | undefined;
  let clusterTransportRef: ClusterTransport | undefined;
  if (eOpts.cluster) {
    const resolved = resolveClusterTransport(
      eOpts.cluster,
      serverBridge,
      bindings,
      reportClusterError,
    );
    if (!resolved.transport) {
      throw new Error(
        "ignex events: cluster configured without a transport — set cluster.nats, cluster.redis, or cluster.transport",
      );
    }
    ownBridge = resolved.ownBridge;
    clusterTransportRef = resolved.transport;
    stateStore = eOpts.cluster.state ?? createMemoryStateStore();
    cluster = createClusterSync({
      instanceId,
      prefix,
      transport: resolved.transport,
      queue,
      bindings,
      stateStore,
      presenceTtlMs: eOpts.cluster.presenceTtlMs ?? 60_000,
      heartbeatMs: eOpts.cluster.heartbeatMs ?? 15_000,
      onRemoteFrame: (kind, key, name, frame, meta) => {
        // trace: the frame ARRIVED from another instance — record it before
        // local delivery so the debugger sees remote-originated events too.
        state.trace.record("in.remote", name, undefined, undefined, frame.byteLength);
        counters.deliveredLocal += deliverLocal(
          state,
          targetFromRemote(kind, key),
          frame,
          eachUserSocket,
        );
        deliverRemoteServerEvent(name, frame, meta.traceId);
      },
      onError: reportClusterError,
    });
  }

  /**
   * Deliver a remote event to local server-event handlers. The producer's
   * trace id propagates into the remote context via an ephemeral spread —
   * only when one actually rides along.
   */
  const deliverRemoteServerEvent = (
    name: string,
    frame: Uint8Array,
    traceId: string,
  ): void => {
    if (!registry.wantsServerEvent(name)) return;
    const id = bindings.anyEventNameToId[name];
    if (id === undefined) return;
    try {
      const baseCtx = contexts.make(undefined, "remote");
      const ctx = traceId !== "" ? ({ ...baseCtx, traceId } as EventContext<B>) : baseCtx;
      dispatcher.server(name, bindings.decodePayload(id, frame), ctx);
    } catch (err) {
      reportClusterError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // ── emitter ───────────────────────────────────────────────────────────
  const emitter = createEmitter({
    state,
    ...(serverBridge !== undefined ? { bridge: serverBridge } : {}),
    ...(cluster !== undefined
      ? { cluster, routeInstances: makeRouteInstances(cluster) }
      : {}),
    eachUserSocket,
    counters,
  });

  // ── cross-instance rpc ────────────────────────────────────────────────
  const clusterRpc: ClusterRpc | undefined =
    cluster !== undefined && clusterTransportRef !== undefined
      ? createClusterRpc({ instanceId, prefix, transport: clusterTransportRef })
      : undefined;

  // ── scheduled emits ───────────────────────────────────────────────────
  const scheduler: Scheduler = createScheduler((name, payload, target) => {
    api.emit(name as never, payload as never, target as EmitTarget | undefined);
  });

  // ── groups ────────────────────────────────────────────────────────────
  const groups: GroupManager<B> = createGroupManager<B>({
    state,
    emitToGroup: (group, name, payload) => api.emitToGroup(group, name as never, payload as never),
    emitToUser: (userId, name, payload) => api.emitToUser(userId, name as never, payload as never),
    onUserGroupChange: (name, members) => cluster?.userGroupChanged(name, members),
  });

  // ── client lifecycle (events-layer view of socket open/close) ─────────
  const attach = (ws: ServerWebSocket<WsData>): EventClient | undefined => {
    const client = clients.attach(ws);
    if (!client) return undefined;
    cluster?.clientJoined(clientIdentity(client));
    eOpts.onConnect?.(client);
    return client;
  };

  const detach = (ws: ServerWebSocket<WsData>): EventClient | undefined => {
    const client = clients.detach(ws);
    if (!client) return undefined;
    cluster?.clientLeft(clientIdentity(client));
    eOpts.onDisconnect?.(client);
    return client;
  };

  const onGroupChange = (group: string, ws: ServerWebSocket<WsData>, joined: boolean): void => {
    cluster?.clientGroupChanged(group, ws.data.id, joined);
  };

  // ── the hub API ───────────────────────────────────────────────────────
  const api: EventsHubInternal<B> = {
    get server(): IgnServer<B> {
      return server;
    },
    get instanceId(): string {
      return instanceId;
    },

    // ── receiving events ────────────────────────────────────────────────
    on(name, handler) {
      ensureDispatcher(name);
      registry.on(name, handler as never);
      return api;
    },
    off(name, handler) {
      registry.off(name, handler as never);
      return api;
    },
    once(name, handler) {
      ensureDispatcher(name);
      registry.once(name, handler as never);
      return api;
    },
    onAny(cb) {
      registry.onAny(cb as never);
      return api;
    },
    offAny(cb) {
      registry.offAny(cb as never);
      return api;
    },
    onServerEvent(name, handler) {
      registry.onServerEvent(name, handler as never);
      return api;
    },
    offServerEvent(name, handler) {
      registry.offServerEvent(name, handler as never);
      return api;
    },
    events() {
      return registry.names() as EventNameOf<B>[];
    },
    listenerCount(name) {
      return registry.count(name);
    },
    removeAllListeners(name) {
      registry.removeAll(name);
      return api;
    },

    // ── emitting events (cluster-aware) ─────────────────────────────────
    emit(name, payload, target = { type: "broadcast" }) {
      if (closed) return;
      emitter.emit(name as never, payload as never, target);
    },
    emitToTopic(topic, name, payload) {
      api.emit(name, payload, { type: "topic", topic });
    },
    emitToGroup(group, name, payload) {
      api.emit(name, payload, { type: "group", group });
    },
    emitToUser(userId, name, payload) {
      api.emit(name, payload, { type: "user", userId });
    },
    /**
     * Deliver to the user on EVERY instance/service in the cluster mesh — an
     * explicit full-mesh emit (no presence routing). Use when the user may be
     * connected to any service sharing the cluster transport.
     */
    emitToUserAnywhere(userId, name, payload) {
      api.emit(name, payload, { type: "user", userId, anywhere: true });
    },
    emitToClient(clientId, name, payload) {
      api.emit(name, payload, { type: "client", clientId });
    },

    // ── client records ──────────────────────────────────────────────────
    client(id) {
      return clients.get(id);
    },
    clients() {
      return clients.all();
    },
    clientsByUser(userId) {
      return clients.byUser(userId);
    },
    get clientCount(): number {
      return clients.size;
    },
    setUserId(clientId, userId) {
      const before = clients.get(clientId)?.userId;
      if (!clients.setUserId(clientId, userId)) return;
      if (before !== userId) {
        // keep remote presence indexes in sync with the identity change
        cluster?.clientLeft({ id: clientId, ...(before !== undefined ? { userId: before } : {}) });
        cluster?.clientJoined({ id: clientId, ...(userId !== undefined ? { userId } : {}) });
      }
    },
    setClientData(clientId, key, value) {
      const client = clients.get(clientId);
      if (!client) return;
      client.data.set(key, value);
      cluster?.setRemoteClientData(clientId, JSON.stringify(client.data.toJSON()));
    },
    getClientData(clientId, key) {
      return clients.get(clientId)?.data.get(key);
    },
    clearClientData(clientId) {
      const client = clients.get(clientId);
      if (!client) return;
      client.data.clear();
      cluster?.setRemoteClientData(clientId, "{}");
    },

    // ── groups ──────────────────────────────────────────────────────────
    group(name) {
      return groups.clientGroup(name);
    },
    groups() {
      return groups.clientGroups();
    },
    userGroup(name) {
      return groups.userGroup(name);
    },
    userGroups() {
      return groups.userGroups();
    },

    // ── horizontal scaling ──────────────────────────────────────────────
    clusterClients() {
      return cluster?.remoteClients() ?? [];
    },
    clusterInstances() {
      return cluster?.knownInstances() ?? [];
    },
    async clusterUserClients(userId) {
      return (await cluster?.clusterUserClients(userId)) ?? [];
    },
    async clusterGroupMembers(group) {
      return (await cluster?.clusterGroupMembers(group)) ?? [];
    },
    async clusterUserGroupMembers(group) {
      return (await cluster?.clusterUserGroupMembers(group)) ?? [];
    },
    async remoteClientData(clientId) {
      return await cluster?.getRemoteClientData(clientId);
    },

    // ── cross-instance rpc ──────────────────────────────────────────────
    call(method, args, opts) {
      if (!clusterRpc)
        return Promise.reject(
          new Error("ignex events: hub.call requires a configured events.cluster"),
        );
      return clusterRpc.call(method, args, opts);
    },
    onMethod(method, handler) {
      clusterRpc?.on(method, handler as never);
      return api;
    },
    onRequest(name, responder) {
      server.handle(
        name,
        (async (payload: unknown, ws: ServerWebSocket<WsData>) => {
          const client = clients.get(ws.data.id) ?? attach(ws);
          return await responder(payload as never, contexts.make(client, "client"));
        }) as never,
      );
      return api;
    },

    // ── scheduled emits ─────────────────────────────────────────────────
    schedule(name, payload, target, delayMs) {
      if (closed) return "";
      return scheduler.schedule(name as never, payload, target, delayMs);
    },
    cancelScheduled(id) {
      return scheduler.cancel(id);
    },
    get scheduledCount(): number {
      return scheduler.size;
    },

    // ── observability ───────────────────────────────────────────────────
    metrics() {
      const s = cluster?.stats();
      return buildMetricsSnapshot({
        counters,
        transportErrors,
        dispatch: dispatchCounters,
        handlerErrors: registry.errorCount,
        scheduledActive: scheduler.size,
        ...(s !== undefined ? { cluster: s } : {}),
        queue: queue.stats(),
        ...(clusterRpc !== undefined ? { rpc: clusterRpc.stats() } : {}),
        connectedClients: clients.size,
        remoteClients: cluster?.remoteClients().length ?? 0,
        clientGroups: groups.clientGroups().length,
        userGroups: groups.userGroups().length,
      });
    },
    queueStats() {
      const s = queue.stats();
      return { pending: queue.pending, ...s };
    },

    // ── internals (server-driven) ───────────────────────────────────────
    attach,
    detach,
    onGroupChange,
    dispatchBridgeInbound(name, payload) {
      if (registry.wantsServerEvent(name)) {
        dispatcher.client(name, payload, contexts.make(undefined, "bridge"));
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (boundGlobal) unbindEvents();
      scheduler.clear();
      clusterRpc?.close();
      // announce local leaves so remote presence converges before shutdown
      for (const c of clients.all()) cluster?.clientLeft(clientIdentity(c));
      await cluster?.close();
      await queue.drain();
      queue.close();
      if (ownBridge) await ownBridge.close();
    },
  };

  if (eOpts.global !== false) {
    bindEvents(api as never);
    boundGlobal = true;
  }

  // pre-register dispatchers for explicitly allowed inbound events (so onAny
  // sees them even without a dedicated handler)
  for (const name of eOpts.inbound ?? []) ensureDispatcher(name);

  return api;
}
