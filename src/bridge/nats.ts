/**
 * NATS bridge — bidirectional FlatBuffer transport over NATS.
 *
 * OUTBOUND: the server encodes each event ONCE (Rust FFI → scratch), fans the
 * same frame out to WS clients, then hands a COPY to `bridge.publish(subject,
 * frame)` so other applications consume the identical wire bytes. Best-effort:
 * if NATS is down the frame is dropped and counted in `bridgeErrors` — it
 * never blocks or throws on the WS hot path.
 *
 * INBOUND: when `inbound` is enabled the bridge subscribes to `{prefix}.
 * inbound.>` and forwards decodable app events to `onInbound` (wired by the
 * server to fan out to clients). Control frames and unknown ids are dropped.
 *
 * The connection is created eagerly but non-blocking: `connect()` runs in the
 * background with a retry loop, so a server can start while NATS is down.
 * `createNatsBridge(opts, transport?)` accepts an injectable `NatsTransport`
 * so tests can fake NATS entirely (no server needed in CI).
 */
import { connect, type NatsConnection } from "nats";
import { decodePayload, isControlId, readFrameHeader } from "../generated/registry";
import type { EventName } from "../schema";
import { createSubjectBuilder, type SubjectBuilder } from "./subjects";

export type NatsBridgeStatus = "connected" | "connecting" | "closed";

export interface NatsBridgeOptions {
  /** NATS servers, default ["nats://localhost:4222"] */
  servers?: string[];
  /** subject prefix, default "ignex" */
  subjectPrefix?: string;
  /** connect timeout (ms), default 5000 */
  connectTimeout?: number;
  /** how long to wait before retrying a failed initial connect (ms), default 2000 */
  connectRetryMs?: number;
  /** reconnect handled by nats.js (core NATS, no durable queues), default true */
  reconnect?: boolean;
  /** optional NATS token (auth) */
  token?: string;
  /** subscribe to inbound subjects and forward events to clients, default false */
  inbound?: boolean;
  /** inbound subjects (default `{prefix}.inbound.>`), requires `inbound` */
  inboundSubjects?: string[];
  /** only forward these inbound events (default: every app event) */
  inboundEvents?: EventName[];
}

/** Counters folded into `server.getMetrics()`. */
export interface NatsBridgeStats {
  bridged: number;
  bridgedBytes: number;
  bridgeErrors: number;
  bridgeInbound: number;
  bridgeInboundErrors: number;
}

/** Minimal transport — a real NATS connection or a test fake. */
export interface NatsTransport {
  readonly connected: boolean;
  /** synchronously send bytes; throws when not connected (bridge catches + counts) */
  publish(subject: string, data: Uint8Array): void;
  /** subscribe; `cb` receives message bytes; returns an unsubscribe function */
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

export interface NatsBridge {
  readonly status: NatsBridgeStatus;
  readonly subjects: SubjectBuilder;
  readonly stats: NatsBridgeStats;
  /** publish a frame to `subject` (copies the bytes — safe after scratch reuse) */
  publish(subject: string, frame: Uint8Array): void;
  /** wire the inbound → clients forward (set once by the server) */
  setOnInbound(cb: (name: EventName, payload: unknown) => void): void;
  close(): Promise<void>;
}

/** Eager, non-blocking real transport with an initial-connect retry loop. */
function createRealTransport(opts: NatsBridgeOptions): NatsTransport {
  let nc: NatsConnection | null = null;
  let connected = false;
  let closed = false;
  const subs: Array<{ subject: string; cb: (data: Uint8Array) => void }> = [];
  let unsubs: Array<() => void> = [];

  const sync = (): void => {
    for (const u of unsubs) u();
    unsubs = [];
    if (!nc) return;
    for (const s of subs) {
      const sub = nc.subscribe(s.subject);
      unsubs.push(() => sub.unsubscribe());
      void (async () => {
        try {
          for await (const m of sub) s.cb(new Uint8Array(m.data));
        } catch {
          // subscription ended / connection closed
        }
      })();
    }
  };

  const attachStatus = (conn: NatsConnection): void => {
    void conn
      .closed()
      .then(() => {
        connected = false;
        if (nc === conn) nc = null;
      })
      .catch(() => {
        connected = false;
      });
    void (async () => {
      try {
        for await (const st of conn.status()) {
          if (st.type === "disconnect") connected = false;
          else if (st.type === "reconnect") {
            connected = true;
            sync(); // nats.js re-subscribes automatically; resync to be safe
          }
        }
      } catch {
        connected = false;
      }
    })();
  };

  const tryConnect = async (): Promise<void> => {
    if (closed) return;
    try {
      const conn = await connect({
        servers: opts.servers ?? ["nats://localhost:4222"],
        token: opts.token,
        timeout: opts.connectTimeout ?? 5000,
        reconnect: opts.reconnect ?? true,
        maxReconnectAttempts: -1,
      });
      nc = conn;
      connected = true;
      attachStatus(conn);
      sync();
    } catch {
      connected = false;
    }
  };

  void (async () => {
    while (!closed) {
      if (!nc || !connected) await tryConnect();
      await Bun.sleep(opts.connectRetryMs ?? 2000);
    }
  })();

  return {
    get connected() {
      return connected;
    },
    publish(subject, data) {
      if (!nc) throw new Error("nats: not connected");
      nc.publish(subject, data);
    },
    subscribe(subject, cb) {
      subs.push({ subject, cb });
      sync();
      return () => {
        const i = subs.findIndex((s) => s.subject === subject && s.cb === cb);
        if (i >= 0) subs.splice(i, 1);
        sync();
      };
    },
    async close() {
      closed = true;
      if (nc) {
        try {
          await nc.close();
        } catch {
          // already closed
        }
      }
      nc = null;
      connected = false;
    },
  };
}

export function createNatsBridge(
  opts: NatsBridgeOptions = {},
  transport?: NatsTransport,
): NatsBridge {
  const t = transport ?? createRealTransport(opts);
  const subjects = createSubjectBuilder(opts.subjectPrefix);
  const stats: NatsBridgeStats = {
    bridged: 0,
    bridgedBytes: 0,
    bridgeErrors: 0,
    bridgeInbound: 0,
    bridgeInboundErrors: 0,
  };
  let closed = false;
  let onInbound: ((name: EventName, payload: unknown) => void) | null = null;
  const allowlist = opts.inboundEvents ? new Set(opts.inboundEvents) : null;

  // inbound subscriptions (lazy — the transport queues them until connected)
  const subscribeInbound = (subject: string): (() => void) => {
    return t.subscribe(subject, (data) => {
      const header = readFrameHeader(data);
      if (!header) {
        stats.bridgeInboundErrors++;
        return;
      }
      if (isControlId(header.id)) {
        stats.bridgeInboundErrors++; // never forward transport-internal frames
        return;
      }
      const name = header.name as EventName;
      if (allowlist && !allowlist.has(name)) return;
      let payload: unknown;
      try {
        payload = decodePayload(header.id, data);
      } catch {
        stats.bridgeInboundErrors++;
        return;
      }
      stats.bridgeInbound++;
      onInbound?.(name, payload);
    });
  };

  const unsubs: Array<() => void> = [];
  if (opts.inbound) {
    const subjectsList = opts.inboundSubjects?.length ? opts.inboundSubjects : [subjects.inboundPrefix()];
    for (const subject of subjectsList) unsubs.push(subscribeInbound(subject));
  }

  return {
    get status(): NatsBridgeStatus {
      if (closed) return "closed";
      return t.connected ? "connected" : "connecting";
    },
    get subjects() {
      return subjects;
    },
    get stats() {
      return stats;
    },
    publish(subject, frame) {
      if (!t.connected) {
        stats.bridgeErrors++;
        return;
      }
      // the frame view is a reused scratch — copy before handing to NATS
      const copy = frame.slice();
      try {
        t.publish(subject, copy);
        stats.bridged++;
        stats.bridgedBytes += copy.byteLength;
      } catch {
        stats.bridgeErrors++;
      }
    },
    setOnInbound(cb) {
      onInbound = cb;
    },
    async close() {
      closed = true;
      for (const u of unsubs) u();
      await t.close();
    },
  };
}
