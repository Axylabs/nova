---
name: nova-publishing
description: How the @ignex/nova npm package is built, staged, verified, and released — source-published with prebuilt native addons. Use when packaging, publishing, or debugging a consumer install.
---

# nova: Publishing

`@ignex/nova` is published **from source**: the tarball ships TypeScript
entrypoints (Bun runs `.ts` natively), generated artifacts, the `rust/`
source, and prebuilt native addons in `prebuilds/<platform>-<arch>/`.
`docs/publishing.md` is the full reference; this skill is the runbook.

## Package shape (package.json)

- name `@ignex/nova` (SCOPED — the docs' import/install name is
  `@ignex/nova`, not `ignex-nova`). `publishConfig.access: public` is what
  makes the scoped package publicly visible (scoped packages are restricted
  by default).
- `exports`: 8 subpaths + `./package.json` — `.` → `index.ts`, `/server`,
  `/client`, `/nats`, `/events`, `/bindings`, `/generate`, `/internal`.
- `files`: `index.ts`, `public`, `src`, `rust`, `prebuilds`, `docs`,
  `README.md`, `LICENSE`. `rust/.npmignore` keeps `target/`, `Cargo.lock`,
  and `examples/` out while shipping the Rust source for on-platform rebuilds.
- `engines`: `{ "bun": ">=1.4" }` — Bun-only server; the browser client is
  platform-free.

## Release pipeline (`scripts/release.ts`)

```
bun run release [patch|minor|major|--version X.Y.Z]
  1. verify   (typecheck + lint + test)
  2. pack:check  (tarball contents gate — scripts/check-pack.ts REQUIRED/FORBIDDEN lists)
  3. publish  → prepublishOnly (generate + verify) → prepack (prebuild stages addon)
  4. commit + tag vX.Y.Z  (push ONLY with --push)
```

Flags: `--dry-run`, `--no-verify`, `--no-check`, `--no-publish`, `--no-bump`,
`--no-commit`, `--no-tag`, `--push`, `--yes`, `--tag <dist-tag>`,
`--access`, `--otp`. Prereleases finalize on the next bump (`0.2.0-beta.1` → `0.2.0`).

## Prebuilds & the loader

- `bun run prebuild` (`scripts/build-prebuild.ts`) runs
  `cargo build --release --manifest-path rust/Cargo.toml` and copies the
  cdylib into `prebuilds/<platform>-<arch>/` — wired as `prepack`, so both
  `bun pm pack` and `bun publish` stage the addon for the CURRENT platform.
- CI `.github/workflows/publish.yml` runs the prebuild on a platform matrix
  (ubuntu-latest, macos-latest, macos-13) and merges the prebuilds into one
  publish (`NPM_TOKEN` secret; `bun publish --tag --access public`).
- Consumers without a matching prebuild: `IGNEX_FFI_PATH=/abs/path/libignex_ffi.so`
  or rebuild from the shipped `rust/` source. The loader order is
  `IGNEX_FFI_PATH` → `rust/target/release` → `prebuilds/<platform>-<arch>`.

## Gates

- `bun run verify` (typecheck + lint + test) and `bun run pack:check` MUST
  pass before publish; `prepublishOnly` re-runs generate + verify as a
  safety net.
- Never publish from a `bun link`-ed tree — releases resolve from the
  registry only (see `docs/ai/LOCAL_DEV.md`).
