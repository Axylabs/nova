/**
 * Presence table — in-memory index of OTHER instances' connections, learned
 * from presence join/leave/sync messages and pruned by TTL.
 *
 * Encapsulated factory (like `createMetrics`): all mutation is private; the
 * surface is queries + pure-ish updates. No timers, no I/O — the sync layer
 * drives it from broker messages and the heartbeat tick.
 */
import type { RemoteClient } from "../types";

export interface PresenceTable {
  /** record that `instance` was heard from at epoch ms `at` */
  touch(instance: string, at: number): void;
  /** heartbeat from `instance`: refresh the instance AND its reported clients */
  refreshInstance(instance: string, at: number): void;
  /** a connection joined on a remote instance */
  join(clientId: string, instanceId: string, userId: string | undefined, at: number): void;
  /**
   * a connection left a remote instance — only honored when the reporting
   * instance still owns the record (stale leaves from older epochs are ignored)
   */
  leave(clientId: string, instanceId: string): void;
  /** drop clients/instances not heard from within `ttlMs` */
  prune(ttlMs: number, now?: number): void;
  /** instances that currently hold `clientId` ([] = unknown) */
  instancesForClient(clientId: string): string[];
  /** unique instances holding any connection of `userId` */
  instancesForUser(userId: string): string[];
  /** every other instance heard from recently */
  knownInstances(): string[];
  /** snapshot of remote connection records */
  remoteClients(): RemoteClient[];
}

export function createPresenceTable(): PresenceTable {
  // clientId → remote record
  const remote = new Map<string, RemoteClient>();
  // other instanceId → last-seen epoch ms
  const instanceSeen = new Map<string, number>();

  return {
    touch(instance, at) {
      instanceSeen.set(instance, at);
    },

    refreshInstance(instance, at) {
      instanceSeen.set(instance, at);
      for (const r of remote.values()) {
        if (r.instanceId === instance) r.lastSeen = at;
      }
    },

    join(clientId, instanceId, userId, at) {
      instanceSeen.set(instanceId, at);
      remote.set(clientId, {
        clientId,
        instanceId,
        ...(userId !== undefined ? { userId } : {}),
        lastSeen: at,
      });
    },

    leave(clientId, instanceId) {
      instanceSeen.set(instanceId, Date.now());
      const r = remote.get(clientId);
      if (r && r.instanceId === instanceId) remote.delete(clientId);
    },

    prune(ttlMs, now = Date.now()) {
      for (const [clientId, r] of remote) {
        if (now - r.lastSeen > ttlMs) remote.delete(clientId);
      }
      for (const [inst, at] of instanceSeen) {
        if (now - at > ttlMs) instanceSeen.delete(inst);
      }
    },

    instancesForClient(clientId) {
      const r = remote.get(clientId);
      return r ? [r.instanceId] : [];
    },

    instancesForUser(userId) {
      const out: string[] = [];
      for (const r of remote.values()) {
        if (r.userId === userId && !out.includes(r.instanceId)) out.push(r.instanceId);
      }
      return out;
    },

    knownInstances() {
      return [...instanceSeen.keys()];
    },

    remoteClients() {
      return [...remote.values()];
    },
  };
}
