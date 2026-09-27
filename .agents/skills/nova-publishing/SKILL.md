---
name: nova-publishing
description: How the @ignex/nova npm package is built, staged, verified, and released — source-published with prebuilt native addons for every declared target. Use when packaging, publishing, or debugging a consumer install.
---

# nova: Publishing

`@ignex/nova` is published **from source**: the tarball ships TypeScript
entrypoints (Bun runs `.ts` natively), generated artifacts, the `rust/` source,
the pinned `rust-toolchain.toml`, and prebuilt native addons in
`prebuilds/<tag>/` for **every** target declared in `package.json#nova.targets`.
`docs/publishing.md` is the full reference; this skill is the runbook.

## Package shape (package.json)

- name `@ignex/nova` (SCOPED — the docs' import/install name is
  `@ignex/nova`, not `ignex-nova`). `publishConfig.access: public` is what
  makes the scoped package publicly visible (scoped packages are restricted
  by default).
- `exports`: 8 subpaths + `./package.json` — `.` → `index.ts`, `/server`,
  `/client`, `/nats`, `/events`, `/bindings`, `/generate`, `/internal`.
- `files`: `index.ts`, `public`, `src`, `rust`, `rust-toolchain.toml`,
  `prebuilds`, `docs`, `README.md`, `CHANGELOG.md`, `LICENSE`. `rust/.npmignore`
  keeps `target/`, `Cargo.lock` and `examples/` out while shipping the Rust
  source for on-platform rebuilds.
- `nova.targets`: the 7 Rust triples — the multi-platform contract shared by
  the build script, the loader, `prepublish:verify` and `check:version`.
- `engines`: `{ "bun": ">=1.4" }` — Bun-only server; the browser client is
  platform-free.

## Target matrix & staging

The mapping (triple → `prebuilds/<tag>/<lib>`) lives in `src/native/targets.ts`;
the declaration lives in `package.json#nova.targets`. Add a target in both.

```
x86_64-unknown-linux-gnu   → linux-x64-gnu     libignex_ffi.so
aarch64-unknown-linux-gnu  → linux-arm64-gnu   libignex_ffi.so
x86_64-unknown-linux-musl  → linux-x64-musl    libignex_ffi.so
aarch64-unknown-linux-musl → linux-arm64-musl  libignex_ffi.so
x86_64-apple-darwin        → darwin-x64        libignex_ffi.dylib
aarch64-apple-darwin       → darwin-arm64      libignex_ffi.dylib
x86_64-pc-windows-msvc     → win32-x64-msvc    ignex_ffi.dll
```

- `bun run prebuild` (wired as `prepack`) → `scripts/build-prebuild.ts`, stages
  the HOST target; `--target <triple>` / `--zigbuild` / `--lib-dir <dir>` cover
  CI cross builds. `bun pm pack` and `bun publish` both stage via `prepack`.
- Loader order (`src/native/loader.ts`): `IGNEX_FFI_PATH` (exclusive) →
  `rust/target[/<triple>]/release` → `prebuilds/<tag>` for every loadable tag
  (glibc/musl preference, then the legacy `<platform>-<arch>` tag).
  `bindFfi` falls through candidates when one fails to load or fails a self-test.

## Release pipeline (`.release.json` + `scripts/release.ts`)

```
bun run release [patch|minor|major|--version X.Y.Z]
  1. verify      (typecheck + lint + check:version + test)
  2. pack:check  (tarball contents gate — scripts/check-pack.ts REQUIRED/FORBIDDEN lists)
  3. publish     — SKIPPED: publish.strategy is "ci" (the v* tag triggers CI)
  4. commit + tag vX.Y.Z  (push ONLY with --push)
```

- Version files synced by the bump: `package.json`, the `[package] version` in
  `rust/Cargo.toml`, and `CHANGELOG.md` (`## [Unreleased]` → dated
  `## [<version>]`). `bun run check:version` asserts package.json ↔ Cargo.toml ↔
  CHANGELOG plus the target contract, and runs inside `bun run verify`.
- Flags: `--dry-run`, `--no-verify`, `--no-pack`, `--no-publish`, `--no-bump`,
  `--no-commit`, `--no-tag`, `--push`, `--yes`, `--tag <dist-tag>`, `--access`,
  `--otp`. Prereleases finalize on the next bump (`0.2.0-beta.1` → `0.2.0`).
- `bun run release:manual` = `--publish` → runs the configured publish command
  (`IGNEX_PUBLISH_ALLOW_PARTIAL=1 bun publish …`) for a single-platform local
  publish. Never publish from a `bun link`-ed tree (see `docs/ai/LOCAL_DEV.md`).

## Gates

- `bun run verify` (typecheck + lint + check:version + test) and
  `bun run pack:check` MUST pass before publish; `prepublishOnly` re-runs
  `generate` + `verify` + `prepublish:verify` as the publish-time gate.
  `bun run test` bundles the browser demo first (`pretest`) — the demo e2e test
  serves `client-dist/main.js`, which is gitignored.
- `bun run prepublish:verify` (`scripts/prepublish.ts`) stages `artifacts/` into
  `prebuilds/` and **fails unless every `nova.targets` target has a non-empty
  artifact** (empty files count as missing). `IGNEX_PUBLISH_ALLOW_PARTIAL=1`
  downgrades it to a warning.
- `bun run verify:install` packs the tarball, installs it into a temp consumer
  and imports it from `node_modules` (exports map + prebuild + FFI self-tests).
- Rust-side gates: `bun run rust:fmt`, `bun run rust:clippy` (`-D warnings`,
  hand-written surface only), `bun run test:rust`.

## CI (`.github/workflows/`)

- `ci.yml`: `rust` (fmt/clippy/test), `typescript` (ubuntu + macOS × Bun
  matrix → pinned flatc → generate → build cdylib → bundle demo → verify →
  bench → pack:check), `install` (`verify:install`).
- `publish.yml`: **generate** (pinned flatc, uploads the wire stack) →
  **build** matrix = one job per target (native runners for darwin/windows;
  `gcc-aarch64-linux-gnu` for aarch64-gnu; `cargo zigbuild` for musl), each
  downloading the generated code and uploading `prebuild-<tag>` → **publish**
  downloads them into `artifacts/`, asserts the tag matches the released
  version, runs `generate` + `verify` + `prepublish:verify`, then
  `npm publish --provenance` with npm OIDC trusted publishing (token fallback
  `secrets.NPM_TOKEN`, environment `NPM_TOKEN`) and attests build provenance.
  `needs:` cannot cross workflows, so the publish job re-runs the gate itself.
- **Toolchain pins are part of the contract**: `rust-toolchain.toml` (Rust) and
  `package.json#nova.flatc` (flatc via `bash scripts/install-flatc.sh`). CI
  never uses the distro `flatc` — an older one generates Rust that does not
  compile against the `flatbuffers` 25.x crate (that failure mode broke CI).

