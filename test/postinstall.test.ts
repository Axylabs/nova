/**
 * Tests for the `postinstall` source-build fallback (`scripts/postinstall.ts`):
 * every short-circuit (prebuilt present, checkout, env opt-out, CI, no toolchain)
 * plus the build + multi-tag staging path. All effects are injected, so no test
 * touches the real filesystem or runs cargo.
 */
import { describe, expect, test } from "bun:test";
import { ensureNativeAddon, type PostinstallProbes } from "../scripts/postinstall";

interface Harness {
  probes: Partial<PostinstallProbes>;
  copied: string[];
  built: number;
  /** Flip the built cdylib to "present" after a build, like a real cargo run. */
  builtExists: boolean;
}

/** A fake probe set: nothing exists except what the test declares. */
function harness(existing: string[] = []): Harness {
  const files = new Set(existing);
  const state: Harness = { probes: {}, copied: [], built: 0, builtExists: true };
  state.probes = {
    exists: (path) => files.has(path),
    size: (path) => (files.has(path) ? 128 : 0),
    commandExists: () => true,
    build: () => {
      state.built += 1;
      if (state.builtExists) {
        for (const candidate of [
          "/pkg/rust/target/release/libignex_ffi.so",
          "/pkg/rust/target/x86_64-unknown-linux-gnu/release/libignex_ffi.so",
        ]) {
          files.add(candidate);
        }
      }
      return 0;
    },
    copy: (from, to) => state.copied.push(`${from} -> ${to}`),
    mkdir: () => {},
  };
  return state;
}

const HOST = { platform: "linux", arch: "x64", musl: false };

describe("postinstall fallback", () => {
  test("no-op when a staged prebuild for the host exists", () => {
    const state = harness(["/pkg/prebuilds/linux-x64-gnu/libignex_ffi.so"]);
    const result = ensureNativeAddon("/pkg", { ...HOST, probes: state.probes });
    expect(result.status).toBe("skip");
    expect(result.reason).toBe("prebuilt");
    expect(result.tags[0]).toBe("linux-x64-gnu");
  });

  test("npm_config_build_from_source forces a rebuild over an existing prebuild", () => {
    const state = harness(["/pkg/prebuilds/linux-x64-gnu/libignex_ffi.so"]);
    const result = ensureNativeAddon("/pkg", {
      ...HOST,
      probes: state.probes,
      env: { npm_config_build_from_source: "true" },
    });
    expect(result.status).toBe("built");
    expect(result.reason).toBe("built");
    expect(state.built).toBe(1);
  });

  test("a repository checkout is skipped (contributors build explicitly)", () => {
    const state = harness(["/pkg/.git"]);
    const result = ensureNativeAddon("/pkg", { ...HOST, probes: state.probes, env: {} });
    expect(result.status).toBe("skip");
    expect(result.reason).toBe("checkout");
  });

  test("IGNEX_SKIP_BUILD and CI both short-circuit the build", () => {
    const skipped = ensureNativeAddon("/pkg", {
      ...HOST,
      probes: harness().probes,
      env: { IGNEX_SKIP_BUILD: "1" },
    });
    expect(skipped.reason).toBe("env");

    const ci = ensureNativeAddon("/pkg", { ...HOST, probes: harness().probes, env: { CI: "true" } });
    expect(ci.reason).toBe("ci");
  });

  test("an unsupported host is reported, and IGNEX_REQUIRE_BUILD makes it fatal", () => {
    const state = harness();
    const result = ensureNativeAddon("/pkg", {
      platform: "freebsd",
      arch: "x64",
      probes: state.probes,
      env: {},
    });
    expect(result.status).toBe("skip");
    expect(result.reason).toBe("unsupported-host");

    expect(() =>
      ensureNativeAddon("/pkg", {
        platform: "freebsd",
        arch: "x64",
        probes: state.probes,
        env: { IGNEX_REQUIRE_BUILD: "1" },
      }),
    ).toThrow(/not in the native target matrix/);
  });

  test("without a Rust toolchain it warns and skips (fatal with IGNEX_REQUIRE_BUILD)", () => {
    const state = harness();
    state.probes.commandExists = () => false;
    const result = ensureNativeAddon("/pkg", { ...HOST, probes: state.probes, env: {} });
    expect(result.reason).toBe("no-toolchain");
    expect(() =>
      ensureNativeAddon("/pkg", {
        ...HOST,
        probes: state.probes,
        env: { IGNEX_REQUIRE_BUILD: "1" },
      }),
    ).toThrow(/no Rust toolchain/);
  });

  test("a failed cargo build is reported, not thrown (unless required)", () => {
    const state = harness();
    state.probes.build = () => 101;
    expect(ensureNativeAddon("/pkg", { ...HOST, probes: state.probes, env: {} }).reason).toBe(
      "build-failed",
    );
    expect(() =>
      ensureNativeAddon("/pkg", { ...HOST, probes: state.probes, env: { IGNEX_REQUIRE_BUILD: "1" } }),
    ).toThrow(/cargo build --release failed/);
  });

  test("builds + stages the cdylib into every host tag the loader probes", () => {
    const state = harness();
    const result = ensureNativeAddon("/pkg", { ...HOST, probes: state.probes, env: {} });
    expect(result.status).toBe("built");
    expect(result.tags).toEqual(["linux-x64-gnu", "linux-x64-musl", "linux-x64"]);
    expect(state.copied).toEqual(
      result.tags.map(
        (tag) => `/pkg/rust/target/release/libignex_ffi.so -> /pkg/prebuilds/${tag}/libignex_ffi.so`,
      ),
    );
  });

  test("a musl host stages musl first", () => {
    const state = harness();
    const result = ensureNativeAddon("/pkg", {
      platform: "linux",
      arch: "x64",
      musl: true,
      probes: state.probes,
      env: {},
    });
    expect(result.tags[0]).toBe("linux-x64-musl");
    expect(result.status).toBe("built");
  });
});
