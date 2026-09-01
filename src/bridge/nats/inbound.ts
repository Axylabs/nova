/**
 * Inbound pipeline — the bridge's NATS→clients forward. Subscribes a subject
 * and, for each arriving frame: reads the envelope header (cheap), rejects
 * transport-internal control frames and non-allowlisted events, then decodes
 * the payload and hands `{name, payload}` to the wired `onInbound` callback.
 *
 * Decode failures are counted in `stats.bridgeInboundErrors`, never thrown —
 * the WS hot path must not depend on broker input being well-formed.
 */
import type { Bindings } from "../../bindings/types";
import type { NatsBridgeStats, NatsTransport } from "./types";

export function subscribeInboundSubject(deps: {
  transport: NatsTransport;
  bindings: Bindings;
  stats: NatsBridgeStats;
  subject: string;
  /** allowlist; `null` = forward every app event */
  allowlist: Set<string> | null;
  /** set once by the server (the fan-out-to-clients callback) */
  getOnInbound(): ((name: string, payload: unknown) => void) | null;
}): () => void {
  const { transport, bindings, stats, subject, allowlist } = deps;
  return transport.subscribe(subject, (data) => {
    // header-first: reject junk/control frames before any payload decode
    const header = bindings.readFrameHeader(data);
    if (!header) {
      stats.bridgeInboundErrors++;
      return;
    }
    if (bindings.isControlId(header.id)) {
      stats.bridgeInboundErrors++; // never forward transport-internal frames
      return;
    }
    if (allowlist && !allowlist.has(header.name)) return;
    let payload: unknown;
    try {
      payload = bindings.decodePayload(header.id, data);
    } catch {
      stats.bridgeInboundErrors++;
      return;
    }
    stats.bridgeInbound++;
    deps.getOnInbound()?.(header.name, payload);
  });
}
