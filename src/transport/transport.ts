/**
 * Internal transport: JS object → wire frame via Rust FFI.
 * frame = `[1-byte event_id][size-prefixed FlatBuffer]` — fully produced by Rust.
 *
 * Two paths:
 *   - DIRECT (flat events, generated): fields pushed straight into Rust as FFI
 *     args from a zero-alloc encoder — no JSON, no intermediate array, and a
 *     single reusable output scratch (`encodeToScratch`).
 *   - JSON fallback (events with vectors / nested tables): object → JSON →
 *     `fb_serialize` → Rust parses and builds (still allocates — documented).
 */
import { directEncoders, directSymbolNames, hasNulEncoders } from "../generated/direct-ser";
import { anyEventNameToId } from "../generated/registry";
import type { AnyEventName } from "../schema";
import { getDirectSymbol, getFfi } from "../native/ffi";
import { createScratch, MIN_CAP } from "./scratch";
import { createStats } from "./stats";

// Single reusable output scratch + encode-path stats, created once per process
// and reused for every encode (the zero-alloc hot path). Safe to reuse right
// after `ws.send` — Bun copies binary frames synchronously (verified
// empirically). These are intentionally module-level singletons: threading
// them through every encode call would only add parameter churn to the hot
// path for no functional gain.
const scratch = createScratch();
const stats = createStats();

/**
 * Resolved direct-path record for one event — populated lazily on first encode
 * and immutable afterwards (a direct symbol that was disabled by the bind-time
 * self-test never re-enables, so caching the resolved call is safe).
 */
interface ResolvedDirect {
  /** generated zero-alloc encoder (absent for JSON-only events) */
  encoder?: (call: (...args: unknown[]) => number, o: unknown, out: Uint8Array) => number;
  /** resolved FFI symbol (undefined = symbol disabled → JSON fallback) */
  call?: (...args: unknown[]) => number;
  /** per-event NUL pre-scan (absent when the event has no string fields) */
  hasNul?: (o: unknown) => boolean;
}
const resolvedDirect = new Map<string, ResolvedDirect>();

function resolveDirect(name: AnyEventName): ResolvedDirect {
  let r = resolvedDirect.get(name);
  if (r === undefined) {
    r = {};
    const encoder = directEncoders[name];
    if (encoder) {
      r.encoder = encoder;
      r.call = getDirectSymbol(directSymbolNames[name]!);
      r.hasNul = hasNulEncoders[name];
    }
    resolvedDirect.set(name, r);
  }
  return r;
}

/**
 * Zero-allocation encode into the shared output scratch. The returned view is
 * only valid until the next call — publish/send it immediately (Bun copies).
 * Accepts app events AND control events (hello/subscribe/ping/...) — the
 * server encodes both through the Rust FFI.
 */
export function encodeToScratch(name: AnyEventName, payload: unknown): Uint8Array {
  const r = resolveDirect(name);
  const encoder = r.encoder;
  if (encoder && r.call) {
    // `call` is undefined when the bind-time self-test disabled the symbol —
    // fall through to the JSON path (graceful degradation). Embedded NULs route
    // to JSON too: the `cstring` direct path truncates them (silent data loss),
    // the JSON path preserves them exactly.
    if (!(r.hasNul?.(payload) ?? false)) {
      scratch.grow(MIN_CAP);
      const w = scratch.neededSize(name, encoder(r.call, payload, scratch.view), () => encoder(r.call!, payload, scratch.view));
      stats.bump(name, "direct");
      return scratch.view.subarray(0, w);
    }
  }

  // JSON fallback (vector/nested events, or a disabled direct symbol).
  const id = anyEventNameToId[name];
  if (id === undefined) throw new Error(`ignex: unknown event "${name}"`);

  const json = JSON.stringify(payload);
  const ffi = getFfi();
  scratch.grow(Math.max(MIN_CAP, json.length * 2 + 128));
  const w = scratch.neededSize(name, ffi.fb_serialize(id, json, scratch.view), () => ffi.fb_serialize(id, json, scratch.view));
  stats.bump(name, "json");
  return scratch.view.subarray(0, w);
}

// ── encode-path stats (direct vs JSON) ─────────────────────────────────
// Accumulated per event name across the process (typical deployments run one
// server per process). Surfaced via `getEncodeStats()` / `server.metrics()`.

export function getEncodeStats(): { direct: Record<string, number>; json: Record<string, number> } {
  return stats.get();
}

/** Owned copy (safe to hold) — used by tests/bench. One allocation. */
export function encodeEvent(name: AnyEventName, payload: unknown): Uint8Array {
  const frame = encodeToScratch(name, payload);
  const owned = new Uint8Array(frame.byteLength);
  owned.set(frame);
  return owned;
}
