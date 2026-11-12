# Changelog

All notable changes to `@ignex/nova` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`bun run release <patch|minor|major>` finalizes the `Unreleased` section into a
dated `## [<version>]` heading (see `scripts/release.ts` + `.release.json`).

## [Unreleased]

## [0.2.1] — 2026-11-12

## [0.2.0] — 2026-11-11

### Added
- Transport-neutral messaging beyond WebSockets: `createServiceClient` /
  `createServiceHandler` for bounded binary service-to-service request/response,
  plus `createSseResponse` / `openNovaSse` / `readNovaSse` for typed Nova events
  over SSE. The same generated contract now works over WS, binary HTTP, SSE,
  NATS, and custom carriers without changing the frame format. New entry points:
  `@ignex/nova/messaging` (portable) and `/messaging/server` (Rust-native).
- Schema-local native addon selection via `makeBindings(schema, { ffiPath })` /
  `assembleBindings(..., { ffiPath })`, so multiple custom schemas can use
  their own Rust encoders in one process without a global environment override.
- Immediate `subscribe()` / `joinGroup()` calls are retained until the socket
  opens, and requested groups now restore after reconnect just like topics.
- Per-connection RPC concurrency bounds (`maxRpcInFlight`, default 64) with
  `metrics.rpcRejected` observability.

### Fixed
- RPC validates that the embedded request/response event matches the responder
  schema instead of allowing cross-schema payload confusion. Base64 conversion
  on the Bun server now uses Buffer rather than byte-at-a-time string building.
- Connection limits include async upgrades in flight; empty tokens and throwing
  token predicates fail closed instead of bypassing authentication.
- A replaced socket's delayed close can no longer unregister its successor or
  overwrite its resume history. Closing an older events hub no longer unbinds
  the active global hub.

### Performance
- Removed per-handler closures from normal and catch-all event dispatch. On the
  local Bun 1.4.4 benchmark, best-case dispatch improved from 44.2 ns to
  21.9 ns and sustained throughput from 23.86M to 35.60M ops/s; Rust direct
  encoding remained zero-allocation and publish throughput stayed stable.
- Added a declared-length HTTP body fast path with actual-size verification and
  generated direct table/vector decoders that remove unpack objects, per-element
  vtable lookups, DataView headers, and plain-number int64 BigInt intermediates.
  Interleaved loopback echo latency fell from 71.5 to 50.5 µs on small payloads
  and from 264.4 to 176.6 µs on 200-item vectors; JSON remains faster on that
  workload, so the measurements are not presented as a universal Nova win.

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
