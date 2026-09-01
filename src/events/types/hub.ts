/**
 * The events hub — the public API surface type.
 *
 * Type-only module (part of the `src/events/types` barrel). The runtime
 * composition root is `src/events/hub/index.ts` (`createEventsHub`).
 */
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../../bindings/types";
import type { IgnServer } from "../../core/server";
import type { EventContext, EventHandler, ServerEventHandler } from "./context";
import type { ClientGroup, UserGroup } from "./groups";
import type { EmitTarget } from "./emit-target";
import type { EventClient, RemoteClient } from "./client";
import type { EventsMetricsSnapshot } from "./metrics";

/**
 * The events hub — the public API returned as `server.events` when
 * `createServer({ events: {...} })` is used, and the backing store for the
 * module-global `emit` / `on` singleton (`ignex-nova/events`).
 */
export interface EventsHub<B extends Bindings = DefaultBindings> {
  readonly server: IgnServer<B>;
  /** stable id of THIS instance (self-delivery dedupe in a cluster) */
  readonly instanceId: string;

  // ── receiving events (the "events file": where events come in) ────────
  on<K extends EventNameOf<B>>(name: K, handler: EventHandler<B, K>): EventsHub<B>;
  off<K extends EventNameOf<B>>(name: K, handler?: EventHandler<B, K>): EventsHub<B>;
  once<K extends EventNameOf<B>>(name: K, handler: EventHandler<B, K>): EventsHub<B>;
  /** every client-sent inbound event (name + payload + ctx) */
  onAny(cb: (name: EventNameOf<B>, payload: unknown, ctx: EventContext<B>) => void): EventsHub<B>;
  offAny(cb: (name: EventNameOf<B>, payload: unknown, ctx: EventContext<B>) => void): EventsHub<B>;
  /** server-side handlers for events from OTHER instances / the bridge */
  onServerEvent<K extends EventNameOf<B>>(name: K, handler: ServerEventHandler<B, K>): EventsHub<B>;
  offServerEvent<K extends EventNameOf<B>>(
    name: K,
    handler?: ServerEventHandler<B, K>,
  ): EventsHub<B>;
  /** event names with at least one handler */
  events(): EventNameOf<B>[];
  listenerCount(name: EventNameOf<B>): number;
  removeAllListeners(name?: EventNameOf<B>): EventsHub<B>;

  // ── emitting events (through websockets, cluster-aware) ───────────────
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K], target?: EmitTarget): void;
  emitToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
  emitToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  emitToUser<K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToClient<K extends EventNameOf<B>>(clientId: string, name: K, payload: EventsOf<B>[K]): void;

  // ── client records ("who is connected, on whose behalf") ──────────────
  client(id: string): EventClient | undefined;
  clients(): EventClient[];
  /** every connection acting on behalf of `userId` */
  clientsByUser(userId: string): EventClient[];
  readonly clientCount: number;
  /** bind a connection to an identity (on whose behalf it acts) */
  setUserId(clientId: string, userId: string): void;
  /** per-connection app state */
  setClientData(clientId: string, key: string, value: unknown): void;
  getClientData(clientId: string, key: string): unknown;
  clearClientData(clientId: string): void;

  // ── groups ────────────────────────────────────────────────────────────
  /** client group handle (membership by connection id) */
  group(name: string): ClientGroup<B>;
  /** live client-group names */
  groups(): string[];
  /** user group handle (membership by userId, fan-out to every socket) */
  userGroup(name: string): UserGroup<B>;
  /** live user-group names */
  userGroups(): string[];

  // ── horizontal scaling ────────────────────────────────────────────────
  /** connections known on other instances (presence; [] when unclustered) */
  clusterClients(): RemoteClient[];
  /** other instance ids heard from recently (presence; [] when unclustered) */
  clusterInstances(): string[];
  /** user→clients index from the shared state store, if configured */
  clusterUserClients(userId: string): Promise<Array<{ instanceId: string; clientId: string }>>;
  /** cluster-wide client-group members (shared state store), if configured */
  clusterGroupMembers(group: string): Promise<string[]>;
  /** cluster-wide user-group members (shared state store), if configured */
  clusterUserGroupMembers(group: string): Promise<string[]>;
  /** client data from the shared state store, if configured */
  remoteClientData(clientId: string): Promise<Record<string, unknown> | undefined>;

  // ── cross-instance rpc (server ⇄ server over the cluster transport) ──
  /**
   * Call a method on another instance (or any instance when `opts.instanceId`
   * is omitted — first responder wins). Requires a configured cluster.
   */
  call(method: string, args?: unknown, opts?: { readonly instanceId?: string; readonly timeoutMs?: number }): Promise<unknown>;
  /** register a cross-instance rpc method handler */
  onMethod(method: string, handler: (args: unknown, fromInstanceId: string) => unknown | Promise<unknown>): EventsHub<B>;
  /** request/response for CLIENT-sent events (WS-level, `client.request`) */
  onRequest<K extends EventNameOf<B>>(
    name: K,
    responder: (payload: EventsOf<B>[K], ctx: EventContext<B>) => EventsOf<B>[K] | Promise<EventsOf<B>[K]>,
  ): EventsHub<B>;

  // ── scheduled emits (time-based events) ───────────────────────────────
  /** emit `name` after `delayMs`; returns an id usable with {@link cancelScheduled} */
  schedule<K extends EventNameOf<B>>(
    name: K,
    payload: EventsOf<B>[K],
    target: EmitTarget | undefined,
    delayMs: number,
  ): string;
  /** cancel a scheduled emit — true when it had not fired yet */
  cancelScheduled(id: string): boolean;
  /** emits currently scheduled */
  readonly scheduledCount: number;

  // ── lifecycle / observability ─────────────────────────────────────────
  metrics(): EventsMetricsSnapshot;
  queueStats(): {
    pending: number;
    queued: number;
    processed: number;
    dropped: number;
    errors: number;
  };
  close(): Promise<void>;
}
