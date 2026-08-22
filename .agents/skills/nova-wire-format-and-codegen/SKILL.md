---
name: nova-wire-format-and-codegen
description: How @ignex/nova's wire stack is generated and how the frame envelope works — for contributors touching src/schema/, src/codegen/, scripts/generate.ts, or independent clients.
---

# nova: Wire format & codegen

The wire stack is **generated, never hand-written**: TypeBox schemas in
`src/schema/index.ts` are the single source of truth; `bun run generate`
emits the FlatBuffers schema, the TS + Rust decoders/encoders, the registry,
and the wire-registry.json. `docs/wire-format.md` pins the on-the-wire
contract for independent clients.

## The pipeline

```
src/schema/index.ts (TypeBox — source of truth: app events + control events)
  │  scripts/generate.ts
  ▼
fbs/backend.fbs ──flatc --ts──▶ src/generated/ts/          (decoders, both sides)
        └──flatc --rust──▶ rust/src/generated/backend.rs   (table builders)
src/codegen/rust-glue-gen.ts ─▶ rust/src/transcode/generated.rs (JSON glue + direct-arg FFI)
src/codegen/direct-gen.ts ────▶ src/generated/direct-ser.ts (zero-alloc server encoder)
src/codegen/ts-ser-gen.ts ────▶ src/generated/ts-ser.ts     (pure-JS browser encoder)
src/codegen/registry-gen.ts ───▶ src/generated/registry.ts  (event routing, both sides)
scripts/generate.ts ──────────▶ src/generated/wire-registry.json (name→id map for external consumers)
```

Key files: `src/codegen/constants.ts` (WIRE_VERSION = 1, WIRE_HEADER_LEN = 5),
`schema-model.ts` (`Type.BigInt` / `Type.Integer({bigint:true})` → exact int64),
`typebox-to-fbs.ts`, `fingerprint.ts` (schema fingerprint), `hash.ts` (FNV-1a 32).

## The frame envelope (non-negotiable)

```
[WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]
```

- `event_id` = FNV-1a 32 of the event name — stable across reordering;
  collisions are rejected at generate time. `src/generated/registry.ts` holds
  the id→name table; `wire-registry.json` exposes it to external consumers.
- Control frames (hello/welcome/subscribe/unsubscribe/joinGroup/leaveGroup/
  snapshotRequest/ping/pong) share the same envelope and are routed internally
  via `isControlId` before app handlers.
- No per-frame checksum/AuthN — integrity is the application's job.

## Discipline

- **NEVER hand-edit `src/generated/` or `rust/src/transcode/generated.rs`** —
  files carry `@generated … DO NOT EDIT`. Re-run `bun run generate` after any
  schema/codegen change and commit the regenerated output.
- Keep the codegen emitters and the generated output in sync: a change to a
  `src/codegen/*-gen.ts` emitter must be followed by `bun run generate`.
- `bun run generate` requires the `flatc` compiler (FlatBuffers); the Rust
  glue needs `cargo build --release --manifest-path rust/Cargo.toml` before
  FFI-backed paths work.

## Generic bindings (ANY schema)

`generateBindings(schema, opts)` (`public/generate.ts`) runs the same emitters
for a consumer's own schema into the app's `ignex/generated/`, producing
`backend.fbs`, `ts/*.ts`, `registry.ts`, `ts-ser.ts`, `direct-ser.ts`,
`wire-registry.json`, a rust crate scaffold, and `index.ts`
(`makeBindings(schema)` → `assembleBindings`). `scripts/generate-bindings.ts`
is a script YOUR APP writes — it is not shipped in this package.

## Verify

- `bun run generate` then `bun test` (wire, registry, roundtrip,
  bindings-gen, direct suites).
- `bun run verify` (typecheck + lint + test) before pushing.
