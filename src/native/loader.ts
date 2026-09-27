import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectMusl, hostTriple, libName, prebuildTags } from "./targets";

/**
 * Resolve the Rust cdylib path for the CURRENT platform/arch.
 *
 * Resolution order (first hit wins):
 *   1. `IGNEX_FFI_PATH` env override (absolute path to the addon) — returned
 *      verbatim, so a not-yet-built path fails at `dlopen` with a clear error
 *      instead of silently loading some other addon.
 *   2. in-repo dev builds: `<repo>/rust/target[/<triple>]/release/<lib>`
 *   3. packaged npm layout: `<pkg>/prebuilds/<tag>/<lib>` for every tag the host
 *      can load, best match first (`linux-x64-gnu` before `linux-x64-musl` on
 *      glibc, musl-first on musl, then the legacy `<platform>-<arch>` tag) —
 *      the matrix lives in `src/native/targets.ts`.
 *
 * The host/tag logic is shared with the build, pre-publish and postinstall
 * scripts; this module only turns it into paths and probes the filesystem.
 * `addonCandidatesFor()` is pure, so resolution order is unit-testable without
 * mutating the process-global cache. Bun is the only supported runtime; the
 * addon is built per-OS/arch (see README + docs/publishing.md).
 */

/** The cdylib filename for a platform (`.so` / `.dylib` / `.dll`). */
export function addonFilename(platform: string = process.platform): string {
  return libName(platform);
}

const here = import.meta.dir;

/**
 * Candidate addon paths for an EXPLICIT host (pure — unit-testable), in
 * preference order: dev builds first, then the packaged prebuild tags for both
 * the bundled (`<pkg>/dist`) and source (`<pkg>/src/native`) module layouts.
 *
 * @param platform `process.platform`-style value
 * @param arch `process.arch`-style value
 * @param musl whether the host uses musl libc (see `detectMusl`)
 * @param baseDir directory of the calling module (`src/native` or `dist`)
 */
export function addonCandidatesFor(
  platform: string,
  arch: string,
  musl: boolean,
  baseDir: string = here,
): string[] {
  const file = libName(platform);
  const candidates: string[] = [];

  // Layout roots, package root first: `baseDir` is `<pkg>/src/native` (source)
  // or `<pkg>/dist` (bundled), so the package root is two (resp. one) levels up.
  // The extra `baseDir` root keeps the historical `<pkg>/src/prebuilds` nesting
  // loadable.
  const roots = [join(baseDir, "..", ".."), join(baseDir, ".."), baseDir];

  // In-repo dev builds: plain `cargo build --release`, then the target-triple
  // variant (`cargo build --release --target <triple>`) used for cross builds.
  const triple = hostTriple(platform, arch, musl);
  for (const root of roots) {
    candidates.push(join(root, "rust", "target", "release", file));
    if (triple !== undefined) {
      candidates.push(join(root, "rust", "target", triple, "release", file));
    }
  }

  // Packaged layout: `<pkg>/prebuilds/<tag>/<lib>` for every loadable tag,
  // best libc match first.
  for (const root of roots) {
    for (const tag of prebuildTags(platform, arch, musl)) {
      candidates.push(join(root, "prebuilds", tag, file));
    }
  }

  return [...new Set(candidates)];
}

/** Candidate addon paths for the host running this process (no fs access). */
export function addonCandidates(): string[] {
  return addonCandidatesFor(process.platform, process.arch, detectMusl(process.platform));
}

/** Every candidate that EXISTS on disk, in preference order (cached). */
let cachedExisting: string[] | undefined;
export function getAddonPathCandidates(): string[] {
  if (cachedExisting === undefined) {
    cachedExisting = addonCandidates().filter((candidate) => existsSync(candidate));
  }
  return cachedExisting;
}

/** The Rust triple of the host, or `undefined` when outside the matrix. */
export function addonHostTriple(): string | undefined {
  return hostTriple(process.platform, process.arch);
}

/**
 * Resolve the addon path: `IGNEX_FFI_PATH` if set (verbatim), else the first
 * existing candidate. Throws a single error listing every path tried — that
 * failure mode is what consumers actually hit, so it stays actionable.
 */
export function getAddonPath(): string {
  const override = process.env.IGNEX_FFI_PATH;
  if (override) return override;
  const candidates = addonCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `ignex: native addon not found. Tried:\n  ${candidates.join("\n  ")}\n` +
      `Build it: cargo build --release --manifest-path rust/Cargo.toml  (or set IGNEX_FFI_PATH)`,
  );
}
