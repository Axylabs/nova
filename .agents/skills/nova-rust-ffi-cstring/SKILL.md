---
name: nova-rust-ffi-cstring
description: The Bun↔Rust FFI conventions of the ignex_ffi cdylib — cstring zero-text-encoding, panic containment, needed-size, and the bind-time self-tests. Use when adding a direct-FFI event or touching src/native/ffi.ts / rust/src/.
---

# nova: Rust FFI conventions (cstring zero-text-encoding)

nova's Rust cdylib (`libignex_ffi`, crate `ignex-nova-ffi`) is **not** napi —
it is a raw `extern "C"` surface loaded by Bun `dlopen` (`src/native/ffi.ts`).
The conventions mirror castrum's FFI guide (cited in `rust/src/ffi.rs`).

## The dlopen map (`src/native/ffi.ts`)

```ts
fb_serialize:          { args: abi(["u32", "cstring", "ptr", "usize"]), returns: U64_FAST }
fb_probe:              { args: [], returns: "u32" }
fb_wire_version:       { args: [], returns: "u32" }
fb_schema_fingerprint: { args: [], returns: U64_FAST }
// per-event direct symbols (fb_<event>_serialize) from req.direct.symbols, same abi() transform
```

- `abi()` upgrades `ptr` args to `buffer`/`buffer_length` at bind time when the
  Bun build accepts them (probe via diagnostic `ffi_probe_echo_view`; forced
  off by `IGNEX_FFI_FORCE_PTR_LEN=1`). Call sites pass the output view twice
  (`(…, out, out)`) — the engine reads ptr+byteLength off the same view.
- `returns: "u64_fast"` → plain-number byte counts (no BigInt boxing).
- Bind-time self-test chain: `fb_probe` magic `0x49474e58` ("IGNX") →
  `fb_wire_version` match → `fb_schema_fingerprint` match → `fb_serialize("{}")`
  frame invariant → per-symbol `directSelfTest`; failing symbols are
  DISABLED (`disabledDirect`) and fall back to the JSON path. `ffiMode:
  "required"` throws on failure; `"optional"` returns null (pure-JS encoder).

## Rust-side conventions (`rust/src/ffi.rs`, `rust/src/transcode/generated.rs`)

- **panic_guard**: every call is wrapped in
  `std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| …))` → `unwrap_or(0)`.
  A panic unwinding through `extern "C"` kills the Bun process.
- **null-checks**: every pointer is null-checked before use (`json.is_null() ||
  (out.is_null() && out_cap != 0) → return 0`).
- **cstring ARG → `CStr::from_ptr`**: Bun's engine transcodes the JS string to
  a call-scoped NUL-terminated UTF-8 buffer — **zero JS-side text encoding**.
  Never dereference past the NUL. (Embedded-NUL inputs are pre-scanned
  (`hasNul`) and routed to the JSON path so they round-trip exactly.)
- **Byte blobs → `(ptr, len)`**: `slice::from_raw_parts` — zero-copy, no
  NUL-termination requirement (e.g. `fb_portfolio_serialize`'s packed
  positions blob).
- **Needed-size convention**: `0` = error; `needed > out_cap` returns the
  exact size required (JS allocates once and retries — `growExact` style).
- **thread_local scratch only**: `thread_local! { static FBB: RefCell<FlatBufferBuilder<'static>> }`
  with `fbb.reset()` per call; no global `static mut`.
- Frame written by both paths: `[WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]`.

## Adding a direct-FFI event

1. Add the event schema in `src/schema/index.ts` (directable shape).
2. `bun run generate` → regenerates `rust/src/transcode/generated.rs`
   (`fb_<event>_serialize`) + `src/generated/direct-ser.ts`.
3. `bun run build:rust` (`cargo build --release --manifest-path rust/Cargo.toml`).
4. `bun test` — direct + ffi + roundtrip + integrity suites.

## Loader / addon resolution (`src/native/loader.ts`)

Order: 1) `IGNEX_FFI_PATH` env override → 2) `<repo>/rust/target/release/`
(dev build) → 3) `<pkg>/prebuilds/<platform>-<arch>/` (staged by
`bun run prebuild`). Stale addons fail the bind-time fingerprint/wire checks
loudly instead of emitting undecodable frames.
