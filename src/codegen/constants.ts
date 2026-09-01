/**
 * Shared wire-format constants. These are the SINGLE source of truth for the
 * transport envelope — every emitter (TS registry, Rust glue, direct serde)
 * imports them so the TS and Rust sides stay in sync by construction.
 *
 * The Rust `fb_wire_version()` export is checked against `WIRE_VERSION` at
 * bind time (`src/native/ffi.ts`) to catch any drift between a stale cdylib
 * and the generated artifacts.
 */

/** Wire format version. Bump on any BREAKING envelope change. */
export const WIRE_VERSION = 2;

/**
 * Envelope header length in bytes:
 *   [version:1][event_id:u32 LE][flags:1][seq:u64 LE]
 * The size-prefixed FlatBuffer payload follows immediately after.
 *
 * `flags` bit0 = seq-valid: the server stamps a per-CONNECTION delivery seq on
 * every frame it writes to a socket (mutated in place just before `ws.send`,
 * which copies). Clients use it for gap detection + resume. Frames that were
 * not per-destination stamped (client-encoded, replay history copies before
 * stamping) carry flags=0 / seq=0.
 */
export const WIRE_HEADER_LEN = 14;

/** flags bit: `seq` field carries a valid per-connection delivery sequence. */
export const WIRE_FLAG_SEQ = 1;
