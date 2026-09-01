/**
 * Server-side metrics counters — a `createMetrics()` factory returning a plain
 * counter object (no class, no `this`). Zero dependencies and zero allocation
 * in the steady state (every counter is a plain number field).
 *
 * Per-event encode-path counts (`pathCounts`) are NOT tracked here: they live
 * once, cumulatively, in the transport's per-event records and are derived at
 * read time by `server.getMetrics()` — polling can never double-count.
 */
export interface PathCounts {
  /** encodes that used the zero-alloc Rust FFI direct fast path */
  direct: number;
  /** encodes that fell back to the JSON path (nested/unions or disabled symbol) */
  json: number;
  /** encodes via the pure-JS encoder (user schema without a native addon) */
  js: number;
}

export interface MetricsSnapshot {
  /** encode calls (publish / publishTo / publishToTopic) */
  published: number;
  /** frames actually handed to a socket */
  sent: number;
  /** frames skipped because the socket was over its high-water mark (drop-newest) */
  droppedNewest: number;
  /** frames dropped from a slow socket's bounded queue (drop-oldest) */
  droppedOldest: number;
  /** slow consumers closed by the disconnect policy */
  disconnectedSlow: number;
  /** inbound app messages delivered to server.on() handlers */
  inbound: number;
  /** inbound control frames routed internally */
  inboundControl: number;
  /** undecodable / version-mismatched / unknown-id frames received */
  protocolErrors: number;
  /** inbound frames shed by the per-connection rate limiter */
  rateLimited: number;
  /** topic/group joins rejected by `authorizeTopic` / `authorizeGroup` */
  rejectedJoins: number;
  bytesSent: number;
  /** frames stamped with a per-connection delivery seq (envelope v2, resume on) */
  stampedSeq: number;
  /** `resume` control frames served from a connection's history ring */
  resumesServed: number;
  /** frames re-delivered by resume replays */
  framesReplayed: number;
  /** resume requests that could not fully fill the requested hole */
  resumeMisses: number;
  /** per-event encode path counts (derived from the transport at read time) */
  pathCounts: Record<string, PathCounts>;
  connectedClients: number;
  uptimeMs: number;
  /** NATS bridge counters (present only when a bridge is configured) */
  bridged?: number;
  bridgedBytes?: number;
  bridgeErrors?: number;
  bridgeInbound?: number;
  bridgeInboundErrors?: number;
  /** "connected" | "connecting" | "closed" (undefined when no bridge) */
  natsStatus?: string;
  /** events-layer counters (present only when `createServer({ events })` is used) */
  events?: import("../events/types").EventsMetricsSnapshot;
}

export interface Metrics {
  published: number;
  sent: number;
  droppedNewest: number;
  droppedOldest: number;
  disconnectedSlow: number;
  inbound: number;
  inboundControl: number;
  protocolErrors: number;
  rateLimited: number;
  rejectedJoins: number;
  bytesSent: number;
  stampedSeq: number;
  resumesServed: number;
  framesReplayed: number;
  resumeMisses: number;
  snapshot(connectedClients: number): MetricsSnapshot;
}

export function createMetrics(startedAt = Date.now()): Metrics {
  const m: Metrics = {
    published: 0,
    sent: 0,
    droppedNewest: 0,
    droppedOldest: 0,
    disconnectedSlow: 0,
    inbound: 0,
    inboundControl: 0,
    protocolErrors: 0,
    rateLimited: 0,
    rejectedJoins: 0,
    bytesSent: 0,
    stampedSeq: 0,
    resumesServed: 0,
    framesReplayed: 0,
    resumeMisses: 0,
    snapshot(connectedClients) {
      return {
        published: m.published,
        sent: m.sent,
        droppedNewest: m.droppedNewest,
        droppedOldest: m.droppedOldest,
        disconnectedSlow: m.disconnectedSlow,
        inbound: m.inbound,
        inboundControl: m.inboundControl,
        protocolErrors: m.protocolErrors,
        rateLimited: m.rateLimited,
        rejectedJoins: m.rejectedJoins,
        bytesSent: m.bytesSent,
        stampedSeq: m.stampedSeq,
        resumesServed: m.resumesServed,
        framesReplayed: m.framesReplayed,
        resumeMisses: m.resumeMisses,
        pathCounts: {},
        connectedClients,
        uptimeMs: Date.now() - startedAt,
      };
    },
  };

  return m;
}
