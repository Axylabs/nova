/**
 * `bun:ffi` binding to the Rust cdylib — the ONLY place that talks to native.
 *
 * Bun 1.4 standard practices (per the castrum FFI guide):
 *   - `dlopen` once, bind lazily, never `close()` (dlclose-on-GC is unsound)
 *   - `buffer`/`buffer_length` ABI pair → the engine reads ptr + byteLength off
 *     the SAME view at call time (atomic snapshot) — the "peak"/pointer + length
 *     pattern. Call sites pass the view twice.
 *   - `cstring` arg → the engine transcodes the JS string to a NUL-terminated
 *     UTF-8 buffer (zero JS-side encoding).
 *   - `u64_fast` return → byte counts surface as plain `number`, not BigInt.
 *   - bind-time self-test (`fb_probe` + a JSON `fb_serialize` frame + every
 *     direct symbol via the generated `directSelfTest`); a failing direct
 *     symbol is DISABLED and its event falls back to the JSON path (graceful
 *     degradation instead of a hard throw).
 *   - `probeBufferLength()` at bind: if the Bun build rejects the
 *     `buffer`/`buffer_length` pair, fall back to explicit `(ptr, usize)`
 *     output pairs. The `abi()` transformer keeps the shipped specs canonical
 *     (`(ptr, usize)` outputs) and upgrades them at bind time.
 */
import { dlopen, type FFITypeOrString } from "bun:ffi";
import { directSelfTest, directSymbols } from "../generated/direct-ser";
import { eventNameToId, WIRE_HEADER_LEN, WIRE_VERSION } from "../generated/registry";
import type { EventName } from "../schema";
import { getAddonPath } from "./loader";

export const FB_PROBE_MAGIC = 0x4947_4e58; // "IGNX"

export interface BunFfi {
  /** (eventId, JSON string, out view) → bytes written; 0 = error; >cap = needed */
  fb_serialize(eventId: number, json: string, out: Uint8Array): number;
  fb_probe(): number;
  /** Wire-format version of the cdylib (must equal generated WIRE_VERSION). */
  fb_wire_version(): number;
}

/** Output-buffer ABI mode of the live binding (set once by `bind()`). */
export type BufferAbiMode = "buffer-pair" | "ptr-len";

interface Dl {
  bindings: BunFfi;
  /** every bound symbol, callable with raw args (…fieldArgs, out, out) */
  raw: Record<string, (...args: unknown[]) => number>;
  /** direct symbols disabled by the bind-time self-test (fall back to JSON). */
  disabledDirect: Set<string>;
  bufferAbiMode: BufferAbiMode;
}

let cachedDl: Dl | null | undefined;
let bufferAbiMode: BufferAbiMode = "ptr-len";

const U64_FAST = "u64_fast" as unknown as FFITypeOrString;

/**
 * Probe whether this Bun build accepts the `buffer`/`buffer_length` ABI pair in
 * `dlopen`. Uses the diagnostic `ffi_probe_echo_view` symbol (bench-only, NOT in
 * the shipped surface) bound with the pair and called with the same view twice —
 * the engine reads ptr + byteLength off that object at call time. An older Bun
 * canary threw "invalid ABI type" for `buffer_length`; on any failure we keep
 * explicit `(ptr, usize)` pairs (castrum rule: never hardcode the pair).
 */
function probeBufferLength(path: string): boolean {
  // Test hook: force the `(ptr, usize)` fallback to validate the degraded path.
  if (process.env.IGNEX_FFI_FORCE_PTR_LEN === "1") return false;
  try {
    const { symbols } = dlopen(path, {
      ffi_probe_echo_view: {
        args: ["buffer", "buffer_length"] as unknown as readonly FFITypeOrString[],
        // `u64_fast` returns a plain `number` (not a BigInt) for small values.
        returns: U64_FAST,
      },
    });
    const fn = (symbols as unknown as Record<string, (a: unknown, b: unknown) => unknown>).ffi_probe_echo_view;
    const view = new Uint8Array([1, 2, 3]);
    const out = fn?.(view, view);
    return typeof out === "number" && out >= 0;
  } catch {
    return false;
  }
}

/**
 * Positional pair-aware `(ptr, usize)` → `(buffer, buffer_length)` upgrade.
 * Each `ptr` consumes its following `usize` as a length; scalar `usize` args
 * that happen to appear (future opaque handles) pass through unchanged.
 * Applied to canonical specs at bind time; a `buffer`/`usize` INPUT pair is
 * left untouched (explicit JS length — no atomic-snapshot need).
 */
const abi = (shape: readonly string[]): readonly FFITypeOrString[] => {
  if (bufferAbiMode !== "buffer-pair") return shape as readonly FFITypeOrString[];
  const out: FFITypeOrString[] = [];
  for (let i = 0; i < shape.length; i++) {
    const t = shape[i];
    if (t === "ptr") {
      out.push("buffer" as unknown as FFITypeOrString);
      out.push("buffer_length" as unknown as FFITypeOrString);
      i++; // consume the paired `usize`
    } else {
      out.push(t as FFITypeOrString);
    }
  }
  return out;
};

/**
 * Mode-aware wrapper for symbols whose LAST TWO args are the output view passed
 * twice (`…, out, out`). In `ptr-len` mode the trailing `out` becomes
 * `out.byteLength` so the explicit `(ptr, usize)` spec receives a length number.
 */
function adaptOut(sym: (...a: unknown[]) => number, mode: BufferAbiMode): (...a: unknown[]) => number {
  if (mode !== "ptr-len") return sym;
  return (...args: unknown[]) => {
    if (args.length === 0) return sym(...args); // fb_probe: no output pair
    const out = args[args.length - 1] as Uint8Array;
    args[args.length - 1] = out.byteLength;
    return sym(...args);
  };
}

function bind(): Dl {
  const path = getAddonPath();

  // Probe the atomic `buffer`/`buffer_length` pair once; fall back to explicit
  // `(ptr, usize)` output pairs when the Bun build rejects it.
  bufferAbiMode = probeBufferLength(path) ? "buffer-pair" : "ptr-len";

  // Build the dlopen map from CANONICAL specs, upgrading `ptr` outputs to the
  // `buffer`/`buffer_length` pair when supported.
  const specMap: Record<string, { args: readonly FFITypeOrString[]; returns: FFITypeOrString }> = {
    fb_serialize: { args: abi(["u32", "cstring", "ptr", "usize"]), returns: U64_FAST },
    fb_probe: { args: [], returns: "u32" },
    fb_wire_version: { args: [], returns: "u32" },
  };
  for (const [name, spec] of Object.entries(directSymbols)) {
    specMap[name] = { args: abi(spec.args), returns: spec.returns as FFITypeOrString };
  }

  const { symbols } = dlopen(path, specMap as unknown as Parameters<typeof dlopen>[1]);

  // Adapt every bound symbol so call sites always pass `(…, out, out)`.
  const raw: Record<string, (...args: unknown[]) => number> = {};
  for (const [name, sym] of Object.entries(symbols as unknown as Record<string, (...args: unknown[]) => number>)) {
    raw[name] = adaptOut(sym, bufferAbiMode);
  }

  const bindings: BunFfi = {
    fb_serialize: (eventId, json, out) => raw["fb_serialize"]!(eventId, json, out, out) as number,
    fb_probe: () => raw["fb_probe"]!() as number,
    fb_wire_version: () => raw["fb_wire_version"]!() as number,
  };

  // ── Bind-time self-tests ─────────────────────────────────────────────
  if (bindings.fb_probe() !== FB_PROBE_MAGIC) {
    throw new Error(`ignex: FFI self-test failed (fb_probe mismatch) — addon at ${path}`);
  }
  // Wire-version drift check: a stale cdylib (built from an older schema /
  // envelope) must fail loudly at bind instead of producing undecodable frames.
  if (bindings.fb_wire_version() !== WIRE_VERSION) {
    throw new Error(
      `ignex: FFI self-test failed (wire version ${bindings.fb_wire_version()} !== ${WIRE_VERSION}) — addon at ${path}; regenerate + rebuild`,
    );
  }
  // JSON path sanity: `{}` → default frame for the FIRST event; verify the
  // frame invariant `out[0]` = WIRE_VERSION, `out[1..5]` = event id AND
  // `bytes_written === WIRE_HEADER_LEN + 4 + size_prefix`.
  const firstEvent = Object.keys(eventNameToId)[0] as EventName;
  const firstId = eventNameToId[firstEvent];
  const scratch = new Uint8Array(2048);
  const jw = bindings.fb_serialize(firstId, "{}", scratch);
  if (jw === 0 || jw > scratch.byteLength) {
    throw new Error(`ignex: FFI self-test failed (fb_serialize JSON) — addon at ${path}`);
  }
  {
    const dv = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
    const size = dv.getUint32(scratch.byteOffset + WIRE_HEADER_LEN, true);
    const gotId = dv.getUint32(scratch.byteOffset + 1, true);
    if (scratch[0] !== WIRE_VERSION || gotId !== firstId || jw !== WIRE_HEADER_LEN + 4 + size) {
      throw new Error(`ignex: FFI self-test failed (fb_serialize frame invariant) — addon at ${path}`);
    }
  }
  // Direct fast-path: probe every generated symbol; disable the failures so
  // their events gracefully fall back to the JSON path.
  const disabledDirect = new Set(directSelfTest(raw, new Uint8Array(2048)));

  return { bindings, raw, disabledDirect, bufferAbiMode };
}

function ensure(): Dl {
  if (cachedDl === undefined) cachedDl = bind();
  return cachedDl as Dl;
}

/** Lazily bind once. Throws if the addon is missing or the self-test fails. */
export function getFfi(): BunFfi {
  return ensure().bindings;
}

/** Output-buffer ABI mode of the live binding (lazy — triggers bind). */
export function getBufferAbiMode(): BufferAbiMode {
  return ensure().bufferAbiMode;
}

/**
 * Direct fast-path symbol. Call it with `(…fieldArgs, outView, outView)` →
 * bytes written (0 = error, >cap = needed). Returns undefined if the symbol is
 * disabled by the bind-time self-test (its event falls back to the JSON path).
 */
export function getDirectSymbol(name: string): ((...args: unknown[]) => number) | undefined {
  const dl = ensure();
  if (dl.disabledDirect.has(name)) return undefined;
  const symbol = dl.raw[name];
  if (!symbol) throw new Error(`ignex: unknown direct symbol "${name}"`);
  return symbol;
}
