# Publishing @ignex/nova to npm

`@ignex/nova` is published **from source**: the tarball contains TypeScript
entrypoints (Bun runs `.ts` natively, so consumers need no build step), the
generated artifacts, the `rust/` source, the pinned `rust-toolchain.toml`, and
**prebuilt native addons for every target in the release matrix** — one tarball,
all platforms, like the sibling `castrum` package.

## Package layout (`package.json`)

| Field | Value | Why |
| --- | --- | --- |
| `main` / `module` / `types` | `./index.ts` | source entrypoint (Bun-native) |
| `exports` | `@ignex/nova` → `index.ts`; `@ignex/nova/server` → `public/server.ts`; `@ignex/nova/client` → `public/client.ts`; `@ignex/nova/nats` → `public/nats.ts`; `@ignex/nova/events` → `public/events.ts`; `@ignex/nova/bindings` → `public/bindings.ts`; `@ignex/nova/generate` → `public/generate.ts`; `@ignex/nova/internal` → `public/internal.ts`; `@ignex/nova/package.json` → `package.json` | typed subpath API |
| `files` | `index.ts`, `public`, `src`, `rust`, `rust-toolchain.toml`, `prebuilds`, `scripts/postinstall.ts`, `docs`, `README.md`, `CHANGELOG.md`, `LICENSE` | everything consumers need, nothing they don't (`scripts/postinstall.ts` must ship because `postinstall` runs on consumer installs) |
| `nova.targets` | the 7 Rust triples below | **the multi-platform contract** — build matrix, loader, pre-publish gate and `check:version` all derive from it |
| `publishConfig` | `{ "access": "public" }` | scoped packages are restricted by default — `access: public` publishes `@ignex/nova` publicly |
| `engines` | `{ "bun": ">=1.4" }` | Bun-only runtime |
| `sideEffects` | `false` | safe to tree-shake / mark in bundlers |

`rust/.npmignore` keeps `rust/target/` (build output), `Cargo.lock` and the dev
example out of the tarball while still shipping the Rust **source** so consumers
can rebuild the addon on any platform.

## The native target matrix

`package.json#nova.targets` declares the triples; `src/native/targets.ts` maps
each triple to its staged artifact (`prebuilds/<tag>/<lib>`) and to the tags a
host probes at runtime. Both must agree — `bun run check:version` fails on drift
in either direction.

| Triple | Tag | Artifact |
| --- | --- | --- |
| `x86_64-unknown-linux-gnu` | `linux-x64-gnu` | `libignex_ffi.so` |
| `aarch64-unknown-linux-gnu` | `linux-arm64-gnu` | `libignex_ffi.so` |
| `x86_64-unknown-linux-musl` | `linux-x64-musl` | `libignex_ffi.so` |
| `aarch64-unknown-linux-musl` | `linux-arm64-musl` | `libignex_ffi.so` |
| `x86_64-apple-darwin` | `darwin-x64` | `libignex_ffi.dylib` |
| `aarch64-apple-darwin` | `darwin-arm64` | `libignex_ffi.dylib` |
| `x86_64-pc-windows-msvc` | `win32-x64-msvc` | `ignex_ffi.dll` |

All artifacts are **baseline-CPU** builds (no `-C target-cpu`): a published
addon runs on any host of its triple. `.cargo/config.toml` documents that policy
and how to opt into machine-local SIMD for benchmarking only.

### Building + staging one target

```bash
bun run prebuild                                   # host target (used by `prepack`)
bun scripts/build-prebuild.ts --target <triple>    # one target (CI)
bun scripts/build-prebuild.ts --target <triple> --zigbuild   # musl cross build
bun scripts/build-prebuild.ts --lib-dir <dir>      # stage an already-built cdylib
```

The script stages `prebuilds/<tag>/<lib>` from
`rust/target/[<triple>/]release/` and fails loudly when the cdylib is missing.

### Loader resolution (runtime)

`src/native/loader.ts` (matrix logic in `src/native/targets.ts`):

1. `IGNEX_FFI_PATH` env override — honored **exclusively** (a typo fails loudly,
   it never silently loads another addon)
2. in-repo dev builds: `<pkg>/rust/target[/<triple>]/release/<lib>`
3. packaged layout: `<pkg>/prebuilds/<tag>/<lib>` for every loadable tag, best
   match first — `linux-x64-gnu` → `linux-x64-musl` → legacy `linux-x64` on
   glibc; musl-first on musl; `win32-x64-msvc` → `win32-x64`

`bindFfi` walks **all** existing candidates: a candidate that fails `dlopen` or
a bind-time self-test (stale artifact, schema/wire drift) falls through to the
next one, so a partial stage degrades to the still-correct addon instead of
disabling the native path.

### Source-build fallback (`postinstall`)

`scripts/postinstall.ts` keeps the package usable without a matching prebuild
(unsupported host, partial local publish, `npm install --build-from-source`).
It is a fast no-op when an artifact for the host exists, and otherwise:

| Condition | Behaviour |
| --- | --- |
| artifact for this host exists | skip (`prebuilt`) |
| repo checkout (`.git` present) | skip — contributors run `bun run build:rust` |
| `IGNEX_SKIP_BUILD` set / `CI` set | skip (`env` / `ci`) |
| no `cargo`/`rustc` on PATH | warn + skip (`no-toolchain`) |
| otherwise | `cargo build --release` → stage into **every** host tag dir |

`IGNEX_REQUIRE_BUILD=1` turns every "warn + skip" into a hard install failure.
`npm_config_build_from_source=true` forces a rebuild even when a prebuilt exists.

> Bun does not run dependency lifecycle scripts by default — a Bun consumer that
> wants the fallback adds `@ignex/nova` to `trustedDependencies`. npm consumers
> run it normally. `IGNEX_FFI_PATH` always remains an escape hatch.

## The release pipeline

```
bun run release                 ──►  bump version (package.json + rust/Cargo.toml)
                                       │
                                       ├─► verify      (typecheck + lint + check:version + test)
                                       ├─► pack:check  (tarball contents gate)
                                       ├─► publish     — SKIPPED: strategy is `ci`
                                       └─► git commit + tag vX.Y.Z  (+ push with --push)
                                              │
                                    push v* tag ──► CI publish workflow
                                              │
                        build 1 addon per target ──► artifacts/*.tgz inputs
                                              │
                          prepublish:verify (ALL targets present?) ──► npm publish
```

`.release.json` drives the shared `scripts/release.ts` (identical across the
ignex product repos):

```json
{
  "product": "nova",
  "type": "single",
  "verify": ["bun run verify"],
  "checks": ["bun run pack:check"],
  "versionFiles": [ "rust/Cargo.toml (regex)", "CHANGELOG.md (Unreleased → [x.y.z])" ],
  "publish": { "strategy": "ci", "manager": "bun", "command": "…ALLOW_PARTIAL local fallback…" }
}
```

- **`strategy: "ci"`** — a local `bun run release` never publishes; pushing the
  `v*` tag does. `bun run release:manual` (`--publish`) is the escape hatch for a
  single-platform local publish: it runs the configured command, which sets
  `IGNEX_PUBLISH_ALLOW_PARTIAL=1` so the completeness gate warns instead of
  failing.
- **Version sync** — the bump rewrites `package.json`, the `[package] version`
  in `rust/Cargo.toml`, and finalizes `## [Unreleased]` in `CHANGELOG.md` into a
  dated `## [<version>]` section. `bun run check:version` asserts all three
  agree (plus the target contract) and runs inside `bun run verify`.
- **Flags** — `--dry-run`, `--no-verify`, `--no-pack`, `--no-commit`, `--no-tag`,
  `--no-bump`, `--no-publish`, `--publish`, `--push`, `--yes`, `--tag <dist-tag>`,
  `--access`, `--otp`, `--allow-dirty`, `--no-preflight`.

## CI (`.github/workflows/`)

`ci.yml` — the standards flow:

| Job | What it gates |
| --- | --- |
| `rust` | `rust:fmt` (hand-written surface), `rust:clippy -- -D warnings`, `cargo test` |
| `typescript` | ubuntu + macOS × Bun `1.4.2`/`latest`: pinned `flatc` → generate → build cdylib → bundle the demo → `bun run verify` → `bench:serialize` (perf gate) → `pack:check` |
| `install` | packs the tarball, installs it into a throwaway consumer and imports it from `node_modules` (`bun run verify:install`) — proves the shipped layout resolves the exports map, the staged prebuild and the FFI self-tests |

Every job installs the **pinned `flatc`** (`bash scripts/install-flatc.sh`,
version from `package.json#nova.flatc`) — the distro packages are older and
generate Rust that does not compile against the `flatbuffers` 25.x crate. The
demo-server e2e test serves `client-dist/main.js`, so the browser bundle is
built before the suite runs (`pretest` does it for `bun run test`).

`publish.yml` — the multi-platform release, triggered by a `v*` tag or
`workflow_dispatch` (optional `dist_tag` input + a `version` guard):

1. **generate**: installs the pinned `flatc`, regenerates the wire stack once and
   uploads it (`rust/src/generated/` + `src/generated/`) — `flatc`'s Rust tables
   are gitignored, so no target can compile from a bare checkout, and sharing
   one output guarantees every platform compiles identical generated code.
2. **build** (matrix = `nova.targets`, `needs: [generate]`): native runners for
   darwin/windows and `x86_64-unknown-linux-gnu`; `gcc-aarch64-linux-gnu` cross
   toolchain for `aarch64-unknown-linux-gnu`; `cargo zigbuild` for both musl
   targets. Each job downloads the generated wire stack, then uploads
   `prebuild-<tag>` containing `prebuilds/`.
2. **publish**: downloads all artifacts into `./artifacts` (`merge-multiple`),
   asserts the tag (or an explicit `version` input) matches the released
   `package.json` version, generates an SBOM, regenerates the flatc output (with
   the pinned compiler), runs `bun run verify` and then `bun run prepublish:verify`
   (**hard-fails unless every declared target is staged**), publishes with npm
   **OIDC trusted publishing** (`--provenance`, token fallback via
   `secrets.NPM_TOKEN`, job environment `NPM_TOKEN`), and attests build
   provenance for the artifacts.

The version always comes from the **release commit** — `bun run release` bumps
`package.json` + `rust/Cargo.toml` + `CHANGELOG.md` together and tags that
commit, so the workflow only has to verify (never rewrite) it. Pushing a tag
whose version does not match `package.json` fails the job with instructions.

`needs:` cannot cross workflows, so the publish job re-runs the full `verify`
gate itself — a tag can never ship past a red gate.

### Pre-publish gate (`bun run prepublish:verify`)

`scripts/prepublish.ts`:

- merges every `prebuilds/` directory found under `artifacts/` into the package
  (handles both `artifacts/prebuilds/...` and
  `artifacts/prebuild-<tag>/prebuilds/...`)
- prints a ✔/✖ row per declared target
- fails with staging instructions unless every target has a **non-empty**
  artifact (an empty file — a truncated upload — counts as missing)
- `IGNEX_PUBLISH_ALLOW_PARTIAL=1` downgrades that to a loud warning

It runs from `prepublishOnly` **and** explicitly in the CI publish job, so both
`bun publish` and `npm publish` are covered.

## Pre-publish checklist

- [ ] `flatc --version` matches `package.json#nova.flatc` (`bash scripts/install-flatc.sh`)
- [ ] `bun run verify` passes locally (typecheck + lint + check:version + test)
- [ ] `bun run rust:fmt && bun run rust:clippy && bun run test:rust` pass
- [ ] `bun run pack:check` shows the expected files and no `rust/target/`
- [ ] `bun run verify:install` passes (installed-tarball import + FFI self-test)
- [ ] `CHANGELOG.md` has an `[Unreleased]` section describing the release
- [ ] `bun run release:dry` shows the expected bump, tag and steps
- [ ] for a tag release: the CI build job is green for all 7 targets
- [ ] `NPM_TOKEN` is configured (or the npm trusted publisher is set up) for the
      repo environment the publish job targets

## Tarball hygiene notes

- `files` is an allowlist — only the listed top-level entries are packed.
- Nested `rust/.npmignore` excludes `rust/target/` (platform-specific build
  output, GB-scale) and `Cargo.lock` (library crates don't commit it).
- `prebuilds/` is gitignored; `prepack`/CI stage addons into it before packing.
  A source-only tarball is still valid (loader → source rebuild/`IGNEX_FFI_PATH`,
  and the `postinstall` fallback builds when a toolchain is present).
- `artifacts/` (CI downloads) is gitignored and forbidden in the tarball by
  `pack:check`.
- The gitignored `src/generated/` artifacts ARE packed (they're under the
  included `src/`) — that's intentional: consumers must not need `flatc`.

