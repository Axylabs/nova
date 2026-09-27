# Changelog

All notable changes to `@ignex/nova` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`bun run release <patch|minor|major>` finalizes the `Unreleased` section into a
dated `## [<version>]` heading (see `scripts/release.ts` + `.release.json`).

## [Unreleased]

## [0.1.8] — 2026-09-27

### Fixed
- CI: install the **pinned `flatc`** (`package.json#nova.flatc` +
  `scripts/install-flatc.sh`, verified by `scripts/generate.ts`) — the distro
  package generated Rust that failed to compile against `flatbuffers` 25, which
  failed every ubuntu job.
- CI: the demo-server e2e test runs after the browser bundle is built
  (`pretest` / an explicit `build:client` step) instead of 404-ing on
  `client-dist/main.js`.
- Release: `scripts/postinstall.ts` now ships in the tarball — the `postinstall`
  hook runs on consumer installs and the file was missing from `files`.

### Added
- Multi-platform native target matrix (`package.json#nova.targets` +
  `src/native/targets.ts`): 7 targets, libc-aware
  `prebuilds/<platform>-<arch>[-<libc>]/` staging, a multi-candidate loader and
  an FFI bind fallback.
- `prepublish:verify` completeness gate (hard-fails on a missing/empty
  artifact), `check:version`, `verify:install` installed-tarball e2e, and a
  source-build `postinstall` fallback with `IGNEX_SKIP_BUILD` /
  `IGNEX_REQUIRE_BUILD`.
- Rust quality gates (`rust:fmt`, `rust:clippy -D warnings`), a pinned
  `rust-toolchain.toml`, baseline-CPU build policy, and a CI release pipeline
  that publishes all targets with npm provenance + SBOM.

## [0.1.7]

- Baseline for this changelog: TypeBox-driven FlatBuffer transport over Bun
  WebSockets with the Rust `ignex_ffi` cdylib, typed pub/sub API, optional NATS
  bridge, events layer, and multi-platform prebuilt native addons. Earlier
  history predates this file — see the git tags.
