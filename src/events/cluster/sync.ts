/**
 * Cluster sync — the composition of cross-instance messaging.
 *
 * Every emit is delivered locally (synchronous, on the WS hot path) and then
 * re-published to a cluster channel so OTHER instances deliver it to their own
 * clients. All cross-instance work is deferred to the offload queue — the emit
 * call never blocks on a broker, and a slow/saturated broker never stalls the
 * socket loop.
 *
 * ROUTED DELIVERY: targeted emits (kind client/user) can be published ONLY to
 * the instance(s) that own the target connection(s) (per-instance subjects,
 * via {@link ClusterSync.route}) instead of the full-mesh wildcard.
 *
 * Presence works with no shared state: join/leave messages + periodic
 * per-instance heartbeat with TTL pruning (see `presence.ts` /
 * `presence-table.ts`). An optional `ClusterStateStore` additionally indexes
 * user→clients and group membership cluster-wide.
 *
 * Composes the pure pieces in this folder: `envelope`, `subjects`,
 * `presence`, `presence-table`, `dedupe`, `keys`.
 */
import type { Bindings } from "../../bindings/types";
import type { EmitTargetKind, ClusterStateStore, ClusterTransport, RemoteClient } from "../types";
import type { TaskQueue } from "../queue";
import { createDedupeWindow } from "./dedupe";
import {
  decodeClusterMessage,
  encodeClusterMessage,
  type ClusterEnvelope,
} from "./envelope";
import {
  clientDataKey,
  clientGroupStateKey,
  parsePresenceMember,
  presenceInstanceKey,
  presenceUserKey,
  userGroupStateKey,
} from "./keys";
import { decodePresence, encodePresence, type PresenceMessage } from "./presence";
import { createPresenceTable, type PresenceTable } from "./presence-table";
import { createClusterSubjects, type ClusterSubjects } from "./subjects";
import type { ClusterKind } from "./kinds";

export interface ClusterSyncOptions {
  instanceId: string;
  prefix: string;
  transport: ClusterTransport;
  queue: TaskQueue;
  bindings: Bindings;
  /** optional shared-state store (presence / groups / client data) */
  stateStore?: ClusterStateStore;
  /** remote presence TTL (ms) */
  presenceTtlMs: number;
  /** presence re-announce + prune cadence (ms) */
  heartbeatMs: number;
  /**
   * Broker-level redelivery dedupe window (messages tracked by id), default
   * 4096 entries. Protects against double-delivery from durable brokers.
   */
  dedupeWindow?: number;
  /**
   * A valid remote frame must be delivered locally. `frame` is a view of the
   * message buffer — hand it to `ws.send`/replay immediately (Bun copies;
   * replay records an owned copy).
   */
  onRemoteFrame: (
    kind: EmitTargetKind,
    key: string,
    name: string,
    frame: Uint8Array,
    meta: { readonly msgId: string; readonly traceId: string },
  ) => void;
  onError?: (err: Error) => void;
}

/** Per-message metadata flowing through the cluster path. */
export interface ClusterMsgMeta {
  /** unique message id (generated per emit; used for redelivery dedupe) */
  msgId?: string;
  /** cross-instance trace id (propagated into remote EventContexts) */
  traceId?: string;
}

export interface ClusterSync {
  /**
   * Offloaded cross-instance publish for a local emit — full-mesh kinds go to
   * the wildcard subject space; copies the scratch view immediately.
   */
  publish(kind: EmitTargetKind, key: string | undefined, name: string, frame: Uint8Array, meta?: ClusterMsgMeta): void;
  /**
   * ROUTED targeted delivery: publish ONLY to the given instances'
   * per-instance subjects (envelope keeps the semantic kind/key so receivers
   * deliver locally without re-broadcasting). Falls back to nothing when the
   * list is empty — callers decide their own fallback.
   */
  route(instances: readonly string[], kind: EmitTargetKind, key: string, name: string, frame: Uint8Array, meta?: ClusterMsgMeta): void;
  /** instance ids that currently hold `clientId` ([] = unknown → caller falls back) */
  instancesForClient(clientId: string): string[];
  /** instance ids that currently hold a connection of `userId` */
  instancesForUser(userId: string): string[];
  /** every other instance heard from recently (presence heartbeats) */
  knownInstances(): string[];
  /** local connection joined/left → presence + state-store index (offloaded) */
  clientJoined(client: { id: string; userId?: string }): void;
  clientLeft(client: { id: string; userId?: string }): void;
  /** local client-group membership change → shared state store (offloaded) */
  clientGroupChanged(group: string, clientId: string, joined: boolean): void;
  /** user-group membership changed → shared state store (offloaded) */
  userGroupChanged(name: string, members: ReadonlySet<string>): void;
  /** cluster-wide clients of a user (state store), [] when none configured */
  clusterUserClients(userId: string): Promise<Array<{ instanceId: string; clientId: string }>>;
  /** cluster-wide client-group members (state store) */
  clusterGroupMembers(name: string): Promise<string[]>;
  /** cluster-wide user-group members (state store) */
  clusterUserGroupMembers(name: string): Promise<string[]>;
  /** write client data to the shared state store (offloaded) */
  setRemoteClientData(clientId: string, json: string): void;
  /** read client data from the shared state store */
  getRemoteClientData(clientId: string): Promise<Record<string, unknown> | undefined>;
  /** connections known on other instances (presence — no shared state needed) */
  remoteClients(): RemoteClient[];
  /** cluster counters (folded into hub.metrics()) */
  stats(): { received: number; droppedSelf: number; droppedDupe: number; errors: number };
  close(): Promise<void>;
}

/** Mutable counters folded into `stats()` (one object, incremented in place). */
interface SyncCounters {
  received: number;
  droppedSelf: number;
  droppedDupe: number;
  errors: number;
}

/**
 * Apply one decoded inbound envelope, preserving the canonical gate order:
 * self-drop → liveness touch → redelivery dedupe → accepted → deliver.
 * Mutates only the presence table + counters passed in.
 */
function processInbound(
  msg: ClusterEnvelope,
  deps: {
    instanceId: string;
    presence: PresenceTable;
    counters: SyncCounters;
    /** record-and-test dedupe (true = already processed → drop) */
    markSeen(id: string): boolean;
    onPresence: (frame: Uint8Array) => void;
    onRemoteFrame: ClusterSyncOptions["onRemoteFrame"];
    readFrameHeader: Bindings["readFrameHeader"];
  },
): void {
  const { presence, counters } = deps;
  if (msg.origin === deps.instanceId) {
    counters.droppedSelf++; // self-publish — already delivered locally
    return;
  }
  presence.touch(msg.origin, Date.now());
  if (deps.markSeen(msg.msgId)) {
    counters.droppedDupe++; // broker redelivery of an already-processed message
    return;
  }
  counters.received++;
  if (msg.kind === "presence") {
    deps.onPresence(msg.frame);
    return;
  }
  const header = deps.readFrameHeader(msg.frame);
  if (!header) {
    counters.errors++;
    return;
  }
  deps.onRemoteFrame(msg.kind as EmitTargetKind, msg.key, header.name, msg.frame, {
    msgId: msg.msgId,
    traceId: msg.traceId,
  });
}

export function createClusterSync(opts: ClusterSyncOptions): ClusterSync {
  const { instanceId, transport, queue, bindings, stateStore } = opts;
  const subjects: ClusterSubjects = createClusterSubjects(opts.prefix);
  const presence = createPresenceTable();
  const dedupe = createDedupeWindow(opts.dedupeWindow ?? 4096);
  // users with at least one LOCAL connection (state-store TTL refresh)
  const localUserIds = new Set<string>();
  // last-known user-group membership (diff → minimal sadd/srem traffic)
  const userGroupCache = new Map<string, Set<string>>();

  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const counters: SyncCounters = { received: 0, droppedSelf: 0, droppedDupe: 0, errors: 0 };

  const reportError = (err: unknown): void => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  // ── offloaded shared-state ops ────────────────────────────────────────

  /** Fire-and-forget state-store op through the offload queue (no-op when unset). */
  const store = (op: () => Promise<unknown>): void => {
    if (!stateStore || closed) return;
    queue.enqueue(() => {
      void op().catch(reportError);
    });
  };

  /** TTL-refresh every presence key owned by this instance (heartbeat tick). */
  const refreshStoreTtls = (): void => {
    if (!stateStore) return;
    store(() => stateStore!.expire(presenceInstanceKey(instanceId), opts.presenceTtlMs));
    for (const userId of localUserIds)
      store(() => stateStore!.expire(presenceUserKey(userId), opts.presenceTtlMs));
  };

  /** Diff `members` against the cache → minimal sadd/srem ops (offloaded). */
  const syncUserGroup = (name: string, members: ReadonlySet<string>): void => {
    if (!stateStore) return;
    const prev = userGroupCache.get(name) ?? new Set<string>();
    const key = userGroupStateKey(name);
    for (const m of members) {
      if (!prev.has(m)) store(() => stateStore!.sadd(key, m));
    }
    for (const m of prev) {
      if (!members.has(m)) store(() => stateStore!.srem(key, m));
    }
    userGroupCache.set(name, new Set(members));
  };

  // ── publishing ────────────────────────────────────────────────────────

  /**
   * Enqueue an encoded message for delivery. The exact subject is computed
   * here (subscribe side uses the wildcard; the envelope carries routing).
   */
  const publishToCluster = (
    kind: ClusterKind,
    key: string,
    name: string,
    data: Uint8Array,
    subjectOverride?: string,
  ): void => {
    if (closed) return;
    const subject =
      subjectOverride ??
      (kind === "presence"
        ? `${opts.prefix}.cluster.presence`
        : subjects.event(kind as EmitTargetKind, key || undefined, name));
    queue.enqueue(() => {
      if (!transport.connected) {
        counters.errors++; // offline broker — frames dropped, visible in metrics
        return;
      }
      try {
        transport.publish(subject, data);
      } catch {
        counters.errors++;
      }
    });
  };

  /** Announce a presence message on the shared presence channel. */
  const announce = (msg: PresenceMessage): void => {
    // presence rides the SAME envelope as event frames (kind = "presence")
    const payload = encodeClusterMessage(
      instanceId,
      "presence",
      "",
      "",
      encodePresence(msg),
    );
    publishToCluster("presence", "", "", payload);
  };

  // ── presence tick ─────────────────────────────────────────────────────

  const heartbeat = (): void => {
    if (closed) return;
    presence.prune(opts.presenceTtlMs);
    announce({ t: "s", i: instanceId, at: Date.now() });
    refreshStoreTtls();
  };
  heartbeatTimer = setInterval(heartbeat, opts.heartbeatMs);

  // ── inbound pipeline ──────────────────────────────────────────────────

  /** Apply a decoded presence payload to the local table. */
  const handlePresencePayload = (bytes: Uint8Array): void => {
    const msg = decodePresence(bytes);
    if (!msg || msg.i === instanceId) return;
    if (msg.t === "j") presence.join(msg.c, msg.i, msg.u, msg.at);
    else if (msg.t === "l") presence.leave(msg.c, msg.i);
    else if (msg.t === "s") presence.refreshInstance(msg.i, msg.at);
  };

  const handleMessage = (data: Uint8Array): void => {
    const msg = decodeClusterMessage(data);
    if (!msg) {
      counters.errors++; // undecodable / foreign-envelope — counted once in stats()
      return;
    }
    processInbound(msg, {
      instanceId,
      presence,
      counters,
      markSeen: dedupe.markSeen,
      onPresence: handlePresencePayload,
      onRemoteFrame: opts.onRemoteFrame,
      readFrameHeader: bindings.readFrameHeader,
    });
  };

  // wildcard (full-mesh kinds + presence) AND our own per-instance subject
  // (routed targeted delivery from peers)
  const unsubInstance = transport.subscribe(subjects.instance(instanceId), handleMessage);
  const unsubAll = transport.subscribe(subjects.all(), handleMessage);
  unsubscribe = () => {
    unsubAll();
    unsubInstance();
  };

  // ── public surface ────────────────────────────────────────────────────
  return {
    publish(kind, key, name, frame, meta) {
      publishToCluster(
        kind,
        key ?? "",
        name,
        encodeClusterMessage(instanceId, kind, key ?? "", name, frame, meta?.msgId ?? "", meta?.traceId ?? ""),
      );
    },

    route(instances, kind, key, name, frame, meta) {
      if (closed || instances.length === 0) return;
      for (const target of instances) {
        if (target === instanceId) continue; // local delivery already happened
        publishToCluster(
          kind,
          key,
          name,
          encodeClusterMessage(instanceId, kind, key, name, frame, meta?.msgId ?? "", meta?.traceId ?? ""),
          subjects.instance(target),
        );
      }
    },

    instancesForClient(clientId) {
      return presence.instancesForClient(clientId);
    },

    instancesForUser(userId) {
      return presence.instancesForUser(userId);
    },

    knownInstances() {
      return presence.knownInstances();
    },

    clientJoined(client) {
      announce({
        t: "j",
        i: instanceId,
        c: client.id,
        ...(client.userId !== undefined ? { u: client.userId } : {}),
        at: Date.now(),
      });
      if (client.userId) localUserIds.add(client.userId);
      if (!stateStore) return;
      store(async () => {
        await stateStore!.sadd(presenceInstanceKey(instanceId), client.id);
        if (client.userId) {
          await stateStore!.sadd(presenceUserKey(client.userId), `${instanceId}:${client.id}`);
          await stateStore!.expire(presenceUserKey(client.userId), opts.presenceTtlMs);
        }
      });
    },

    clientLeft(client) {
      announce({ t: "l", i: instanceId, c: client.id });
      if (!stateStore) return;
      store(async () => {
        await stateStore!.srem(presenceInstanceKey(instanceId), client.id);
        if (client.userId)
          await stateStore!.srem(presenceUserKey(client.userId), `${instanceId}:${client.id}`);
      });
    },

    userGroupChanged(name, members) {
      syncUserGroup(name, members);
    },

    clientGroupChanged(group, clientId, joined) {
      if (!stateStore) return;
      const key = clientGroupStateKey(group);
      store(() => (joined ? stateStore!.sadd(key, clientId) : stateStore!.srem(key, clientId)));
    },

    async clusterUserClients(userId) {
      if (!stateStore) return [];
      try {
        const members = await stateStore.smembers(presenceUserKey(userId));
        const out: Array<{ instanceId: string; clientId: string }> = [];
        for (const m of members) {
          const parsed = parsePresenceMember(m);
          if (parsed) out.push(parsed);
        }
        return out;
      } catch (err) {
        reportError(err);
        return [];
      }
    },

    async clusterGroupMembers(name) {
      if (!stateStore) return [];
      try {
        return await stateStore.smembers(clientGroupStateKey(name));
      } catch (err) {
        reportError(err);
        return [];
      }
    },

    async clusterUserGroupMembers(name) {
      if (!stateStore) return [];
      try {
        return await stateStore.smembers(userGroupStateKey(name));
      } catch (err) {
        reportError(err);
        return [];
      }
    },

    setRemoteClientData(clientId, json) {
      if (!stateStore) return;
      store(() => stateStore!.set(clientDataKey(clientId), json, opts.presenceTtlMs));
    },

    async getRemoteClientData(clientId) {
      if (!stateStore) return undefined;
      try {
        const raw = await stateStore.get(clientDataKey(clientId));
        if (raw == null) return undefined;
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        reportError(err);
        return undefined;
      }
    },

    remoteClients() {
      return presence.remoteClients();
    },

    stats() {
      return { ...counters };
    },

    async close() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // already unsubscribed
        }
        unsubscribe = null;
      }
      await queue.drain();
      await transport.close();
    },
  };
}
