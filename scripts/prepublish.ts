/**
 * Pre-publish gate: stage the CI-built artifacts into `prebuilds/` and verify
 * that EVERY target declared in `package.json` (`nova.targets`) ships a
 * non-empty, loadable cdylib.
 *
 * Wired as `prepublishOnly`, so neither a local `bun publish` nor the CI
 * publish job can ship a tarball that is missing a platform — the failure mode
 * is a consumer whose install silently has no addon.
 *
 * Artifact staging contract (CI): each build job uploads `prebuilds/` from its
 * own checkout, so the publish job downloads `prebuild-<tag>` artifacts into
 * `artifacts/` and this script merges every `prebuilds/` directory it finds
 * under `artifacts/` into the package's `prebuilds/`. Both download shapes are
 * handled (`artifacts/prebuilds/...` with `merge-multiple: true`, and
 * `artifacts/<artifact-name>/prebuilds/...` without).
 *
 * Env:
 *   IGNEX_PUBLISH_ALLOW_PARTIAL=1 — ship only the platforms present, with a
 *   loud warning (used by `bun run release:manual` for a local publish). The
 *   default (CI, `bun run release`) is a hard failure.
 *
 * Usage:
 *   bun scripts/prepublish.ts            # stage + verify (exit 1 on gaps)
 *   IGNEX_PUBLISH_ALLOW_PARTIAL=1 bun scripts/prepublish.ts
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  libName,
  prebuildDir,
  prebuildLibPath,
  targetFromTriple,
  type NativeTarget,
} from "../src/native/targets";

const root = join(import.meta.dir, "..");
const ARTIFACTS_DIR = join(root, "artifacts");

function die(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** The `nova.targets` triples declared in package.json (the release contract). */
export function declaredTriples(packageJsonPath: string = join(root, "package.json")): string[] {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    nova?: { targets?: unknown };
  };
  const targets = pkg.nova?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    die(`${packageJsonPath} is missing a non-empty "nova.targets" array.`);
  }
  if (!targets.every((t) => typeof t === "string")) {
    die(`"nova.targets" must be an array of Rust target triples.`);
  }
  return targets as string[];
}

/** One declared target plus the artifact path it must ship. */
export interface ExpectedArtifact {
  readonly triple: string;
  readonly target: NativeTarget;
  /** Path relative to the package root. */
  readonly path: string;
}

/** Map declared triples to their expected artifact paths (pure). */
export function expectedArtifacts(base: string, triples: readonly string[]): ExpectedArtifact[] {
  return triples.map((triple) => {
    const target = targetFromTriple(triple);
    if (target === undefined) {
      die(
        `"nova.targets" declares "${triple}" but src/native/targets.ts has no mapping for it.\n` +
          `Add it to NATIVE_TARGETS (or remove it from package.json) — the loader cannot find it otherwise.`,
      );
    }
    return {
      triple,
      target,
      path: relative(base, prebuildLibPath(base, target)).split("\\").join("/"),
    };
  });
}

/** Every directory named `prebuilds` found under `dir` (recursive). */
function findPrebuildDirs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (entry.name === "prebuilds") found.push(child);
    else findPrebuildDirs(child, found);
  }
  return found;
}

/**
 * Merge every `prebuilds/` directory under `artifacts/` into `<base>/prebuilds/`.
 * Returns the package-relative paths copied (empty when there is nothing to
 * stage, e.g. a local publish from a checkout that already staged the host).
 */
export function stageArtifacts(base: string = root, artifactsDir: string = ARTIFACTS_DIR): string[] {
  if (!existsSync(artifactsDir)) return [];
  const staged: string[] = [];
  for (const source of findPrebuildDirs(artifactsDir)) {
    for (const tag of readdirSync(source, { withFileTypes: true })) {
      if (!tag.isDirectory()) continue;
      for (const lib of readdirSync(join(source, tag.name))) {
        mkdirSync(prebuildDir(base, tag.name), { recursive: true });
        const destination = join(base, "prebuilds", tag.name, lib);
        copyFileSync(join(source, tag.name, lib), destination);
        staged.push(relative(base, destination).split("\\").join("/"));
      }
    }
  }
  return staged;
}

/** Present/missing split for the declared artifacts (pure). */
export function auditArtifacts(
  base: string,
  artifacts: readonly ExpectedArtifact[],
): { present: ExpectedArtifact[]; missing: ExpectedArtifact[] } {
  const present: ExpectedArtifact[] = [];
  const missing: ExpectedArtifact[] = [];
  for (const artifact of artifacts) {
    const absolute = join(base, artifact.path);
    let ok = false;
    try {
      ok = existsSync(absolute) && statSync(absolute).size > 0;
    } catch {
      ok = false;
    }
    (ok ? present : missing).push(artifact);
  }
  return { present, missing };
}

function main(): void {
  const triples = declaredTriples();
  const artifacts = expectedArtifacts(root, triples);

  const staged = stageArtifacts(root);
  if (staged.length > 0) {
    console.log(`\n📥 Staged ${staged.length} artifact(s) from artifacts/`);
  }

  const { present, missing } = auditArtifacts(root, artifacts);
  const allowPartial = process.env.IGNEX_PUBLISH_ALLOW_PARTIAL === "1";

  console.log(`\n🧩 Native targets (${triples.length} declared)\n`);
  for (const artifact of artifacts) {
    const ok = present.includes(artifact);
    console.log(`  ${ok ? "✔" : "✖"} ${artifact.target.tag.padEnd(18)} ${artifact.triple}`);
  }

  if (missing.length === 0) {
    console.log(
      `\n✔ All ${triples.length} declared targets staged — the tarball is multi-platform complete.`,
    );
    return;
  }

  const detail = missing
    .map((artifact) => `  - ${artifact.triple} (expected prebuilds/${artifact.target.tag}/${libName(artifact.target.platform)})`)
    .join("\n");

  if (allowPartial) {
    console.warn(
      `\n⚠  IGNEX_PUBLISH_ALLOW_PARTIAL=1 — publishing a PARTIAL tarball.\n` +
        `Missing platform addon(s):\n${detail}\n` +
        `Present: ${present.length}/${triples.length}. Consumers on the missing platforms must\n` +
        `rebuild from the shipped rust/ source (postinstall) or set IGNEX_FFI_PATH.\n` +
        `Push a v* tag to publish a full multi-platform tarball.`,
    );
    return;
  }

  die(
    `missing native addon artifact(s):\n${detail}\n\n` +
      `Every target in package.json "nova.targets" must ship in the tarball.\n` +
      `The CI "build" job (bun scripts/build-prebuild.ts --target <triple>) produces them\n` +
      `per target and the "publish" job downloads them into ./artifacts before running\n` +
      `this gate. Locally, stage them with:\n` +
      `  bun run prebuild                       # host target\n` +
      `  bun scripts/build-prebuild.ts --target <triple>   # one target\n` +
      `For a single-platform local publish, use: bun run release:manual`,
  );
}

if (import.meta.main) main();
