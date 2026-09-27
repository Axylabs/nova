# Changelog

All notable changes to `@ignex/nova` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`bun run release <patch|minor|major>` finalizes the `Unreleased` section into a
dated `## [<version>]` heading (see `scripts/release.ts` + `.release.json`).

## [Unreleased]

## [0.1.7]

- Baseline for this changelog: TypeBox-driven FlatBuffer transport over Bun
  WebSockets with the Rust `ignex_ffi` cdylib, typed pub/sub API, optional NATS
  bridge, events layer, and multi-platform prebuilt native addons. Earlier
  history predates this file — see the git tags.
