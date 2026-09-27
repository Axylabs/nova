/**
 * Native target matrix — the single source of truth for multi-platform builds.
 *
 * `package.json` (`nova.targets`) declares WHICH Rust triples a release ships;
 * this module owns HOW a triple maps to a staged artifact
 * (`prebuilds/<tag>/<lib>`) and which tags a given host probes at runtime.
 * Every consumer of the matrix derives from it:
 *
 *   - `scripts/build-prebuild.ts` — stages the host (or `--target`) artifact
 *   - `scripts/prepublish.ts`     — pre-publish completeness gate (all targets)
 *   - `scripts/postinstall.ts`    — source-build fallback for the host
 *   - `src/native/loader.ts`      — runtime addon resolution
 *
 * A target is therefore added in exactly two places: here and in
 * `package.json#nova.targets`. The two are cross-checked by
 * `scripts/prepublish.ts` (a declared triple with no mapping fails the gate).
 *
 * Tag naming mirrors napi-rs' `<platform>-<arch>[-<libc>]` convention so the
 * layout is familiar, and the bare `<platform>-<arch>` tag stays loadable as a
 * legacy fallback for artifacts staged before the libc split:
 *
 *   linux  → prebuilds/linux-<arch>-gnu|musl/libignex_ffi.so
 *   darwin → prebuilds/darwin-<arch>/libignex_ffi.dylib
 *   win32  → prebuilds/win32-<arch>-msvc/ignex_ffi.dll
 *
 * `arch` values are Node/Bun's `process.arch` spelling (`x64`, `arm64`), not
 * Rust's (`x86_64`, `aarch64`) — the loader matches the runtime, the build
 * script translates to triples.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** libc flavor of a target: `null` when the platform has no libc split. */
export type NativeLibc = "gnu" | "musl" | "msvc" | null;

export interface NativeTarget {
  /** Rust target triple passed to `cargo --target`. */
  readonly triple: string;
  /** `process.platform`-style platform. */
  readonly platform: string;
  /** `process.arch`-style architecture. */
  readonly arch: string;
  /** libc flavor (`null` for darwin). */
  readonly libc: NativeLibc;
  /** Prebuild directory name: `prebuilds/<tag>/<lib>`. */
  readonly tag: string;
}

const target = (
  triple: string,
  platform: string,
  arch: string,
  libc: NativeLibc,
): NativeTarget => ({
  triple,
  platform,
  arch,
  libc,
  tag: libc === null ? `${platform}-${arch}` : `${platform}-${arch}-${libc}`,
});

/**
 * Every target a release can ship, grouped so that each platform/arch lists its
 * preferred libc FIRST — a glibc host probes in declaration order, a musl host
 * re-sorts musl first (see {@link prebuildTags}). Keep this list in sync with
 * `package.json#nova.targets` (the pre-publish gate fails on drift).
 *
 * Portability: all binaries are baseline-CPU builds (no `-C target-cpu`), so a
 * published artifact runs on any host of its triple (see `.cargo/config.toml`).
 */
export const NATIVE_TARGETS: readonly NativeTarget[] = [
  target("x86_64-unknown-linux-gnu", "linux", "x64", "gnu"),
  target("aarch64-unknown-linux-gnu", "linux", "arm64", "gnu"),
  target("x86_64-unknown-linux-musl", "linux", "x64", "musl"),
  target("aarch64-unknown-linux-musl", "linux", "arm64", "musl"),
  target("x86_64-apple-darwin", "darwin", "x64", null),
  target("aarch64-apple-darwin", "darwin", "arm64", null),
  target("x86_64-pc-windows-msvc", "win32", "x64", "msvc"),
];

const BY_TRIPLE = new Map(NATIVE_TARGETS.map((t) => [t.triple, t]));

/** The target for a Rust triple, or `undefined` when it is not in the matrix. */
export function targetFromTriple(triple: string): NativeTarget | undefined {
  return BY_TRIPLE.get(triple);
}

/** The `prebuilds/<tag>` directory for a target tag under `root`. */
export function prebuildDir(root: string, tag: string): string {
  return join(root, "prebuilds", tag);
}

/** The staged artifact path for a target under `root` (no existence check). */
export function prebuildLibPath(root: string, t: NativeTarget): string {
  return join(prebuildDir(root, t.tag), libName(t.platform));
}

/** Every declared target that has a mapping in {@link NATIVE_TARGETS}. */
export function targetsFromTriples(triples: readonly string[]): {
  readonly found: readonly NativeTarget[];
  readonly unknown: readonly string[];
} {
  const found: NativeTarget[] = [];
  const unknown: string[] = [];
  for (const triple of triples) {
    const t = targetFromTriple(triple);
    if (t === undefined) unknown.push(triple);
    else found.push(t);
  }
  return { found, unknown };
}

const LIB_NAMES: Record<string, string> = {
  linux: "libignex_ffi.so",
  darwin: "libignex_ffi.dylib",
  win32: "ignex_ffi.dll",
};

/**
 * The cdylib filename a platform produces/loads (`.so` / `.dylib` / `.dll`).
 * Throws for an unsupported platform so a typo fails loudly instead of
 * resolving to `undefined` deep inside resolution.
 */
export function libName(platform: string = process.platform): string {
  const name = LIB_NAMES[platform];
  if (!name) throw new Error(`ignex: unsupported platform "${platform}"`);
  return name;
}

/** Filesystem probes for {@link detectMusl} — injectable so tests stay pure. */
export interface MuslProbes {
  exists(path: string): boolean;
  listDir(path: string): string[];
  /** `process.report.getReport().header.glibcVersionRuntime` when available. */
  glibcVersion?: string | undefined;
}

/** Markers that identify a musl-based distribution (Alpine and friends). */
const MUSL_MARKERS = ["/etc/alpine-release", "/etc/apk"];

/** `glibcVersionRuntime` from `process.report`, when the runtime exposes it. */
function glibcVersionRuntime(): string | undefined {
  const report = (
    process as unknown as {
      report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
    }
  ).report;
  try {
    return report?.getReport?.()?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

/** Real filesystem probes (only built when a linux host actually asks). */
function fsProbes(): MuslProbes {
  return {
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    glibcVersion: glibcVersionRuntime(),
  };
}

/**
 * Detect a musl libc host (linux only), so the loader prefers the
 * `*-musl` artifact and the build script stages the right tag.
 *
 * Graceful by design: an explicit glibc runtime version (from
 * `process.report`) is authoritative and returns `false`; otherwise the
 * distro markers (`/etc/alpine-release`, `/etc/apk`) and the musl loader
 * (`/lib/ld-musl-*.so.1`) are probed. Any probe failure counts as "not musl" —
 * and because the loader walks *every* candidate tag, a wrong guess degrades to
 * "try the other flavor" rather than a hard failure.
 *
 * @param platform `process.platform`-style value (musl only exists on linux)
 * @param probes injected filesystem probes (tests); real fs when omitted
 */
export function detectMusl(platform: string = process.platform, probes?: MuslProbes): boolean {
  if (platform !== "linux") return false;
  const p = probes ?? fsProbes();
  const glibc = p.glibcVersion;
  if (typeof glibc === "string" && glibc !== "") return false;
  if (MUSL_MARKERS.some((marker) => p.exists(marker))) return true;
  return p.listDir("/lib").some((entry) => entry.startsWith("ld-musl-"));
}

/** Preference rank of a libc flavor for a host (`null` = legacy/unknown last). */
function libcRank(libc: NativeLibc, preferred: "gnu" | "musl"): number {
  if (libc === preferred) return 0;
  if (libc === null) return 2;
  return 1;
}

/**
 * Prebuild tags to probe on a host, best match first: the matrix order for a
 * glibc host, musl-first on a musl host, then the legacy bare `<platform>-<arch>`
 * tag. First existing artifact wins, and the FFI binder falls through to the
 * next tag when `dlopen` fails, so a partial/stale stage still resolves.
 */
export function prebuildTags(
  platform: string = process.platform,
  arch: string = process.arch,
  musl?: boolean,
): string[] {
  const isMuslHost = platform === "linux" && (musl ?? detectMusl(platform));
  const matches = NATIVE_TARGETS.filter((t) => t.platform === platform && t.arch === arch);
  const ordered = isMuslHost
    ? [...matches].sort((a, b) => libcRank(a.libc, "musl") - libcRank(b.libc, "musl"))
    : matches;
  const tags = ordered.map((t) => t.tag);
  const legacy = `${platform}-${arch}`;
  return tags.includes(legacy) ? tags : [...tags, legacy];
}

/**
 * The Rust triple of the current host, or `undefined` when the host is outside
 * the declared matrix (the postinstall/build scripts then refuse to stage a
 * misleading tag instead of writing an artifact nothing will load).
 */
export function hostTriple(
  platform: string = process.platform,
  arch: string = process.arch,
  musl?: boolean,
): string | undefined {
  const isMuslHost = platform === "linux" && (musl ?? detectMusl(platform));
  const match = NATIVE_TARGETS.find(
    (t) =>
      t.platform === platform &&
      t.arch === arch &&
      (isMuslHost ? t.libc === "musl" : t.libc !== "musl"),
  );
  return match?.triple;
}

/** The full target record of the current host (see {@link hostTriple}). */
export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  musl?: boolean,
): NativeTarget | undefined {
  const triple = hostTriple(platform, arch, musl);
  return triple === undefined ? undefined : targetFromTriple(triple);
}
