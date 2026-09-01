/**
 * Cluster transport resolution — maps `events.cluster` options onto a
 * concrete {@link ClusterTransport} (plus an owned bridge when the hub had to
 * create one and therefore must close it again).
 *
 * Pure resolver: no side effects beyond constructing the adapters it returns.
 */
import { createNatsBridge, type NatsBridge, type NatsBridgeOptions } from "../../bridge/nats";
import type { Bindings } from "../../bindings/types";
import type { ClusterTransport, EventsClusterOptions } from "../types";
import { createNatsClusterTransport } from "../cluster/transport-nats";
import { createRedisClusterTransport } from "../cluster/transport-redis";

export interface ResolvedClusterTransport {
  transport?: ClusterTransport;
  /** set when this resolver created the bridge — the hub closes it on shutdown */
  ownBridge?: NatsBridge;
}

export function resolveClusterTransport(
  opts: EventsClusterOptions,
  serverBridge: NatsBridge | undefined,
  bindings: Bindings,
  onError: (err: Error) => void,
): ResolvedClusterTransport {
  // explicit adapter always wins
  if (opts.transport) return { transport: opts.transport };

  if (opts.nats) {
    const nats = opts.nats;
    // `true` → reuse the server's bridge when present, else dial localhost
    if (typeof nats === "boolean") {
      if (serverBridge) return { transport: createNatsClusterTransport(serverBridge) };
      const own = createNatsBridge(
        { servers: ["nats://localhost:4222"], inbound: false },
        undefined,
        bindings,
      );
      return { transport: createNatsClusterTransport(own), ownBridge: own };
    }
    // a pre-built bridge (`status` is bridge-only surface) vs raw options
    if ("status" in nats) return { transport: createNatsClusterTransport(nats) };
    const own = createNatsBridge(nats as NatsBridgeOptions, undefined, bindings);
    return { transport: createNatsClusterTransport(own), ownBridge: own };
  }

  if (opts.redis) return { transport: createRedisClusterTransport(opts.redis, onError) };
  return {};
}
