/**
 * Build the Rust cdylib and stage it into `prebuilds/<tag>/` so the packaged
 * npm layout serves a working addon out of the box (the loader's packaged-layout
 * fallback — see `src/native/loader.ts`).
 *
 * The target/tag mapping lives in `src/native/targets.ts` (the same matrix the
 * loader, the pre-publish gate and the postinstall fallback use).
 *
 * Wired as `prepack`, so both `bun pm pack` and `bun publish` stage the addon
 * for the CURRENT platform automatically. CI (`.github/workflows/publish.yml`)
 * calls it once per matrix target with `--target`, so the published tarball
 * carries every declared platform.
 *
 * Usage:
 *   bun scripts/build-prebuild.ts                       # host target (prepack)
 *   bun scripts/build-prebuild.ts --target <triple>      # stage a specific target
 *   bun scripts/build-prebuild.ts --lib-dir <dir>        # stage a prebuilt cdylib
 *   bun scripts/build-prebuild.ts --target <t> --zigbuild  # musl cross build
 *   bun scripts/build-prebuild.ts --no-build             # only copy/verify
 *
 * Consumers on a platform without a prebuild can still use the package:
 *   - `IGNEX_FFI_PATH=/abs/path/to/libignex_ffi.so bun run ...`
 *   - or rebuild from the shipped rust/ source:
 *     `cargo build --release --manifest-path node_modules/ignex-nova/rust/Cargo.toml`
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  hostTarget,
  libName,
  prebuildDir,
  targetFromTriple,
  type NativeTarget,
} from "../src/native/targets";

const root = join(import.meta.dir, "..");

interface Options {
  target: string | undefined;
  libDir: string | undefined;
  build: boolean;
  profile: "release" | "debug";
  zigbuild: boolean;
}

/** The cargo invocation for a target (pure — unit-tested).
 *
 * `cargo-zigbuild` is a cargo SUBCOMMAND: the supported invocation is
 * `cargo zigbuild …` (the installer puts `cargo-zigbuild` on PATH and cargo
 * dispatches to it). Running the binary directly as `cargo-zigbuild build …`
 * is not a documented usage — that is what broke the aarch64-musl CI job.
 */
export function cargoInvocation(
  target: NativeTarget,
  options: Pick<Options, "profile" | "zigbuild">,
  useTargetFlag: boolean,
): { command: string; args: string[] } {
  return {
    command: "cargo",
    args: [
      options.zigbuild ? "zigbuild" : "build",
      ...(options.profile === "release" ? ["--release"] : []),
      ...(useTargetFlag ? ["--target", target.triple] : []),
      "--manifest-path",
      join("rust", "Cargo.toml"),
    ],
  };
}

function parseArgs(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    target: value("target"),
    libDir: value("lib-dir"),
    build: !argv.includes("--no-build"),
    profile: argv.includes("--debug") ? "debug" : "release",
    zigbuild: argv.includes("--zigbuild"),
  };
}

function die(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** Resolve the target to build: explicit `--target`, else the host. */
function resolveTarget(requested: string | undefined): NativeTarget {
  if (requested !== undefined) {
    const target = targetFromTriple(requested);
    if (target === undefined) {
      die(
        `target "${requested}" is not in the native matrix (src/native/targets.ts).\n` +
          `Add it there AND to package.json "nova.targets", then regenerate.`,
      );
    }
    return target;
  }
  const host = hostTarget();
  if (host === undefined) {
    die(
      `no target for this host (${process.platform}/${process.arch}).\n` +
        `Pass --target <triple> explicitly, or add the platform to src/native/targets.ts.`,
    );
  }
  return host;
}

/** Where cargo puts the cdylib for a target/profile (both layouts). */
function buildOutputs(target: NativeTarget, profile: Options["profile"]): string[] {
  const file = libName(target.platform);
  return [
    join(root, "rust", "target", target.triple, profile, file),
    join(root, "rust", "target", profile, file),
  ];
}

function runCargo(target: NativeTarget, options: Options, useTargetFlag: boolean): void {
  const { command, args } = cargoInvocation(target, options, useTargetFlag);
  console.log(`\n⚙  ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) {
    die(
      `could not run \`${command} ${args[0]}\` (${result.error.message}).` +
        (options.zigbuild ? " Install it: cargo install cargo-zigbuild (+ zig on PATH)." : ""),
    );
  }
  if (result.status !== 0) {
    die(`\`${command} ${args[0]}\` failed (exit ${result.status ?? "?"}).`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget(options.target);
  const file = libName(target.platform);

  if (options.build) {
    // Only pass `--target` when it was requested explicitly: the host build must
    // not require that triple's std to be installed.
    runCargo(target, options, options.target !== undefined);
  }

  const candidates =
    options.libDir !== undefined
      ? [join(options.libDir, file)]
      : buildOutputs(target, options.profile);
  const built = candidates.find((candidate) => existsSync(candidate));
  if (built === undefined) {
    die(
      `no cdylib found for ${target.triple}. Looked in:\n  ${candidates.join("\n  ")}\n` +
        `Build it: bun run build:rust${options.target !== undefined ? ` -- --target ${target.triple}` : ""}`,
    );
  }

  const outDir = prebuildDir(root, target.tag);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, join(outDir, file));
  console.log(`✔ Staged ${file} → prebuilds/${target.tag}/${file}`);
  console.log(`  target ${target.triple} (${options.profile})`);
}

if (import.meta.main) main();

