/**
 * Platform addon resolution tests (Phase 7 + the multi-platform matrix):
 *   - the cdylib filename maps per-platform (.so / .dylib / .dll)
 *   - candidate order: dev build → target-triple dev build → prebuild tags
 *     (best libc match first, legacy tag last), for both module layouts
 *   - getAddonPath honors IGNEX_FFI_PATH and resolves the dev build on Linux
 */
import { describe, expect, test } from "bun:test";
import {
  addonCandidates,
  addonCandidatesFor,
  addonFilename,
  getAddonPath,
  getAddonPathCandidates,
} from "../src/native/loader";

/** The `prebuilds/<tag>` segment of a candidate path, or undefined. */
function tagOf(candidate: string): string | undefined {
  const parts = candidate.split("/");
  const i = parts.lastIndexOf("prebuilds");
  return i === -1 ? undefined : parts[i + 1];
}

describe("addon resolution", () => {
  test("filename maps per-platform", () => {
    expect(addonFilename("linux")).toBe("libignex_ffi.so");
    expect(addonFilename("darwin")).toBe("libignex_ffi.dylib");
    expect(addonFilename("win32")).toBe("ignex_ffi.dll");
    expect(() => addonFilename("plan9")).toThrow(/unsupported platform/);
  });

  test("candidates include the platform-appropriate dev build + prebuilds layout", () => {
    const cands = addonCandidates();
    const file = addonFilename();
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands[0]!.endsWith(`rust/target/release/${file}`)).toBe(true);
    expect(cands.some((c) => c.includes("prebuilds"))).toBe(true);
  });

  test("candidate order prefers the host libc, then the legacy tag", () => {
    const tags = (platform: string, arch: string, musl: boolean): string[] =>
      addonCandidatesFor(platform, arch, musl, "/pkg/src/native")
        .map(tagOf)
        .filter((t): t is string => t !== undefined);

    expect([...new Set(tags("linux", "x64", false))]).toEqual([
      "linux-x64-gnu",
      "linux-x64-musl",
      "linux-x64",
    ]);
    expect([...new Set(tags("linux", "x64", true))]).toEqual([
      "linux-x64-musl",
      "linux-x64-gnu",
      "linux-x64",
    ]);
    expect([...new Set(tags("darwin", "arm64", false))]).toEqual(["darwin-arm64"]);
    expect([...new Set(tags("win32", "x64", false))]).toEqual(["win32-x64-msvc", "win32-x64"]);
  });

  test("cross-built dev artifacts are candidates too (rust/target/<triple>/release)", () => {
    const cands = addonCandidatesFor("linux", "arm64", true, "/pkg/src/native");
    expect(cands).toContain("/pkg/rust/target/aarch64-unknown-linux-musl/release/libignex_ffi.so");
    // The plain dev build still comes first.
    expect(cands[0]).toBe("/pkg/rust/target/release/libignex_ffi.so");
  });

  test("both packaged module layouts resolve the package-root prebuilds", () => {
    const source = addonCandidatesFor("darwin", "arm64", false, "/pkg/src/native");
    const bundled = addonCandidatesFor("darwin", "arm64", false, "/pkg/dist");
    expect(source).toContain("/pkg/prebuilds/darwin-arm64/libignex_ffi.dylib");
    expect(bundled).toContain("/pkg/prebuilds/darwin-arm64/libignex_ffi.dylib");
    expect(bundled).toContain("/pkg/rust/target/release/libignex_ffi.dylib");
  });

  test("IGNEX_FFI_PATH override wins", () => {
    const prev = process.env.IGNEX_FFI_PATH;
    process.env.IGNEX_FFI_PATH = "/tmp/custom/libignex_ffi.so";
    try {
      expect(getAddonPath()).toBe("/tmp/custom/libignex_ffi.so");
    } finally {
      if (prev === undefined) delete process.env.IGNEX_FFI_PATH;
      else process.env.IGNEX_FFI_PATH = prev;
    }
  });

  test("resolves the dev build when it exists (Linux CI/repo layout)", async () => {
    const p = getAddonPath();
    expect(p.endsWith(addonFilename())).toBe(true);
    expect(await Bun.file(p).exists()).toBe(true);
  });

  test("every candidate returned by getAddonPathCandidates exists, in order", async () => {
    const candidates = getAddonPathCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(await Bun.file(candidate).exists()).toBe(true);
    }
    // The surviving candidates keep their relative preference order.
    const all = addonCandidates();
    const indices = candidates.map((candidate) => all.indexOf(candidate));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});
