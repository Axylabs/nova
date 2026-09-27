#!/usr/bin/env bun
/**
 * Version + release-contract consistency check (`bun run check:version`).
 *
 * A `v*` tag release must not ship a version mismatch, and the multi-platform
 * contract must be resolvable by the loader. This gate fails (exit 1) when:
 *
 *   1. `package.json` version ≠ `rust/Cargo.toml` `[package] version`
 *   2. `CHANGELOG.md` exists but has no `## [Unreleased]` section, or no section
 *      for the current version (Keep a Changelog layout the release script
 *      finalizes: `## [Unreleased]` → `## [<version>] — <date>`)
 *   3. `package.json#nova.targets` is empty, or declares a triple that
 *      `src/native/targets.ts` cannot map to a `prebuilds/<tag>/` artifact —
 *      which would publish an addon the loader never finds
 *
 * Wired into CI and into `bun run verify`, so drift is caught before a tag.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_TARGETS, targetFromTriple } from "../src/native/targets";

const root = join(import.meta.dir, "..");

function fail(message: string): never {
  console.error(`\n✖ check:version — ${message}`);
  process.exit(1);
}

/** Read a top-level `key = "value"` from a Cargo.toml `[section]`. */
export function cargoField(manifestPath: string, section: string, key: string): string {
  const lines = readFileSync(manifestPath, "utf8").split("\n");
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (inSection && trimmed.startsWith(`${key} = `)) {
      const match = /^[A-Za-z0-9_]+\s*=\s*"([^"]*)"/.exec(trimmed);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  throw new Error(`could not find [${section}] ${key} in ${manifestPath}`);
}

/** Escape regex metacharacters so a version like `0.1.7` cannot match other text. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assert the changelog carries an `[Unreleased]` section plus a section for
 * `version` (pure — unit-testable).
 */
export function changelogProblems(changelog: string, version: string): string[] {
  const problems: string[] = [];
  if (!/^## \[Unreleased\]/m.test(changelog)) {
    problems.push("missing a `## [Unreleased]` section");
  }
  if (!new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(changelog)) {
    problems.push(`missing a \`## [${version}]\` section`);
  }
  return problems;
}

/**
 * Assert `nova.targets` is a non-empty list of triples the loader can map to a
 * `prebuilds/<tag>/` artifact (pure — unit-testable).
 */
export function targetProblems(triples: unknown): string[] {
  if (!Array.isArray(triples) || triples.length === 0) {
    return ['`nova.targets` must be a non-empty array of Rust target triples'];
  }
  const problems: string[] = [];
  for (const triple of triples) {
    if (typeof triple !== "string") {
      problems.push(`\`nova.targets\` entry is not a string: ${JSON.stringify(triple)}`);
    } else if (targetFromTriple(triple) === undefined) {
      problems.push(`\`nova.targets\` declares "${triple}" with no mapping in src/native/targets.ts`);
    }
  }
  return problems;
}

/**
 * Matrix triples that `package.json` does not declare. Advisory only: shipping a
 * SUBSET of the matrix is a deliberate choice (e.g. skipping musl), but the
 * mismatch is worth surfacing so the build matrix and the release stay aligned.
 */
export function undeclaredTargets(triples: unknown): string[] {
  if (!Array.isArray(triples)) return [];
  const declared = new Set(triples.filter((t): t is string => typeof t === "string"));
  return NATIVE_TARGETS.filter((t) => !declared.has(t.triple)).map((t) => t.triple);
}

function main(): void {
  const pkgPath = join(root, "package.json");
  const cargoPath = join(root, "rust", "Cargo.toml");
  const changelogPath = join(root, "CHANGELOG.md");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version?: string;
    nova?: { targets?: unknown };
  };
  const version = pkg.version;
  if (version === undefined) fail("package.json has no version");

  const cargoVersion = cargoField(cargoPath, "package", "version");
  console.log(`package.json version : ${version}`);
  console.log(`Cargo.toml version   : ${cargoVersion}`);

  const problems: string[] = [];
  if (version !== cargoVersion) {
    problems.push(
      `package.json version (${version}) != rust/Cargo.toml version (${cargoVersion}) — ` +
        `run \`bun run release <patch|minor|major>\` to sync them`,
    );
  }

  if (existsSync(changelogPath)) {
    const changelog = readFileSync(changelogPath, "utf8");
    for (const problem of changelogProblems(changelog, version)) {
      problems.push(`CHANGELOG.md ${problem}`);
    }
    console.log(`CHANGELOG.md         : entries checked for ${version}`);
  } else {
    console.log("CHANGELOG.md         : absent (skipped)");
  }

  for (const problem of targetProblems(pkg.nova?.targets)) {
    problems.push(problem);
  }
  const triples = (pkg.nova?.targets ?? []) as string[];
  console.log(`native targets       : ${triples.length} declared`);
  const undeclared = undeclaredTargets(pkg.nova?.targets);
  if (undeclared.length > 0) {
    console.warn(
      `  ⚠  the matrix also knows: ${undeclared.join(", ")} (not declared in package.json)`,
    );
  }

  if (problems.length > 0) {
    fail(`${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  }
  console.log("\n✔ check:version — versions, changelog and the native target contract agree");
}

if (import.meta.main) main();
