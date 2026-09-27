#!/usr/bin/env bun
/**
 * Installed-tarball end-to-end check (`bun run verify:install`).
 *
 * The unit/e2e suites import the package from the REPO layout, so they never
 * exercise the production path: installing the packed tarball and importing it
 * from `node_modules`. This script packs the package, installs the tarball into
 * a throwaway consumer project, and imports it there — proving that the
 * *shipped* layout resolves:
 *
 *   - the `exports` map (all 8 subpaths) from `node_modules/@ignex/nova`
 *   - the staged native addon from `prebuilds/<tag>/` (packed by `prepack`)
 *   - the FFI bind-time self-tests (probe magic → wire version → fingerprint →
 *     frame invariant → per-symbol), i.e. the same checks a consumer runs
 *
 * `bun pm pack` runs `prepack` → `scripts/build-prebuild.ts`, so the host
 * target's addon is staged automatically (a partial multi-platform tarball,
 * which is exactly what a local pack produces).
 *
 * Usage: bun run verify:install        (needs the Rust toolchain; uses the network
 *                                       to install the package's dependencies)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const keep = process.env.IGNEX_VERIFY_INSTALL_KEEP === "1";

/** Run a command in `cwd`, streaming nothing; returns { status, stdout }. */
function run(args: string[], cwd: string): { status: number; stdout: string } {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function die(message: string): never {
  console.error(`\n✖ verify:install — ${message}`);
  process.exit(1);
}

/** The consumer smoke script: import the installed package + exercise FFI. */
const SMOKE = `
import { createServer } from "@ignex/nova/server";
import { encodeUtf8Into, utf8Len } from "@ignex/nova/internal";
import { defaultBindings } from "@ignex/nova/bindings";

const bytes = new Uint8Array(64);
if (encodeUtf8Into("nova", bytes) !== 4 || utf8Len("nova") !== 4) {
  throw new Error("internal codec helpers failed");
}
if (defaultBindings.events === undefined) throw new Error("bindings missing");

// createServer binds the cdylib (ffiMode: required) and runs every bind-time
// self-test — the addon must be found under prebuilds/<tag>/ in node_modules.
const server = createServer({ port: 0 });
if (!Number.isInteger(server.port) || server.port <= 0) {
  throw new Error("server did not bind to a port");
}
server.publish("quote", {
  symbol: "AAPL", bid: 180.1, ask: 180.2, bidSize: 100, askSize: 200, ts: Date.now(),
});
server.stop(true);
console.log("INSTALL-OK");
`;

const tmp = mkdtempSync(join(tmpdir(), "nova-install-"));
try {
  // 1. Pack (prepack → bun run prebuild stages this host's addon).
  console.log("📦 packing the tarball (prepack stages the host addon) …");
  const pack = run([process.execPath, "pm", "pack", "--destination", tmp], root);
  if (pack.status !== 0) {
    die(`bun pm pack failed:\n${pack.stdout}`);
  }
  const tarball = readdirSync(tmp).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) {
    die(`bun pm pack produced no .tgz in ${tmp}\n${pack.stdout}`);
  }
  const tarballPath = join(tmp, tarball);
  console.log(`   ${tarball}`);

  // 2. Consumer project that depends on the packed tarball.
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer, { recursive: true });
  const packageJson = {
    name: "nova-install-consumer",
    private: true,
    type: "module",
    dependencies: { "@ignex/nova": `file:${tarballPath}` },
  };
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log("📥 installing the tarball into a throwaway consumer …");
  const install = run([process.execPath, "install"], consumer);
  if (install.status !== 0) {
    die(
      `installing the packed tarball failed (a network connection is required for the ` +
        `package's dependencies):\n${install.stdout}`,
    );
  }
  if (!existsSync(join(consumer, "node_modules", "@ignex", "nova"))) {
    die("the tarball did not install as node_modules/@ignex/nova");
  }

  // 3. Import from node_modules and exercise the installed layout.
  const smokeFile = join(consumer, "smoke.ts");
  writeFileSync(smokeFile, SMOKE);
  console.log("▶ importing the installed package (FFI self-tests must pass) …");
  const smoke = run([process.execPath, smokeFile], consumer);
  if (!smoke.stdout.includes("INSTALL-OK")) {
    die(`the installed-package smoke check failed:\n${smoke.stdout}`);
  }

  console.log("\n✔ verify:install — the packed tarball installs, imports and binds the addon");
} finally {
  if (keep) {
    console.log(`\nℹ  IGNEX_VERIFY_INSTALL_KEEP=1 — kept ${tmp}`);
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }
}
