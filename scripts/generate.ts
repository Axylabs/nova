/**
 * `bun run generate` — builds the whole wire stack from the TypeBox schemas.
 *
 *   1. TypeBox model → `src/generated/fbs/backend.fbs`
 *   2. `flatc --ts`  → `src/generated/ts/`      (browser + Bun decoders)
 *   3. `flatc --rust`→ `src/generated/rust/`    → copied into `rust/src/generated/backend.rs`
 *   4. Rust glue    → `rust/src/transcode/generated.rs`
 *   5. Registry     → `src/generated/registry.ts` (server + client event routing)
 *
 * Requires `flatc` on PATH (the FlatBuffers compiler). Keep the flatc binary
 * and the `flatbuffers` crate/npm versions aligned.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_VERSION } from "../src/codegen/constants";
import { emitDirectSer } from "../src/codegen/direct-gen";
import { schemaFingerprint } from "../src/codegen/fingerprint";
import { eventId } from "../src/codegen/hash";
import { emitRegistry } from "../src/codegen/registry-gen";
import { emitRustGlue } from "../src/codegen/rust-glue-gen";
import { buildModel } from "../src/codegen/schema-model";
import { emitTsSer } from "../src/codegen/ts-ser-gen";
import { emitFbs } from "../src/codegen/typebox-to-fbs";
import { controlEvents, events, schemas } from "../src/schema/index";

const ROOT = join(import.meta.dir, "..");

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    throw new Error(
      `command failed (${res.status}): ${cmd} ${args.join(" ")}\n` +
        `Is \`flatc\` installed? Run \`bash scripts/install-flatc.sh\` (pinned ${flatcPin()}), ` +
        `or install it yourself (brew install flatbuffers / download from https://flatbuffers.dev).`,
    );
  }
}

/** The pinned flatc version, from `package.json#nova.flatc` (single source). */
function flatcPin(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    nova?: { flatc?: string };
  };
  return pkg.nova?.flatc ?? "25.9.23";
}

/**
 * `flatc` writes BOTH the Rust tables and the TS decoders, so its version must
 * track the `flatbuffers` crate/npm range. A mismatch in the MAJOR version is
 * fatal: an older compiler emits Rust that does not build against the 25.x crate
 * (that is exactly how CI broke — apt's flatc → 137 errors in
 * `rust/src/generated/backend.rs`). Minor/patch drift only warns.
 */
function assertFlatcVersion(): void {
  const pin = flatcPin();
  const res = spawnSync("flatc", ["--version"], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      `\`flatc\` is not on PATH. Install the pinned ${pin} with:\n` +
        `  bash scripts/install-flatc.sh   # → ~/.local/bin/flatc\n` +
        `then put it on PATH (or set FLATC_DEST to a directory that already is).`,
    );
  }
  const installed = res.stdout.trim().replace(/^flatc version\s*/, "");
  const major = (v: string): string => v.split(".")[0] ?? "";
  if (major(installed) !== major(pin)) {
    throw new Error(
      `flatc ${installed} is incompatible with the pinned ${pin}: a different major version ` +
        `generates code that does not match the \`flatbuffers\` crate/npm range.\n` +
        `Install the pinned compiler: bash scripts/install-flatc.sh`,
    );
  }
  if (installed !== pin) {
    console.warn(`⚠  flatc ${installed} differs from the pinned ${pin} (same major — continuing).`);
  }
}

function main(): void {
  assertFlatcVersion();
  const model = buildModel(schemas as never, events as never, controlEvents as never);

  // Stable-hash collision check: every event must have a unique FNV-1a id.
  // (Astronomically unlikely for sane registries, but a hard fail beats a
  // silently ambiguous wire id.)
  const seen = new Map<number, string>();
  for (const ev of model.events) {
    const id = eventId(ev.name);
    const existing = seen.get(id);
    if (existing !== undefined) {
      throw new Error(
        `event id collision: "${ev.name}" and "${existing}" both hash to ${id} — rename one of them`,
      );
    }
    seen.set(id, ev.name);
  }

  // 1. .fbs
  const fbsDir = join(ROOT, "src", "generated", "fbs");
  mkdirSync(fbsDir, { recursive: true });
  const fbsPath = join(fbsDir, "backend.fbs");
  writeFileSync(fbsPath, emitFbs(model));

  // 2. + 3. flatc (ts + rust)
  for (const lang of ["ts", "rust"] as const) {
    const outDir = join(ROOT, "src", "generated", lang);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const args =
      lang === "ts"
        ? ["--ts", "--gen-object-api", "-o", outDir, fbsPath]
        : ["--rust", "-o", outDir, fbsPath];
    run("flatc", args, fbsDir);
  }

  // copy flatc rust output into the crate (flatc emits a single <schema>_generated.rs)
  const rustGenDir = join(ROOT, "src", "generated", "rust");
  const rsFiles = readdirSync(rustGenDir).filter((f) => f.endsWith(".rs"));
  if (rsFiles.length !== 1) {
    throw new Error(`expected exactly one .rs from flatc --rust, got: [${rsFiles.join(", ")}]`);
  }
  const crateGenDir = join(ROOT, "rust", "src", "generated");
  mkdirSync(crateGenDir, { recursive: true });
  copyFileSync(join(rustGenDir, rsFiles[0]!), join(crateGenDir, "backend.rs"));
  // flatc's templates trip lints we do not own (unused `Verifiable` imports,
  // missing `# Safety` docs on the generated table accessors, lifetimes that
  // are unused in the impl). Allow them for the whole generated module subtree
  // so `cargo clippy -- -D warnings` gates OUR hand-written surface
  // (ffi.rs / transcode glue) instead of machine output.
  writeFileSync(
    join(crateGenDir, "mod.rs"),
    "// @generated by scripts/generate.ts — DO NOT EDIT\n" +
      "#![allow(unused_imports, clippy::missing_safety_doc, clippy::extra_unused_lifetimes)]\n" +
      "pub mod backend;\n",
  );

  // 4. Rust JSON→FlatBuffer glue
  const fingerprint = schemaFingerprint(model, WIRE_VERSION);
  const transcodeDir = join(ROOT, "rust", "src", "transcode");
  mkdirSync(transcodeDir, { recursive: true });
  writeFileSync(join(transcodeDir, "generated.rs"), emitRustGlue(model, fingerprint));
  writeFileSync(
    join(transcodeDir, "mod.rs"),
    "// @generated by scripts/generate.ts — DO NOT EDIT\npub mod generated;\n",
  );

  // 5. registry (server + client) + direct fast-path serde + browser JS encoder
  writeFileSync(join(ROOT, "src", "generated", "registry.ts"), emitRegistry(model, fingerprint));
  writeFileSync(join(ROOT, "src", "generated", "direct-ser.ts"), emitDirectSer(model));
  writeFileSync(join(ROOT, "src", "generated", "ts-ser.ts"), emitTsSer(model));

  // 6. machine-readable event-id registry for external consumers (NATS bridge,
  //    independent clients). Same FNV-1a ids as the generated registry.
  const wireRegistry = {
    version: WIRE_VERSION,
    fingerprint,
    events: Object.fromEntries(model.events.map((ev) => [ev.name, eventId(ev.name)])),
  };
  writeFileSync(
    join(ROOT, "src", "generated", "wire-registry.json"),
    `${JSON.stringify(wireRegistry, null, 2)}\n`,
  );

  console.log(
    `generated ✓  (${model.events.length} events, ${model.tables.length} tables, ${model.enums.length} enums)`,
  );
}

main();
