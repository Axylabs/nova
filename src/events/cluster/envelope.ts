/**
 * Cluster envelope codec — the self-describing binary frame published to the
 * broker. Routing never depends on broker channel syntax; everything a peer
 * needs (origin, kind, key, event name, dedupe id, trace id) rides in the
 * header so any transport works identically.
 *
 * Wire layout (v2):
 *   [envVer:1]
 *   [originLen:u8][origin:utf8][kind:u8][keyLen:u8][key:utf8][nameLen:u8][name:utf8]
 *   [msgIdLen:u8][msgId:utf8][traceLen:u8][trace:utf8]
 *   [frame:bytes]
 *
 * v2 adds the envelope VERSION byte, a message id (broker-level redelivery
 * dedupe) and an optional trace id (cross-instance trace correlation). A v1
 * peer's frames fail the version check and are counted as errors.
 *
 * Pure functions — no I/O, no shared state.
 */
import {
  CLUSTER_ENV_VERSION,
  CLUSTER_KINDS,
  CLUSTER_KIND_ID,
  type ClusterKind,
  clusterKindFromId,
} from "./kinds";

// module-global codecs: allocation happens once per process, not per message
const enc = new TextEncoder();
const dec = new TextDecoder();

/** One decoded cluster message (`frame` is a view into the input buffer). */
export interface ClusterEnvelope {
  origin: string;
  kind: ClusterKind;
  key: string;
  name: string;
  frame: Uint8Array;
  /** producer-assigned unique message id (dedupe across broker redeliveries) */
  msgId: string;
  /** optional cross-instance trace id */
  traceId: string;
}

/** Write `[len:u8][bytes]` at `p`; returns the offset after the payload. */
function putLenPrefixed(out: Uint8Array, p: number, bytes: Uint8Array): number {
  out[p] = bytes.byteLength;
  out.set(bytes, p + 1);
  return p + 1 + bytes.byteLength;
}

/** Encode all length-prefixed header strings up-front (also validates sizes). */
function encodeHeaderStrings(
  origin: string,
  key: string,
  name: string,
  msgId: string,
  traceId: string,
): [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const o = enc.encode(origin);
  const k = enc.encode(key);
  const n = enc.encode(name);
  const m = enc.encode(msgId);
  const t = enc.encode(traceId);
  // length fields are single bytes — anything longer would silently wrap
  // mod 256 and CORRUPT the frame for every peer; fail loudly instead
  if (
    o.byteLength > 255 ||
    k.byteLength > 255 ||
    n.byteLength > 255 ||
    m.byteLength > 255 ||
    t.byteLength > 255
  ) {
    throw new RangeError(
      "ignex cluster: origin/key/name/msgId/trace exceed the 255-byte envelope limit " +
        `(got ${o.byteLength}/${k.byteLength}/${n.byteLength}/${m.byteLength}/${t.byteLength})`,
    );
  }
  return [o, k, n, m, t];
}

export function encodeClusterMessage(
  origin: string,
  kind: ClusterKind,
  key: string,
  name: string,
  frame: Uint8Array,
  msgId = "",
  traceId = "",
): Uint8Array {
  const [o, k, n, m, t] = encodeHeaderStrings(origin, key, name, msgId, traceId);
  // fixed bytes: envVer(1) originLen(1) kind(1) keyLen(1) nameLen(1) msgIdLen(1) traceLen(1)
  const headerLen = 7 + o.byteLength + k.byteLength + n.byteLength + m.byteLength + t.byteLength;
  const out = new Uint8Array(headerLen + frame.byteLength);
  let p = 0;
  out[p] = CLUSTER_ENV_VERSION;
  p++;
  p = putLenPrefixed(out, p, o);
  out[p] = CLUSTER_KIND_ID[kind];
  p++;
  p = putLenPrefixed(out, p, k);
  p = putLenPrefixed(out, p, n);
  p = putLenPrefixed(out, p, m);
  p = putLenPrefixed(out, p, t);
  out.set(frame, p);
  return out;
}

/** Read one length-prefixed string at `at`; `null` when truncated/malformed. */
function readLenPrefixed(
  bytes: Uint8Array,
  at: number,
): { str: string; next: number } | null {
  if (at >= bytes.byteLength) return null;
  const len = bytes[at]!;
  if (at + 1 + len > bytes.byteLength) return null;
  return { str: dec.decode(bytes.subarray(at + 1, at + 1 + len)), next: at + 1 + len };
}

/**
 * Decode a cluster envelope. Returns `null` for undecodable input or a
 * foreign/legacy envelope version (callers count those as errors).
 */
export function decodeClusterMessage(bytes: Uint8Array): ClusterEnvelope | null {
  if (bytes.byteLength < 4) return null;
  if (bytes[0] !== CLUSTER_ENV_VERSION) return null; // foreign / legacy envelope
  const o = readLenPrefixed(bytes, 1);
  if (!o) return null;
  const kindId = bytes[o.next];
  if (kindId === undefined || kindId >= CLUSTER_KINDS.length) return null;
  const k = readLenPrefixed(bytes, o.next + 1);
  if (!k) return null;
  const n = readLenPrefixed(bytes, k.next);
  if (!n) return null;
  const m = readLenPrefixed(bytes, n.next);
  if (!m) return null;
  const t = readLenPrefixed(bytes, m.next);
  if (!t) return null;
  const kind = clusterKindFromId(kindId);
  if (kind === undefined) return null;
  return {
    origin: o.str,
    kind,
    key: k.str,
    name: n.str,
    msgId: m.str,
    traceId: t.str,
    frame: bytes.subarray(t.next),
  };
}
