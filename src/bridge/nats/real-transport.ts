/**
 * Real NATS transport — an eager, non-blocking `NatsConnection` wrapper with
 * an initial-connect retry loop, so a server can start while NATS is down.
 *
 * Subscriptions are RE-SYNCED on every (re)connect: the desired subject set
 * is kept locally and replayed onto whichever connection is current —
 * nats.js re-subscribes automatically after a reconnect, but the resync
 * guards against edge cases (e.g. a replaced connection).
 */
import { connect, type NatsConnection } from "nats";
import type { NatsBridgeOptions, NatsTransport } from "./types";

interface PendingSub {
  subject: string;
  cb: (data: Uint8Array) => void;
}

export function createRealTransport(opts: NatsBridgeOptions): NatsTransport {
  let nc: NatsConnection | null = null;
  let connected = false;
  let closed = false;
  // desired subscriptions — replayed on every (re)connect via sync()
  const subs: Array<PendingSub> = [];
  let unsubs: Array<() => void> = [];

  /** Tear down the current subscription iterators and re-subscribe all. */
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

  /** Track connection liveness + trigger resyncs from nats.js status events. */
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

  let connecting = false;
  const tryConnect = async (): Promise<void> => {
    // one attempt at a time; a live connection (even mid-reconnect, which
    // nats.js drives internally) is never replaced by a duplicate dial
    if (closed || connecting || nc !== null) return;
    connecting = true;
    try {
      const conn = await connect({
        servers: opts.servers ?? ["nats://localhost:4222"],
        ...(opts.token !== undefined ? { token: opts.token } : {}),
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
    } finally {
      connecting = false;
    }
  };

  // background retry loop — the caller NEVER awaits a dial
  void (async () => {
    while (!closed) {
      if (nc === null) await tryConnect();
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
