/**
 * Presence messages — the tiny JSON payloads exchanged on the `presence`
 * channel (kind = "presence", frame = JSON) so instances learn about each
 * other's connections WITHOUT any shared state.
 *
 * Pure codec module.
 */

/** A connection joined on instance `i`. */
export interface PresenceJoin {
  t: "j";
  i: string;
  c: string;
  u?: string;
  at: number;
}

/** A connection left instance `i`. */
export interface PresenceLeave {
  t: "l";
  i: string;
  c: string;
}

/** Periodic per-instance heartbeat (also refreshes liveness). */
export interface PresenceSync {
  t: "s";
  i: string;
  at: number;
}

export type PresenceMessage = PresenceJoin | PresenceLeave | PresenceSync;

// module-global codecs: allocated once, reused for every message
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode a presence message into the envelope's frame bytes. */
export function encodePresence(msg: PresenceMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

/**
 * Decode presence bytes; `null` when malformed (callers drop silently —
 * presence is advisory and self-healing via heartbeat/TTL).
 */
export function decodePresence(bytes: Uint8Array): PresenceMessage | null {
  try {
    return JSON.parse(dec.decode(bytes)) as PresenceMessage;
  } catch {
    return null;
  }
}
