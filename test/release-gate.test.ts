/**
 * Tests for the multi-platform release gates:
 *   - `scripts/prepublish.ts` — artifact mapping, staging and the completeness audit
 *   - `scripts/check-version.ts` — changelog/target consistency helpers
 *
 * The `die()` paths call `process.exit`, so only the pure/observable helpers are
 * exercised here; the process-level behavior is covered by CI running the
 * scripts themselves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditArtifacts,
  declaredTriples,
  expectedArtifacts,
  stageArtifacts,
} from "../scripts/prepublish";
import { cargoField, changelogProblems, targetProblems, undeclaredTargets } from "../scripts/check-version";

const repoRoot = join(import.meta.dir, "..");
const tmpRoots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-gate-"));
  tmpRoots.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe("prepublish: artifact mapping", () => {
  test("maps every declared triple to its prebuilds/<tag>/<lib> path", () => {
    const base = tempRoot();
    const artifacts = expectedArtifacts(base, [
      "x86_64-unknown-linux-gnu",
      "aarch64-apple-darwin",
      "x86_64-pc-windows-msvc",
    ]);
    expect(artifacts.map((a) => a.path)).toEqual([
      "prebuilds/linux-x64-gnu/libignex_ffi.so",
      "prebuilds/darwin-arm64/libignex_ffi.dylib",
      "prebuilds/win32-x64-msvc/ignex_ffi.dll",
    ]);
  });

  test("package.json declares the triples the loader can map", () => {
    const triples = declaredTriples(join(repoRoot, "package.json"));
    expect(triples.length).toBeGreaterThan(0);
    expect(targetProblems(triples)).toEqual([]);
    expect(expectedArtifacts(tempRoot(), triples).length).toBe(triples.length);
  });
});

describe("prepublish: completeness audit", () => {
  test("splits present (non-empty) from missing artifacts", () => {
    const base = tempRoot();
    const artifacts = expectedArtifacts(base, [
      "x86_64-unknown-linux-gnu",
      "aarch64-apple-darwin",
    ]);
    const [linux, darwin] = artifacts as [(typeof artifacts)[number], (typeof artifacts)[number]];

    // A staged, non-empty artifact counts as present.
    write(join(base, linux.path), "cdylib");
    // An EMPTY placeholder (a truncated/failed upload) must not count.
    write(join(base, darwin.path), "");

    const { present, missing } = auditArtifacts(base, artifacts);
    expect(present.map((a) => a.target.tag)).toEqual(["linux-x64-gnu"]);
    expect(missing.map((a) => a.target.tag)).toEqual(["darwin-arm64"]);
  });

  test("no artifacts staged → everything is missing", () => {
    const base = tempRoot();
    const artifacts = expectedArtifacts(base, ["x86_64-apple-darwin"]);
    expect(auditArtifacts(base, artifacts).missing.length).toBe(1);
  });
});

describe("prepublish: artifact staging", () => {
  test("merges CI download shapes into prebuilds/", () => {
    const base = tempRoot();
    const artifactsDir = join(base, "artifacts");

    // Shape 1: `merge-multiple: true` → artifacts/prebuilds/<tag>/<lib>
    write(join(artifactsDir, "prebuilds/linux-x64-gnu/libignex_ffi.so"), "gnu");
    // Shape 2: per-artifact directory → artifacts/prebuild-<tag>/prebuilds/<tag>/<lib>
    write(join(artifactsDir, "prebuild-linux-x64-musl/prebuilds/linux-x64-musl/libignex_ffi.so"), "musl");

    const staged = stageArtifacts(base, artifactsDir).sort();
    expect(staged).toEqual([
      "prebuilds/linux-x64-gnu/libignex_ffi.so",
      "prebuilds/linux-x64-musl/libignex_ffi.so",
    ]);

    const artifacts = expectedArtifacts(base, ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"]);
    expect(auditArtifacts(base, artifacts).missing).toEqual([]);
  });

  test("a checkout with no artifacts/ directory stages nothing", () => {
    expect(stageArtifacts(tempRoot(), join(tempRoot(), "artifacts"))).toEqual([]);
  });
});

describe("check:version helpers", () => {
  test("package.json and Cargo.toml versions agree in this repo", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(cargoField(join(repoRoot, "rust", "Cargo.toml"), "package", "version")).toBe(pkg.version);
  });

  test("changelogProblems requires Unreleased + the current version", () => {
    const good = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3]\n";
    expect(changelogProblems(good, "1.2.3")).toEqual([]);
    expect(changelogProblems("## [Unreleased]\n", "1.2.3")).toEqual([
      "missing a `## [1.2.3]` section",
    ]);
    expect(changelogProblems("## [1.2.3]\n", "1.2.3")).toEqual([
      "missing a `## [Unreleased]` section",
    ]);
    // Regex metacharacters in the version must not match unrelated headings.
    expect(changelogProblems("## [Unreleased]\n\n## [1.2.3]\n", "1.2.3")).toEqual([]);
  });

  test("targetProblems rejects empty, non-string and unmapped entries", () => {
    expect(targetProblems([])).toEqual(['`nova.targets` must be a non-empty array of Rust target triples']);
    expect(targetProblems(["x86_64-unknown-linux-gnu"])).toEqual([]);
    expect(targetProblems([42])).toEqual(['`nova.targets` entry is not a string: 42']);
    expect(targetProblems(["mips-unknown-linux-gnu"])).toEqual([
      '`nova.targets` declares "mips-unknown-linux-gnu" with no mapping in src/native/targets.ts',
    ]);
  });

  test("undeclaredTargets is advisory (matrix minus declaration)", () => {
    expect(undeclaredTargets(["x86_64-unknown-linux-gnu"])).toContain("aarch64-apple-darwin");
    expect(undeclaredTargets("nope")).toEqual([]);
  });
});
