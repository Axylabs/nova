#!/usr/bin/env bun
/**
 * `postinstall` — source-build fallback for the native addon.
 *
 * The tarball ships PREBUILT addons for every target in `package.json`
 * (`nova.targets`): CI builds one per target and `scripts/prepublish.ts` verifies
 * the set is complete before publishing. On a supported platform this script is
 * therefore a fast no-op. It exists so the package stays usable when the
 * prebuilt path is NOT available:
 *
 *   - the host is outside the declared matrix (e.g. linux-armv7, freebsd,
 *     win32-arm64),
 *   - a partial tarball was published locally (`IGNEX_PUBLISH_ALLOW_PARTIAL=1`),
 *   - the shipped artifact cannot be dlopen'd and the user wants a matching
 *     rebuild (`npm install --build-from-source`).
 *
 * In those cases it runs `cargo build --release` inside the installed package
 * and stages the cdylib into every `prebuilds/<tag>/` directory the loader
 * probes for this host (so whichever tag is tried first finds a correct file).
 *
 * Short-circuits, in order:
 *   1. an artifact for this host already exists (staged prebuild or a repo dev
 *      build) → skip; forced with `npm_config_build_from_source=true`
 *   2. this is the repository checkout itself (`.git` present) → skip, the
 *      contributor runs `bun run build:rust`
 *   3. `IGNEX_SKIP_BUILD` is set, or CI is detected → skip (CI builds explicitly)
 *   4. no `cargo`/`rustc` on PATH → warn + skip
 *   5. `cargo build --release` → stage the cdylib into the host tag directories
 *
 * `IGNEX_REQUIRE_BUILD=1` turns every "warn and skip" into a hard failure, for
 * environments that must guarantee a loadable addon.
 *
 * NOTE: Bun does not run dependency lifecycle scripts by default — a Bun
 * consumer that wants the fallback must add `@ignex/nova` to
 * `trustedDependencies` (npm consumers run it normally). Either way, a missing
 * addon without the fallback is reported by the loader's "build it" error, and
 * `IGNEX_FFI_PATH` always remains an escape hatch.
 *
 * The pure helpers are exported for tests (`test/postinstall.test.ts`); the
 * script only auto-runs when invoked directly.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostTarget, libName, prebuildDir, prebuildTags } from "../src/native/targets";

const ROOT = join(import.meta.dir, "..");

const log = (message: string): void => console.log(`postinstall: ${message}`);
const warn = (message: string): void => console.warn(`postinstall: WARNING: ${message}`);

/** Side-effecting operations, injectable so tests never touch the real fs/cargo. */
export interface PostinstallProbes {
  exists(path: string): boolean;
  /** File size in bytes, or 0 when the path is missing/unreadable. */
  size(path: string): number;
  commandExists(command: string): boolean;
  /** Run `cargo build --release`; returns the exit code. */
  build(root: string): number;
  copy(from: string, to: string): void;
  mkdir(path: string): void;
}

export type PostinstallEnv = Record<string, string | undefined>;

export interface PostinstallOptions {
  platform?: string;
  arch?: string;
  musl?: boolean;
  env?: PostinstallEnv;
  probes?: Partial<PostinstallProbes>;
}

export interface PostinstallResult {
  /** `built` when a source build was staged, `skip` otherwise. */
  status: "skip" | "built";
  /** Machine-readable reason (log/assert friendly). */
  reason: string;
  /** Host prebuild tag directories the loader probes, best match first. */
  tags: string[];
}

/** Real probes: filesystem + `cargo build --release`. */
function realProbes(): PostinstallProbes {
  return {
    exists: (path) => existsSync(path),
    size: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
    commandExists: (command) => {
      const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
        stdio: "ignore",
      });
      return probe.status === 0;
    },
    build: (root) => {
      // Windows needs a shell so `cargo` resolves through PATH/PATHEXT.
      const result =
        process.platform === "win32"
          ? spawnSync("cargo build --release", { cwd: root, stdio: "inherit", shell: true })
          : spawnSync("cargo", ["build", "--release"], { cwd: root, stdio: "inherit" });
      return result.status ?? 1;
    },
    copy: (from, to) => copyFileSync(from, to),
    mkdir: (path) => void mkdirSync(path, { recursive: true }),
  };
}

/**
 * Ensure a loadable native addon exists for this host, building from source as
 * a fallback when no prebuilt ships. Every input is injectable, and `cargo` is
 * only ever invoked after all short-circuit checks pass.
 */
export function ensureNativeAddon(
  root: string = ROOT,
  options: PostinstallOptions = {},
): PostinstallResult {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const probes = { ...realProbes(), ...options.probes };

  const target = hostTarget(platform, arch, options.musl);
  const tags = prebuildTags(platform, arch, options.musl);
  const file = target === undefined ? undefined : libName(platform);

  // 1. An artifact for this host already exists → nothing to do.
  const existing =
    file === undefined
      ? []
      : [
          join(root, "rust", "target", "release", file),
          ...(target === undefined ? [] : [join(root, "rust", "target", target.triple, "release", file)]),
          ...tags.map((tag) => join(prebuildDir(root, tag), file)),
        ];
  const found = existing.find((path) => probes.size(path) > 0);
  const force = env.npm_config_build_from_source === "true";

  if (found !== undefined && !force) {
    log(`addon present (${found}) — nothing to build`);
    return { status: "skip", reason: "prebuilt", tags };
  }
  if (force) log("npm_config_build_from_source set — forcing a source rebuild");

  // 2. The repository checkout builds explicitly (`bun run build:rust`); don't
  //    make `bun install` compile Rust for contributors.
  if (probes.exists(join(root, ".git"))) {
    log("repository checkout detected — skipping (run `bun run build:rust`)");
    return { status: "skip", reason: "checkout", tags };
  }

  if (target === undefined) {
    const message =
      `this host (${platform}/${arch}) is not in the native target matrix ` +
      `(package.json "nova.targets") and no prebuilt addon is staged for it. ` +
      `Build the addon manually and set IGNEX_FFI_PATH, or use a supported platform.`;
    if (env.IGNEX_REQUIRE_BUILD) throw new Error(message);
    warn(message);
    return { status: "skip", reason: "unsupported-host", tags };
  }

  // 3. Explicit opt-out / CI (the workflows build the addon themselves).
  if (env.IGNEX_SKIP_BUILD) {
    warn(
      "IGNEX_SKIP_BUILD is set — skipping the source build. Without a prebuilt " +
        "for this platform the native addon is missing at runtime.",
    );
    return { status: "skip", reason: "env", tags };
  }
  if (env.CI) {
    warn("CI detected — skipping the source build (CI builds the addon explicitly).");
    return { status: "skip", reason: "ci", tags };
  }

  // 4. Toolchain check.
  if (!probes.commandExists("cargo") || !probes.commandExists("rustc")) {
    const message =
      `no Rust toolchain (cargo/rustc) found — cannot build the ignex addon for ` +
      `${platform}/${arch}. Install Rust (https://rustup.rs) and re-run the install, ` +
      `or set IGNEX_SKIP_BUILD=1 to silence this warning.`;
    if (env.IGNEX_REQUIRE_BUILD) throw new Error(message);
    warn(message);
    return { status: "skip", reason: "no-toolchain", tags };
  }

  // 5. Build + stage.
  log(
    `no prebuilt addon for ${platform}/${arch} — building from source ` +
      "(cargo build --release; needs network to crates.io on a cold cache)",
  );
  if (probes.build(root) !== 0) {
    const message = `cargo build --release failed; the addon could not be built for ${platform}/${arch}.`;
    if (env.IGNEX_REQUIRE_BUILD) throw new Error(message);
    warn(message);
    return { status: "skip", reason: "build-failed", tags };
  }

  const built = join(root, "rust", "target", "release", libName(platform));
  if (probes.size(built) === 0) {
    const message = `build finished but no cdylib was found at ${built}`;
    if (env.IGNEX_REQUIRE_BUILD) throw new Error(message);
    warn(message);
    return { status: "skip", reason: "artifact-missing", tags };
  }

  // Copy the SAME freshly-built binary to every tag the loader probes: only one
  // is ever loaded (the first that exists), and because it was built on this
  // exact host its content always matches — so the gnu/musl probe order cannot
  // pick a wrong-but-present file.
  for (const tag of tags) {
    probes.mkdir(prebuildDir(root, tag));
    probes.copy(built, join(prebuildDir(root, tag), libName(platform)));
  }
  log(`built + staged the addon for ${platform}/${arch}: prebuilds/{${tags.join(", ")}}`);
  return { status: "built", reason: "built", tags };
}

if (import.meta.main) {
  try {
    ensureNativeAddon();
  } catch (err) {
    console.error(`\npostinstall: ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
