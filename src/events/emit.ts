/**
 * Emit engine — the "global emit" hot path. Encodes ONCE through the transport
 * scratch (zero-alloc on the happy path), delivers to the target's local
 * sockets synchronously, then hands the SAME frame to the external bridge
 * (existing NATS broadcast/topic/group subjects) and the cluster sync
 * (offloaded) so other instances deliver it too.
 *
 * Hot-path guarantees:
 *   - encode + local delivery are synchronous and allocation-free (Bun copies
 *     on `ws.send`);
 *   - the bridge `publish` copies the scratch frame (never holds a stale view);
 *   - cluster work is enqueued on the offload queue — a slow broker can never
 *     stall the socket loop.
 */
import type { ServerWebSocket } from "bun";
import type { NatsBridge } from "../bridge/nats";
import type { ServerState, WsData } from "../core/state";
import { sendFrame } from "../core/outbound";
import { publishToGroup } from "../core/groups";
import { publishToRoom } from "../core/rooms";
import type { ClusterSync } from "./cluster";
import { capturePayload } from "./trace";
import type { EmitTarget, EmitTargetKind } from "./types";

export interface EmitCounters {
  emitted: number;
  emittedByTarget: Record<EmitTargetKind, number>;
  deliveredLocal: number;
  clusterPublished: number;
  clusterRouted: number;
}

export interface EmitEngine {
  emit(name: string, payload: unknown, target: EmitTarget, parentTraceId?: string): void;
}

export interface EmitterOptions {
  state: ServerState;
  bridge?: NatsBridge;
  cluster?: ClusterSync;
  /**
   * Invoke `each` for every LOCAL socket acting on behalf of `userId` and
   * return how many were invoked. Callback-style (not array-returning) so a
   * user-targeted emit allocates nothing on the hot path.
   */
  eachUserSocket: (
    userId: string,
    each: (ws: ServerWebSocket<WsData>) => void,
  ) => number;
  /**
   * ROUTED targeted delivery: for client/user targets return the instance ids
   * that own the destination connection(s) (presence), or null when unknown —
   * null falls back to the full-mesh wildcard publish. Absent when no cluster.
   */
  routeInstances?: (target: EmitTarget) => readonly string[] | null;
  counters: EmitCounters;
}

/** Deliver `frame` to the target's LOCAL sockets; returns the number written. */
export function deliverLocal(
  state: ServerState,
  target: EmitTarget,
  frame: Uint8Array,
  eachUserSocket: EmitterOptions["eachUserSocket"],
): number {
  switch (target.type) {
    case "broadcast": {
      for (const ws of state.sockets) sendFrame(state, ws, frame);
      return state.sockets.size;
    }
    case "topic": {
      const n = state.rooms.get(target.topic)?.size ?? 0;
      publishToRoom(state, target.topic, frame);
      return n;
    }
    case "group": {
      const n = state.groups.get(target.group)?.size ?? 0;
      publishToGroup(state, target.group, frame);
      return n;
    }
    case "user": {
      return eachUserSocket(target.userId, (ws) => sendFrame(state, ws, frame));
    }
    case "client": {
      const ws = state.clients.get(target.clientId);
      if (!ws) return 0;
      sendFrame(state, ws, frame);
      return 1;
    }
  }
}

export function targetKey(target: EmitTarget): string | undefined {
  switch (target.type) {
    case "broadcast":
      return undefined;
    case "topic":
      return target.topic;
    case "group":
      return target.group;
    case "user":
      return target.userId;
    case "client":
      return target.clientId;
  }
}

export function createEmitter(opts: EmitterOptions): EmitEngine {
  const { state, bridge, cluster } = opts;

  const bridgeSubject = (target: EmitTarget, name: string): string | undefined => {
    switch (target.type) {
      case "broadcast":
        return bridge?.subjects.broadcast(name);
      case "topic":
        return bridge?.subjects.topic(target.topic, name);
      case "group":
        return bridge?.subjects.group(target.group, name);
      default:
        return undefined; // user/client targets are not bridged externally
    }
  };

  return {
    emit(name, payload, target, parentTraceId) {
      const frame = state.transport.encodeToScratch(name, payload);
      opts.counters.emitted++;
      opts.counters.emittedByTarget[target.type]++;
      // trace first (cheap typed-array stores) so a debugger sees the event
      // even when delivery has zero local sockets / the bridge is down.
      state.trace.record(
        "out.emit",
        name,
        target.type,
        targetKey(target),
        frame.byteLength,
        state.trace.captures ? capturePayload(payload, 2000) : undefined,
      );
      // EXTERNAL copies (bridge / cluster envelope) come FIRST — they must see
      // the pristine frame, before per-socket delivery-seq stamping mutates
      // the shared scratch header below. Both copy the bytes synchronously.
      if (bridge) {
        const subject = bridgeSubject(target, name);
        if (subject) bridge.publish(subject, frame); // copies the scratch view
      }
      if (cluster) {
        const msgId = crypto.randomUUID();
        const traceId = parentTraceId ?? "";
        // `user … anywhere: true` forces the full-mesh wildcard publish instead
        // of presence routing — the user is reached on EVERY instance/service in
        // the mesh, regardless of where presence thinks they are.
        const routeable =
          target.type === "client" ||
          (target.type === "user" && target.anywhere !== true);
        if (opts.routeInstances !== undefined && routeable) {
          // ROUTED targeted delivery: only the owning instances receive it
          const instances = opts.routeInstances(target);
          if (instances !== null) {
            opts.counters.clusterPublished++;
            opts.counters.clusterRouted++;
            cluster.route(instances, target.type as "client" | "user", targetKey(target) ?? "", name, frame, {
              msgId,
              traceId,
            });
          } else {
            // presence knows nothing — fall back to the full mesh
            opts.counters.clusterPublished++;
            cluster.publish(target.type, targetKey(target), name, frame, { msgId, traceId });
          }
        } else {
          opts.counters.clusterPublished++;
          cluster.publish(target.type, targetKey(target), name, frame, { msgId, traceId });
        }
      }
      // local delivery LAST: stamps delivery seqs into the scratch header
      opts.counters.deliveredLocal += deliverLocal(state, target, frame, opts.eachUserSocket);
    },
  };
}
