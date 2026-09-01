/**
 * Metrics view — assembles the server-level `MetricsSnapshot` by folding the
 * transport's cumulative per-path encode counters and the bridge stats into
 * the core metrics snapshot. Pure assembly: no counter is re-accumulated, so
 * polling `getMetrics()` repeatedly never inflates what it reports.
 */
import type { NatsBridge } from "../../bridge/nats";
import type { MetricsSnapshot } from "../metrics";
import type { ServerState } from "../state";

/**
 * Derive per-event path counts from the transport's OWN cumulative counters
 * (totals since start) — a pure projection of `{direct,json,js}` per name.
 */
function buildPathCounts(state: ServerState): MetricsSnapshot["pathCounts"] {
  const encodeStats = state.transport.getEncodeStats();
  const pathCountsObj: Record<string, { direct: number; json: number; js: number }> = {};
  const names = new Set<string>([
    ...Object.keys(encodeStats.direct),
    ...Object.keys(encodeStats.json),
    ...Object.keys(encodeStats.js),
  ]);
  for (const name of names) {
    const direct = encodeStats.direct[name] ?? 0;
    const json = encodeStats.json[name] ?? 0;
    const js = encodeStats.js[name] ?? 0;
    if (direct > 0 || json > 0 || js > 0) pathCountsObj[name] = { direct, json, js };
  }
  return pathCountsObj;
}

/** Fold bridge counters into the snapshot (only when a bridge is wired). */
function foldBridgeStats(snapshot: MetricsSnapshot, bridge: NatsBridge | undefined): void {
  if (!bridge) return;
  snapshot.bridged = bridge.stats.bridged;
  snapshot.bridgedBytes = bridge.stats.bridgedBytes;
  snapshot.bridgeErrors = bridge.stats.bridgeErrors;
  snapshot.bridgeInbound = bridge.stats.bridgeInbound;
  snapshot.bridgeInboundErrors = bridge.stats.bridgeInboundErrors;
  snapshot.natsStatus = bridge.status;
}

/** Build the complete server metrics snapshot for `getMetrics()`. */
export function buildServerMetrics(
  state: ServerState,
  eventsMetrics: MetricsSnapshot["events"],
): MetricsSnapshot {
  const snapshot = state.metrics.snapshot(state.sockets.size);
  snapshot.pathCounts = buildPathCounts(state);
  foldBridgeStats(snapshot, state.bridge);
  if (eventsMetrics !== undefined) snapshot.events = eventsMetrics;
  return snapshot;
}
