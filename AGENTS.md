# AGENTS.md — @ignex/nova

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs: `README.md` (usage), `docs/architecture.md`
(code map + functional composition), `docs/wire-format.md` (on-the-wire
contract), `docs/events.md`, `docs/generic-bindings.md`, `docs/publishing.md`.
Agent skills: `.agents/skills/*/SKILL.md`. Cross-repo local development:
`docs/ai/LOCAL_DEV.md`.

**AI scaffolding index** (this repo):
- `RULES.md` — the non-negotiable coding rules (bun-only, rust-core-first,
  cstring/zero-text-encoding FFI, generated-code discipline, functional
  composition, docs discipline).
- `.agents/skills/nova-wire-format-and-codegen/SKILL.md` — schema/codegen/wire.
- `.agents/skills/nova-rust-ffi-cstring/SKILL.md` — the Bun↔Rust FFI surface.
- `.agents/skills/nova-websocket-pubsub-core/SKILL.md` — server/client core.
- `.agents/skills/nova-publishing/SKILL.md` — packaging & releases.
- `docs/ai/TREE.md` — auto-generated scaffold (`bun run gen:ai-map`).

## What this project is

`@ignex/nova` — a TypeBox-driven **FlatBuffer transport over Bun WebSockets**
with a Rust FFI serializer (own cdylib `ignex_ffi`, raw `extern "C"` + Bun
`dlopen` — not napi) hidden behind a typed pub/sub API. Wire stack is
generated from TypeBox schemas (`src/schema/index.ts` → `bun run generate` →
`src/generated/` + `rust/src/generated/` + `rust/src/transcode/`). Server is
Bun-only (`engines.bun >= 1.4`); the browser client is plain TS. Optional
NATS bridge (`src/bridge/`) and events layer (`src/events/`).

## Commands

| Task | Command |
|------|---------|
| Install pinned `flatc` | `bash scripts/install-flatc.sh` (version = `package.json#nova.flatc` → `~/.local/bin`) |
| Generate wire artifacts | `bun run generate` (needs the pinned `flatc`; regenerates `src/generated/` + `rust/src/transcode/`) |
| Build Rust cdylib (release) | `bun run build:rust` (`cargo build --release --manifest-path rust/Cargo.toml`) |
| Stage addon into `prebuilds/` | `bun run prebuild` (host target; `--target <triple>` for cross builds) |
| Full build | `bun run build` (generate + build:rust + build:client) |
| Tests | `bun run test` (`pretest` bundles the browser demo; NATS integration opt-in via `NATS_URL`) |
| Rust fmt / clippy / test | `bun run rust:fmt` / `rust:clippy` (-D warnings) / `test:rust` |
| Lint (oxlint, FP rules) | `bun run lint` |
| Typecheck | `bun run typecheck` (`tsc --noEmit -p tsconfig.json`) |
| Verify all | `bun run verify` (typecheck + lint + check:version + test) |
| Version/target consistency | `bun run check:version` (`package.json` ↔ `rust/Cargo.toml` ↔ `CHANGELOG.md` ↔ `nova.targets`) |
| Tarball gate | `bun run pack:check` |
| Multi-platform publish gate | `bun run prepublish:verify` (all `nova.targets` staged? `IGNEX_PUBLISH_ALLOW_PARTIAL=1` to warn) |
| Installed-tarball e2e | `bun run verify:install` (packs, installs into a temp consumer, imports from `node_modules`) |
| Bench (perf gate) | `bun run bench:serialize` / `bench:throughput` — gate: `bench/BASELINE.md` |
| Demo server | `bun run serve` |
| Release | `bun run release[:dry] [patch\|minor\|major\|--version X.Y.Z]` (CI-published: push the tag with `--push`; `release:manual` for a local partial publish) |
| Regenerate AI scaffold | `bun run gen:ai-map` |

Hooks: lefthook pre-commit (oxlint + typecheck on staged) and pre-push
(lint + typecheck + test).

## Where things live (short map — full detail in docs/architecture.md)

```
src/
  schema/index.ts      TypeBox source of truth (app events + control events)
  codegen/             emitters: schema-model, typebox-to-fbs, fingerprint, hash,
                       registry-gen, ts-ser-gen, direct-gen, rust-glue-gen, constants
  generated/           REGENERATED — flatc TS, registry, direct-ser, ts-ser, wire-registry.json (do not hand-edit)
  bindings/            Bindings contract + assemble + default (built-in registry)
  native/              the only Rust-touching code: ffi.ts (dlopen map + self-tests,
                       multi-candidate bind fallback), targets.ts (the native target
                       matrix: triple ↔ prebuilds/<tag>/<lib>), loader.ts (IGNEX_FFI_PATH
                       → rust/target/release → prebuilds/<tag>), codec.ts
  core/                composition roots server/ + client.ts; action modules
                       (state, auth, rooms, ring, replay, groups, backpressure, outbound,
                       routing, metrics, int64-guard, client-state/-wire/-reconnect/-heartbeat/-rpc)
  transport/           encodeToScratch (direct/JSON/JS), scratch, stats, byte-buffer-pool
  bridge/              optional NATS (nats/ = types, real-transport, inbound; subjects.ts)
  events/              opt-in events layer (hub/, registry, clients, cluster/,
                       queue, global, types/, delivery, schedule)
  server.ts            runnable demo (serve /ws, /health, static demo)
rust/
  src/ffi.rs           hand-written C-ABI: fb_probe (0x49474e58 "IGNX"), fb_wire_version,
                       fb_schema_fingerprint, fb_serialize, ffi_probe_* diagnostics
  src/generated/       flatc --rust output (regenerated; carries lint allows in mod.rs)
  src/transcode/generated.rs  generated direct fb_*_serialize exports + thread_local FBB (regenerated)
rust-toolchain.toml    pinned Rust channel (reproducible CI + consumer rebuilds)
.cargo/config.toml     build policy: baseline-CPU artifacts only (no machine-local tuning)
public/                npm entrypoint shims (server, client, nats, events, bindings, generate, internal)
client/                browser demo (index.html, main.ts) → built to client-dist/
test/                  25 bun:test files + helpers.ts
bench/                 serialize, throughput, measure, ffi-margin + BASELINE.md (perf gate)
scripts/               generate.ts, build-prebuild.ts (stage one target), prepublish.ts
                       (multi-platform completeness gate), postinstall.ts (source-build
                       fallback), check-pack.ts, check-version.ts, verify-install.ts,
                       release.ts, gen-ai-map.ts
examples/              consumer, events, generic-schema, nats-consumer
```

## Rules (full text in RULES.md)

1. **Bun-only, Rust-core-first** — server = `Bun.serve` + `bun:ffi`; perf
   comes from the Rust cdylib; `bench/BASELINE.md` is the perf gate.
2. **cstring / zero-text-encoding FFI** — JS strings cross as `cstring`
   args (Bun transcodes; `CStr::from_ptr` on the Rust side); bytes as
   `(ptr, len)`/`buffer`+`buffer_length`; `panic_guard`, null-checks,
   needed-size convention, `thread_local` scratch. No JS-side
   `TextEncoder`/`TextDecoder` on the FFI path.
3. **Never hand-edit generated code** — change `src/schema/` or
   `src/codegen/`, run `bun run generate`, commit the regenerated output.
4. **Functional composition** — no classes/`this` on public surfaces;
   factories over explicit state; small pure functions in small files.
5. **Docs discipline** — docs must match code; keep the package name
   `@ignex/nova` in all install/import docs; regenerate `docs/ai/TREE.md`
   after structural changes.

## Do NOT

- Hand-edit `src/generated/` or `rust/src/transcode/generated.rs`.
- Add a Node compatibility layer (the package is Bun-only).
- Introduce a class-based public API.
- Change the frame envelope (`[WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]`)
  without a `WIRE_VERSION` bump + regenerate + wire-format doc update.
- Write `ignex-nova` where the npm package is meant — it is `@ignex/nova`
  (`ignex-nova` is only the repo/Rust-crate name).
