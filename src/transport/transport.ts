/**
 * Internal transport: JS object → wire frame via Rust FFI (or the pure-JS
 * encoder for user schemas without a native addon).
 * frame = `[WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]` — fully
 * produced by Rust (envelope header is WIRE_HEADER_LEN = 5 bytes).
 *
 * Three paths:
 *   - DIRECT (flat events, generated): fields pushed straight into Rust as FFI
 *     args from a zero-alloc encoder — no JSON, no intermediate array, and a
 *     single reusable output scratch (`encodeToScratch`).
 *   - JSON fallback (events with vectors / nested tables): object → JSON →
 *     `fb_serialize` → Rust parses and builds (still allocates — documented).
 *   - JS fallback (user schemas without a native addon): the generated pure-JS
 *     encoder (`bindings.encodeFrame`) — correct everywhere, slower, and the
 *     default when `ffiMode: "optional"` and no addon is available.
 *
 * ALL per-event dispatch state is resolved EAGERLY at `createTransport()`
 * (instantiation time), not lazily on first encode: every known event name —
 * app AND control — gets an {@link EncodeRecord} up front, holding its event
 * id, generated encoder, NUL pre-scan and (once the addon binds) its direct
 * FFI symbol + encode-path counters. The hot path is then one Map hit plus a
 * couple of monomorphic field reads/increments — no lazy-init branches, no
 * second stats Map, no per-encode counter allocation.
 *
 * `createTransport(bindings)` is a per-schema factory: it owns its own scratch
 * + records + FFI binding, so several servers with different schemas can
 * coexist. The module-level `defaultTransport` (built-in registry, Rust
 * required) keeps the historical singleton behavior — `encodeToScratch` /
 * `encodeEvent` / `getEncodeStats` remain re-exported for backwards compat.
 */

import { defaultBindings } from "../bindings/default";
import type { Bindings, DirectEncoder } from "../bindings/types";
import { createFfi, type FfiDl } from "../native/ffi";
import { createScratch, MIN_CAP } from "./scratch";

/** Everything the hot path needs for one event — built once at instantiation. */
interface EncodeRecord {
  /** stable wire id (anyEventNameToId) — used by the JSON fallback */
  readonly id: number;
  /** generated zero-alloc encoder (absent for JSON-only events) */
  readonly encoder: DirectEncoder | undefined;
  /** FFI symbol name in the addon (absent when there is no direct table) */
  readonly symName: string | undefined;
  /** per-event NUL pre-scan (absent when the event has no string fields) */
  readonly hasNul: ((o: unknown) => boolean) | undefined;
  /**
   * Resolved FFI symbol: undefined = not yet bound OR disabled/JSON-only.
   * Flipped to a function once the addon binds; set back to undefined when a
   * runtime failure (`ffiMode: "optional"`) permanently demotes this event to
   * the JSON path.
   */
  call: ((...args: unknown[]) => number) | undefined;
  /** encode-path counters — incremented IN PLACE on the record (no Maps) */
  directCount: number;
  jsonCount: number;
  jsCount: number;
}

export interface Transport {
  /**
   * Zero-allocation encode into the transport's shared output scratch. The
   * returned view is only valid until the next call — publish/send it
   * immediately (Bun copies). Accepts app events AND control events.
   */
  encodeToScratch(name: string, payload: unknown): Uint8Array;
  /** Owned copy (safe to hold) — used by tests/bench. One allocation. */
  encodeEvent(name: string, payload: unknown): Uint8Array;
  /** encode-path stats (direct vs json vs js). */
  getEncodeStats(): {
    direct: Record<string, number>;
    json: Record<string, number>;
    js: Record<string, number>;
  };
}

export function createTransport(bindings: Bindings): Transport {
  const scratch = createScratch();

  // ── instantiation-time resolution: one record per known event ────────────
  const records = new Map<string, EncodeRecord>();
  for (const name of Object.keys(bindings.anyEventNameToId)) {
    const direct = bindings.direct;
    const encoder = direct?.encoders[name];
    const hasNul = direct?.hasNul[name];
    records.set(name, {
      id: bindings.anyEventNameToId[name] as number,
      encoder,
      ...(encoder !== undefined ? { symName: direct?.symbolNames[name] } : { symName: undefined }),
      hasNul,
      call: undefined,
      directCount: 0,
      jsonCount: 0,
      jsCount: 0,
    });
  }

  // Lazily bound once: undefined = not yet resolved, null = JS-only mode,
  // FfiDl = bound addon. For ffiMode "required" the bind throws (missing /
  // mismatched addon fails on first encode, as before); for "optional" it
  // resolves to null and the JS encoder is used.
  let ffi: FfiDl | null | undefined;
  const getFfiDl = (): FfiDl | null => {
    if (ffi === undefined) ffi = createFfi(bindings);
    return ffi;
  };

  /**
   * Bind the addon once and fan the resolved symbols out across ALL records
   * in a single pass — the first encode pays the dlopen + self-test, every
   * later encode sees a plain populated field. Self-test-disabled symbols are
   * left undefined (their events take the JSON path).
   */
  const bindSymbols = (): void => {
    const dl = getFfiDl();
    if (dl === null) return;
    const disabled = dl.disabledDirect;
    for (const r of records.values()) {
      if (r.encoder === undefined || r.symName === undefined) continue;
      if (disabled.has(r.symName)) continue;
      const sym = dl.raw[r.symName];
      if (sym !== undefined) r.call = sym;
    }
  };

  function encodeToScratch(name: string, payload: unknown): Uint8Array {
    const r = records.get(name);
    if (r === undefined) throw new Error(`ignex: unknown event "${name}"`);
    const encoder = r.encoder;
    if (encoder !== undefined) {
      if (r.call === undefined && ffi === undefined) bindSymbols();
      const call = r.call;
      if (call !== undefined) {
        // Embedded NULs route to JSON: the `cstring` direct path truncates
        // them (silent data loss); the JSON path preserves them exactly.
        if (!(r.hasNul?.(payload) ?? false)) {
          if (bindings.ffiMode !== "optional") {
            // required mode — zero-alloc hot path, no try/catch
            scratch.grow(MIN_CAP);
            const w = scratch.neededSize(name, encoder(call, payload, scratch.view), () =>
              encoder(r.call as (...args: unknown[]) => number, payload, scratch.view),
            );
            r.directCount++;
            return scratch.view.subarray(0, w);
          }
          try {
            scratch.grow(MIN_CAP);
            const w = scratch.neededSize(name, encoder(call, payload, scratch.view), () =>
              encoder(r.call as (...args: unknown[]) => number, payload, scratch.view),
            );
            r.directCount++;
            return scratch.view.subarray(0, w);
          } catch {
            // optional mode: a direct-call failure (e.g. ABI drift at runtime)
            // permanently demotes this event to the JSON path.
            r.call = undefined;
          }
        }
      }
    }

    const dl = ffi === undefined ? getFfiDl() : ffi;
    if (dl !== null) {
      // JSON fallback (vector/nested events, or a disabled direct symbol).
      const json = JSON.stringify(payload);
      scratch.grow(Math.max(MIN_CAP, json.length * 2 + 128));
      const w = scratch.neededSize(name, dl.bindings.fb_serialize(r.id, json, scratch.view), () =>
        dl.bindings.fb_serialize(r.id, json, scratch.view),
      );
      r.jsonCount++;
      return scratch.view.subarray(0, w);
    }

    // JS-only mode (user schema, no native addon) — the pure-JS encoder.
    const frame = bindings.encodeFrame(name, payload);
    r.jsCount++;
    return frame;
  }

  function encodeEvent(name: string, payload: unknown): Uint8Array {
    const frame = encodeToScratch(name, payload);
    const owned = new Uint8Array(frame.byteLength);
    owned.set(frame);
    return owned;
  }

  return {
    encodeToScratch,
    encodeEvent,
    getEncodeStats() {
      const direct: Record<string, number> = {};
      const json: Record<string, number> = {};
      const js: Record<string, number> = {};
      for (const [name, r] of records) {
        if (r.directCount > 0) direct[name] = r.directCount;
        if (r.jsonCount > 0) json[name] = r.jsonCount;
        if (r.jsCount > 0) js[name] = r.jsCount;
      }
      return { direct, json, js };
    },
  };
}

// ── default transport (built-in registry) ──────────────────────────────────
// Module-level singleton — the historical zero-alloc hot path. Re-exported
// below so existing imports (`outbound.ts` migration aside) keep working.

export const defaultTransport: Transport = createTransport(defaultBindings);

/** Zero-allocation encode into the shared output scratch (built-in registry). */
export function encodeToScratch(name: string, payload: unknown): Uint8Array {
  return defaultTransport.encodeToScratch(name, payload);
}

/** Owned copy (safe to hold) — used by tests/bench. One allocation. */
export function encodeEvent(name: string, payload: unknown): Uint8Array {
  return defaultTransport.encodeEvent(name, payload);
}

/** encode-path stats for the built-in registry (direct vs JSON). */
export function getEncodeStats(): {
  direct: Record<string, number>;
  json: Record<string, number>;
  js: Record<string, number>;
} {
  return defaultTransport.getEncodeStats();
}
