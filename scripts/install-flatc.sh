#!/usr/bin/env bash
# scripts/install-flatc.sh — install the PINNED FlatBuffers compiler (`flatc`).
#
# Why pinned: `flatc` generates the Rust tables AND the TypeScript decoders, so
# its version must match the `flatbuffers` crate/npm range (25.x). The apt
# package on ubuntu runners is far older and emits Rust that does NOT compile
# against the 25.x crate (`Table::get` unsafe-ness, `Verifiable` items, …) —
# which is exactly what broke CI (137 errors in `src/generated/backend.rs`).
# Homebrew's version drifts over time, so neither system package is reproducible.
#
# The version comes from `package.json#nova.flatc` (single source of truth, also
# checked by `scripts/generate.ts` at generate time).
#
# Usage:
#   bash scripts/install-flatc.sh                  # → ~/.local/bin/flatc
#   FLATC_DEST=/usr/local/bin bash scripts/install-flatc.sh
#   FLATC_VERSION=25.9.23 bash scripts/install-flatc.sh
#
# CI: run it, then put the destination on PATH:
#   bash scripts/install-flatc.sh && echo "$HOME/.local/bin" >> "$GITHUB_PATH"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FLATC_DEST:-$HOME/.local/bin}"

# Read the pin from package.json ("nova": { "flatc": "25.9.23" }).
pinned() {
  sed -n 's/.*"flatc"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1
}

VERSION="${FLATC_VERSION:-$(pinned)}"
if [ -z "$VERSION" ]; then
  echo "install-flatc: could not read \"flatc\" from package.json (expected nova.flatc)" >&2
  exit 1
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) ASSET="Linux.flatc.binary.g++-13.zip" ;;
  Darwin-arm64) ASSET="Mac.flatc.binary.zip" ;;
  Darwin-x86_64) ASSET="MacIntel.flatc.binary.zip" ;;
  *)
    echo "install-flatc: no pinned flatc asset is published for ${OS}/${ARCH}." >&2
    echo "Install flatc ${VERSION} manually (https://github.com/google/flatbuffers/releases/tag/v${VERSION})." >&2
    exit 1
    ;;
esac

URL="https://github.com/google/flatbuffers/releases/download/v${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "install-flatc: ${VERSION} (${ASSET}) → ${DEST}/flatc"
curl -fsSL "$URL" -o "$TMP/flatc.zip"
unzip -o -q "$TMP/flatc.zip" -d "$TMP"
if [ ! -f "$TMP/flatc" ]; then
  echo "install-flatc: the archive did not contain a flatc binary" >&2
  exit 1
fi
mkdir -p "$DEST"
install -m 0755 "$TMP/flatc" "$DEST/flatc"

# Fail loudly if the binary cannot run (wrong arch / corrupt download).
"$DEST/flatc" --version

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "install-flatc: add ${DEST} to PATH to use it (export PATH=\"$DEST:\$PATH\")" ;;
esac
