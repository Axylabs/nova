/**
 * Native target matrix tests (`src/native/targets.ts`):
 *   - triple ↔ tag/platform/arch/libc mapping is total and unique
 *   - prebuild tag preference order per host (glibc vs musl, legacy last)
 *   - musl detection from injected filesystem probes (never the real fs)
 *   - the cdylib filename map
 */
import { describe, expect, test } from "bun:test";
import {
  NATIVE_TARGETS,
  detectMusl,
  hostTarget,
  hostTriple,
  libName,
  prebuildDir,
  prebuildLibPath,
  prebuildTags,
  targetFromTriple,
  targetsFromTriples,
} from "../src/native/targets";

describe("native target matrix", () => {
  test("triples and tags are unique and well formed", () => {
    const triples = NATIVE_TARGETS.map((t) => t.triple);
    const tags = NATIVE_TARGETS.map((t) => t.tag);
    expect(new Set(triples).size).toBe(triples.length);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of NATIVE_TARGETS) {
      expect(t.tag.startsWith(`${t.platform}-${t.arch}`)).toBe(true);
      if (t.libc !== null) expect(t.tag.endsWith(`-${t.libc}`)).toBe(true);
    }
  });

  test("every declared runtime platform/arch has a target", () => {
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["darwin", "arm64"],
      ["win32", "x64"],
    ] as const) {
      expect(prebuildTags(platform, arch, false).length).toBeGreaterThan(0);
    }
  });

  test("targetFromTriple maps both directions", () => {
    const gnu = targetFromTriple("x86_64-unknown-linux-gnu");
    expect(gnu?.tag).toBe("linux-x64-gnu");
    expect(gnu?.platform).toBe("linux");
    expect(gnu?.arch).toBe("x64");
    expect(gnu?.libc).toBe("gnu");
    expect(targetFromTriple("riscv64gc-unknown-linux-gnu")).toBeUndefined();
  });

  test("targetsFromTriples splits known from unknown triples", () => {
    const { found, unknown } = targetsFromTriples([
      "aarch64-apple-darwin",
      "mips-unknown-linux-gnu",
    ]);
    expect(found.map((t) => t.tag)).toEqual(["darwin-arm64"]);
    expect(unknown).toEqual(["mips-unknown-linux-gnu"]);
  });

  test("libName maps the three platforms and rejects others", () => {
    expect(libName("linux")).toBe("libignex_ffi.so");
    expect(libName("darwin")).toBe("libignex_ffi.dylib");
    expect(libName("win32")).toBe("ignex_ffi.dll");
    expect(() => libName("plan9")).toThrow(/unsupported platform/);
  });

  test("prebuildLibPath nests the lib under the target tag", () => {
    const t = targetFromTriple("aarch64-unknown-linux-musl")!;
    expect(prebuildDir("/pkg", t.tag)).toBe("/pkg/prebuilds/linux-arm64-musl");
    expect(prebuildLibPath("/pkg", t)).toBe("/pkg/prebuilds/linux-arm64-musl/libignex_ffi.so");
  });
});

describe("prebuild tag preference", () => {
  test("a glibc host probes gnu before musl, then the legacy tag", () => {
    expect(prebuildTags("linux", "x64", false)).toEqual([
      "linux-x64-gnu",
      "linux-x64-musl",
      "linux-x64",
    ]);
  });

  test("a musl host probes musl before gnu, then the legacy tag", () => {
    expect(prebuildTags("linux", "x64", true)).toEqual([
      "linux-x64-musl",
      "linux-x64-gnu",
      "linux-x64",
    ]);
  });

  test("darwin/win32 keys have no libc split", () => {
    expect(prebuildTags("darwin", "arm64", false)).toEqual(["darwin-arm64"]);
    expect(prebuildTags("win32", "x64", false)).toEqual(["win32-x64-msvc", "win32-x64"]);
  });

  test("an unsupported host still yields the legacy tag (no crash)", () => {
    expect(prebuildTags("freebsd", "x64", false)).toEqual(["freebsd-x64"]);
  });
});

describe("host triple resolution", () => {
  test("resolves the declared targets per platform/arch/libc", () => {
    expect(hostTriple("linux", "x64", false)).toBe("x86_64-unknown-linux-gnu");
    expect(hostTriple("linux", "x64", true)).toBe("x86_64-unknown-linux-musl");
    expect(hostTriple("linux", "arm64", true)).toBe("aarch64-unknown-linux-musl");
    expect(hostTriple("darwin", "arm64", false)).toBe("aarch64-apple-darwin");
    expect(hostTriple("win32", "x64", false)).toBe("x86_64-pc-windows-msvc");
  });

  test("returns undefined outside the matrix", () => {
    expect(hostTriple("win32", "arm64", false)).toBeUndefined();
    expect(hostTriple("freebsd", "x64", false)).toBeUndefined();
    expect(hostTarget("freebsd", "x64", false)).toBeUndefined();
  });

  test("hostTarget exposes the full record", () => {
    expect(hostTarget("darwin", "x64", false)?.tag).toBe("darwin-x64");
  });
});

describe("musl detection (injected probes)", () => {
  const probes = (opts: {
    files?: string[];
    dirs?: Record<string, string[]>;
    glibcVersion?: string;
  }) => ({
    exists: (p: string) => (opts.files ?? []).includes(p),
    listDir: (p: string) => opts.dirs?.[p] ?? [],
    glibcVersion: opts.glibcVersion,
  });

  test("non-linux platforms are never musl", () => {
    expect(detectMusl("darwin", probes({ files: ["/etc/alpine-release"] }))).toBe(false);
    expect(detectMusl("win32", probes({ files: ["/etc/alpine-release"] }))).toBe(false);
  });

  test("an explicit glibc runtime version wins over distro markers", () => {
    expect(
      detectMusl("linux", probes({ files: ["/etc/alpine-release"], glibcVersion: "2.39" })),
    ).toBe(false);
  });

  test("alpine markers and the musl loader both count as musl", () => {
    expect(detectMusl("linux", probes({ files: ["/etc/alpine-release"] }))).toBe(true);
    expect(detectMusl("linux", probes({ files: ["/etc/apk"] }))).toBe(true);
    expect(detectMusl("linux", probes({ dirs: { "/lib": ["ld-musl-x86_64.so.1"] } }))).toBe(true);
  });

  test("a plain glibc host is not musl (probe failures are safe)", () => {
    expect(detectMusl("linux", probes({ dirs: { "/lib": ["libc.so.6"] } }))).toBe(false);
    expect(detectMusl("linux", probes({}))).toBe(false);
  });
});
