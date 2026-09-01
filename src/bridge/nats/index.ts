/**
 * NATS bridge — bidirectional FlatBuffer transport over NATS (composition
 * root). Decomposed by concern:
 *
 *   types.ts          — options / stats / NatsTransport / NatsBridge contracts
 *   real-transport.ts — the eager, non-blocking connection with retry loop
 *   inbound.ts        — the NATS→clients decode + filter pipeline
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
 * HORIZONTAL SCALING: when `bridgeClientEvents` is set, the server re-publishes
 * every accepted client-sent event to `{prefix}.inbound.<event>` so OTHER
 * server instances (and BE consumers) receive it. Loop prevention: frames that
 * arrive via NATS are forwarded through `onInbound` and never re-bridged.
 *
 * GENERIC: decodes inbound frames with the given `Bindings` (default: the
 * built-in registry), so the bridge works for ANY schema. Tests can inject an
 * `NatsTransport` fake — no broker needed in CI.
 */
import { defaultBindings } from "../../bindings/default";
import type { Bindings } from "../../bindings/types";
import { createSubjectBuilder } from "../subjects";
import { subscribeInboundSubject } from "./inbound";
import { createRealTransport } from "./real-transport";
import type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
} from "./types";

export type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
} from "./types";

export function createNatsBridge(
  opts: NatsBridgeOptions = {},
  transport?: NatsTransport,
  bindings?: Bindings,
): NatsBridge {
  const b = bindings ?? opts.bindings ?? defaultBindings;
  const t = transport ?? createRealTransport(opts);
  const subjects = createSubjectBuilder(opts.subjectPrefix ?? b.subjectPrefix ?? "ignex");
  const stats: NatsBridgeStats = {
    bridged: 0,
    bridgedBytes: 0,
    bridgeErrors: 0,
    bridgeInbound: 0,
    bridgeInboundErrors: 0,
  };
  let closed = false;
  let onInbound: ((name: string, payload: unknown) => void) | null = null;
  // stable accessor (the callback slot is set once by the server later)
  const getOnInbound = (): ((name: string, payload: unknown) => void) | null => onInbound;
  const allowlist = opts.inboundEvents ? new Set(opts.inboundEvents) : null;

  // inbound subscriptions (lazy — the transport queues them until connected)
  const unsubs: Array<() => void> = [];
  if (opts.inbound) {
    const subjectsList = opts.inboundSubjects?.length
      ? opts.inboundSubjects
      : [subjects.inboundPrefix()];
    for (const subject of subjectsList) {
      unsubs.push(
        subscribeInboundSubject({
          transport: t,
          bindings: b,
          stats,
          subject,
          allowlist,
          getOnInbound,
        }),
      );
    }
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
    get clientEvents(): boolean {
      return opts.bridgeClientEvents ?? false;
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
    subscribeRaw(subject, cb) {
      return t.subscribe(subject, (data) => cb(data));
    },
    async close() {
      closed = true;
      for (const u of unsubs) u();
      await t.close();
    },
  };
}
