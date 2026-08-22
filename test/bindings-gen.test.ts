/**
 * Generic bindings tests — `generateBindings` for ANY user schema, end to end:
 *   1. generation (files, wire registry, fingerprint, reserved control events)
 *   2. in-memory bindings: encode → decode round-trips (app + control frames)
 *   3. real server + client speaking a CUSTOM schema over a WebSocket
 *   4. NATS bridge with custom bindings (inbound decode + bridgeClientEvents)
 *   5. FFI schema-fingerprint guard (mismatched addon fails bind)
 *
 * Requires: `bun run generate` + `cargo build --release` (the built-in addon is
 * used by the fingerprint guard test).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { createClient } from "../public/client";
import { type GeneratedBindings, generateBindings } from "../public/generate";
import { createServer } from "../public/server";
import { defaultBindings } from "../src/bindings/default";
import type { Bindings, EventsOf } from "../src/bindings/types";
import { createNatsBridge, type NatsTransport } from "../src/bridge/nats";
import { eventId } from "../src/codegen/hash";
import { bindFfi } from "../src/native/ffi";
import { waitFor } from "./helpers";

// ── a user's custom schema ────────────────────────────────────────────────
const ChatMsg = Type.Object(
  { room: Type.String(), text: Type.String(), ts: Type.Integer() },
  { additionalProperties: false },
);
const Telemetry = Type.Object(
  { device: Type.String(), readings: Type.Array(Type.Number()), ok: Type.Boolean() },
  { additionalProperties: false },
);
const Alert = Type.Object(
  {
    level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const customSchema = {
  schemas: { ChatMsg, Telemetry, Alert },
  events: { chat: ChatMsg, telemetry: Telemetry, alert: Alert },
};

type MakeBindings = <E extends Record<string, TSchema>, C extends Record<string, TSchema>>(schema: {
  events: E;
  controlEvents?: C;
}) => Omit<Bindings, "events" | "controlEvents"> & { events: E; controlEvents: C };

let genDir = "";
let generated: GeneratedBindings | undefined;
let makeBindings: MakeBindings | undefined;
let bindings: Bindings | undefined;

beforeAll(async () => {
  genDir = mkdtempSync(join(import.meta.dir, ".gen-"));
  generated = generateBindings(
    customSchema,
    { outDir: join(genDir, "ignex"), libraryImport: "../../.." }, // resolve to the repo root (the package)
  );
  generated.write();
  const mod = (await import(join(genDir, "ignex", "index.ts"))) as { makeBindings: MakeBindings };
  makeBindings = mod.makeBindings;
  const { controlEvents } = await import("../src/schema");
  bindings = makeBindings({ events: customSchema.events, controlEvents });
});

afterAll(() => {
  if (genDir) rmSync(genDir, { recursive: true, force: true });
});

describe("generateBindings (any schema)", () => {
  test("emits the full wire stack", () => {
    const files = generated!.files;
    expect(files["backend.fbs"]).toContain("table ChatMsg");
    expect(files["ts/backend.ts"]).toContain("ChatMsg");
    expect(files["registry.ts"]).toContain("eventNameToId");
    expect(files["ts-ser.ts"]).toContain("encodeEventFrame");
    expect(files["direct-ser.ts"]).toContain("directSymbols");
    expect(files["index.ts"]).toContain("makeBindings");
    expect(files["wire-registry.json"]).toContain("chat");
    expect(files["rust/Cargo.toml"]).toContain("[lib]");
    expect(files["rust/src/ffi.rs"]).toContain("fb_schema_fingerprint");
    // generated registry is self-contained (user mode: no schema import)
    expect(files["registry.ts"]).not.toContain('from "../schema"');
  });

  test("dotted event names produce valid identifiers (regression)", () => {
    const Dotted = Type.Object({ a: Type.String() }, { additionalProperties: false });
    const dotted = generateBindings(
      { schemas: { Dotted }, events: { "chat.send": Dotted } },
      { outDir: join(genDir, "dotted") },
    );
    dotted.write();
    const files = dotted.files;
    // direct-ser.ts keys must be quoted (a bare `fb_chat.send_serialize:` is
    // invalid TS for dotted event names).
    expect(files["direct-ser.ts"]).toContain('"fb_chat.send_serialize"');
    // ts-ser.ts jsEncoders + direct-ser hasNul/directEncoders keyed by name.
    expect(files["ts-ser.ts"]).toContain('"chat.send": encodeChatSendPayload as JsEncoder');
    expect(files["direct-ser.ts"]).toContain('"chat.send": hasNulChatSend');
    expect(files["direct-ser.ts"]).toContain('"chat.send": encodeChatSend');
    // registry maps keyed by name.
    expect(files["registry.ts"]).toContain('"chat.send":');
    // rust glue: valid fn identifier + exact C symbol via #[export_name].
    expect(files["rust/src/transcode/generated.rs"]).toContain(
      '#[export_name = "fb_chat.send_serialize"]',
    );
    expect(files["rust/src/transcode/generated.rs"]).toContain("fn fb_chat_send_serialize(");
  });

  test("wire registry uses stable FNV-1a ids + a deterministic fingerprint", () => {
    const reg = generated!.wireRegistry;
    expect(reg.events["chat"]).toBe(eventId("chat"));
    expect(reg.events["telemetry"]).toBe(eventId("telemetry"));
    // standard control events are always present
    expect(reg.events["ping"]).toBe(eventId("ping"));
    expect(reg.events["hello"]).toBe(eventId("hello"));
    const again = generateBindings(customSchema, { outDir: join(genDir, "again") });
    expect(again.fingerprint).toBe(generated!.fingerprint);
    expect(again.wireRegistry).toEqual(reg);
  });

  test("reserved control events cannot be overridden", () => {
    const Pong = Type.Object({ custom: Type.String() }, { additionalProperties: false });
    expect(() =>
      generateBindings({ events: { chat: ChatMsg }, controlEvents: { pong: Pong } }),
    ).toThrow(/reserved by the transport protocol/);
  });

  test("force: false refuses to overwrite an existing outDir", () => {
    expect(existsSync(join(genDir, "ignex"))).toBe(true);
    expect(() =>
      generateBindings(customSchema, { outDir: join(genDir, "ignex"), force: false }).write(),
    ).toThrow(/already exists/);
  });

  test("rust: false omits the crate scaffold", () => {
    const g = generateBindings(customSchema, { outDir: join(genDir, "no-rust"), rust: false });
    expect(g.files["rust/Cargo.toml"]).toBeUndefined();
  });
});

describe("in-memory bindings (custom schema)", () => {
  test("EventsOf<B> derives the plain shapes from the custom schema (compile-time)", () => {
    // The typed API (createServer / createClient with `bindings`) is what the
    // whole generic story is about — assert the derived types resolve to the
    // plain object shapes, not `unknown`.
    const local = makeBindings!({ events: customSchema.events });
    type E = EventsOf<typeof local>;
    type Assert<T extends true> = T;
    type Check = Assert<
      { chat: Static<typeof ChatMsg>; telemetry: Static<typeof Telemetry> } extends Pick<
        E,
        "chat" | "telemetry"
      >
        ? true
        : false
    >;
    const check: Check = true;
    void check;
  });

  test("encode → decode round-trips app events", () => {
    const b = bindings!;
    const frame = b.encodeFrame("chat", { room: "general", text: "hi", ts: 5 });
    expect(frame[0]).toBe(b.wireVersion);
    const dec = b.decodeFrame(frame)!;
    expect(dec.name).toBe("chat");
    expect(dec.payload).toEqual({ room: "general", text: "hi", ts: 5 });

    const t = b.encodeFrame("telemetry", { device: "d1", readings: [1.5, -2.5], ok: false });
    expect(b.decodeFrame(t)!.payload).toEqual({ device: "d1", readings: [1.5, -2.5], ok: false });
  });

  test("enums (string unions) round-trip", () => {
    const b = bindings!;
    const f = b.encodeFrame("alert", { level: "critical", message: "boom" });
    expect(b.decodeFrame(f)!.payload).toEqual({ level: "critical", message: "boom" });
  });

  test("control frames encode/decode with the standard ids; unknown events throw", () => {
    const b = bindings!;
    const p = b.encodeFrame("ping", { ts: 1 });
    const dec = b.decodeFrame(p)!;
    expect(dec.name).toBe("ping");
    expect(b.isControlId(dec.id)).toBe(true);
    expect([...b.controlIds]).toContain(b.anyEventNameToId["ping"]!);
    expect(() => b.encodeFrame("doesNotExist", {})).toThrow(/no JS encoder/);
  });

  test("unknown-id frames decode to null", () => {
    const b = bindings!;
    const junk = new Uint8Array([b.wireVersion, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
    expect(b.decodeFrame(junk)).toBeNull();
  });
});

describe("server + client with custom bindings", () => {
  test("typed publish/on + inbound send work over a real WebSocket", async () => {
    const b = bindings!;
    const server = createServer({ port: 0, bindings: b, inbound: ["chat"] as never });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url, { bindings: b });
    const gotChat: unknown[] = [];
    const gotAlert: unknown[] = [];
    const serverGot: unknown[] = [];

    server.on("chat", (payload) => serverGot.push(payload));
    client.on("chat", (c) => gotChat.push(c));
    client.on("alert", (a) => gotAlert.push(a));
    client.connect();
    await waitFor(() => server.clientCount === 1);

    // server → client
    server.publish("chat", { room: "lobby", text: "hello world", ts: 1 });
    await waitFor(() => gotChat.length === 1);
    expect(gotChat[0]).toEqual({ room: "lobby", text: "hello world", ts: 1 });

    // server → client (enum event)
    server.publish("alert", { level: "warn", message: "careful" });
    await waitFor(() => gotAlert.length === 1);
    expect(gotAlert[0]).toEqual({ level: "warn", message: "careful" });

    // client → server (inbound)
    client.send("chat", { room: "lobby", text: "from client", ts: 2 });
    await waitFor(() => serverGot.length === 1);
    expect(serverGot[0]).toEqual({ room: "lobby", text: "from client", ts: 2 });

    client.close();
    server.stop();
  });
});

describe("NATS bridge with custom bindings", () => {
  test("inbound frames decode with the custom bindings + client events re-publish to {prefix}.inbound.<event>", async () => {
    const b = bindings!;
    const t = new FakeTransport();
    const bridge = createNatsBridge(
      { inbound: true, bindings: b, bridgeClientEvents: true, subjectPrefix: "app" },
      t,
    );
    const server = createServer({ port: 0, nats: bridge, bindings: b, inbound: ["chat"] as never });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url, { bindings: b });
    const clientGot: unknown[] = [];
    const serverGot: unknown[] = [];
    server.on("chat", (p) => serverGot.push(p));
    client.on("telemetry", (p) => clientGot.push(p));
    client.connect();
    await waitFor(() => server.clientCount === 1);

    // a client-sent event is re-published to app.inbound.chat (horizontal scaling)
    client.send("chat", { room: "x", text: "cluster-wide", ts: 7 });
    await waitFor(() => serverGot.length === 1);
    const pub = t.published.find((p) => p.subject === "app.inbound.chat");
    expect(pub).toBeDefined();
    // the bridged bytes decode with the custom bindings (same schema)
    expect(b.decodeFrame(pub!.data)!.payload).toEqual({ room: "x", text: "cluster-wide", ts: 7 });

    // an external NATS publisher's frame (encoded with the custom bindings)
    // reaches clients — and is NOT re-bridged (no loop)
    const before = t.published.length;
    t.emit(
      "app.inbound.telemetry",
      b.encodeFrame("telemetry", { device: "d9", readings: [9], ok: true }),
    );
    await waitFor(() => clientGot.length === 1);
    expect(clientGot[0]).toEqual({ device: "d9", readings: [9], ok: true });
    expect(t.published.length).toBe(before);

    client.close();
    server.stop();
  });

  test("bridge decodes with the custom bindings even standalone", () => {
    const b = bindings!;
    const t = new FakeTransport();
    const bridge = createNatsBridge({ inbound: true, bindings: b }, t);
    const got: Array<{ name: string; payload: unknown }> = [];
    bridge.setOnInbound((name, payload) => got.push({ name, payload }));
    t.emit("ignex.inbound.alert", b.encodeFrame("alert", { level: "info", message: "hi" }));
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe("alert");
    expect(got[0]!.payload).toEqual({ level: "info", message: "hi" });
    void bridge.close();
  });
});

describe("FFI schema-fingerprint guard", () => {
  test("bindFfi succeeds for the built-in bindings (matching addon)", () => {
    const dl = bindFfi(defaultBindings);
    expect(dl.bindings.fb_schema_fingerprint()).toBe(defaultBindings.schemaFingerprint);
  });

  test("a schema-mismatched addon fails bind with a clear error", () => {
    const wrong = { ...defaultBindings, schemaFingerprint: defaultBindings.schemaFingerprint + 1 };
    expect(() => bindFfi(wrong)).toThrow(/schema fingerprint .* was built from a different schema/);
  });
});

// ── fake NATS transport (mirrors test/nats-bridge.test.ts) ────────────────
function matchSubject(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true;
    if (p[i] === "*") continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

class FakeTransport implements NatsTransport {
  connected = true;
  published: Array<{ subject: string; data: Uint8Array }> = [];
  private subs: Array<{ subject: string; cb: (data: Uint8Array) => void }> = [];
  async close(): Promise<void> {}
  publish(subject: string, data: Uint8Array): void {
    this.published.push({ subject, data: new Uint8Array(data) });
  }
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void {
    this.subs.push({ subject, cb });
    return () => {
      this.subs = this.subs.filter((s) => s.cb !== cb);
    };
  }
  emit(subject: string, data: Uint8Array): void {
    for (const s of this.subs) if (matchSubject(s.subject, subject)) s.cb(data);
  }
}

describe("generateBindings — typed FE client emission (client option)", () => {
  test("emits a typed client.gen.ts (bindings + createRealtimeClient)", () => {
    const out = generateBindings(customSchema, {
      outDir: join(genDir, "client-gen"),
      client: { schemaImport: "./schema" },
    });
    const client = out.files["client.gen.ts"];
    expect(client).toBeDefined();
    expect(client).toContain("// @generated by ignex-nova generate");
    expect(client).toContain('export const bindings = makeBindings(schema);');
    expect(client).toContain("export type RealtimeBindings = typeof bindings;");
    expect(client).toContain("export type RealtimeClient = IgnClient<RealtimeBindings>;");
    expect(client).toContain('import { createClient } from "@ignex/nova/client";');
    expect(client).toContain('import { makeBindings } from "./index";');
    expect(client).toContain('import * as schema from "./schema";');
    expect(client).toContain("createClient(url, { ...options, bindings })");
    // Event names typed from the schema (dotted names included where present).
    expect(client).toMatch(/RealtimeEventName = "chat" \| "telemetry" \| "alert"/);
    expect(out.files["client.gen.ts"]).toContain('Omit<IgnClientOptions<RealtimeBindings>, "bindings">');
  });

  test("the emitted client imports + assembles cleanly with a real schema", async () => {
    const dir = join(genDir, "client-typed");
    const out = generateBindings(
      { schemas: { ChatMsg }, events: { "chat.send": ChatMsg, "chat.message": ChatMsg } },
      { outDir: dir, client: { schemaImport: "./schema" } },
    );
    out.write(); // wipes + recreates dir, then writes the generated files
    // Write the app's schema module NEXT to the generated client (the same
    // layout real apps have: src/schema + generated/ under one package) —
    // AFTER generation, since write() recreates the outDir.
    writeFileSync(
      join(dir, "schema.ts"),
      `import { Type } from "@sinclair/typebox";
export const ChatMsg = Type.Object({ room: Type.String(), text: Type.String(), ts: Type.Integer() }, { additionalProperties: false });
export const schemas = { ChatMsg };
export const events = { "chat.send": ChatMsg, "chat.message": ChatMsg };
export const controlEvents = {};
`,
    );
    // The emitted module must import + assemble cleanly with the real schema.
    const clientMod = (await import(join(dir, "client.gen.ts"))) as {
      createRealtimeClient: (url: string, o?: unknown) => unknown;
      bindings: unknown;
    };
    expect(typeof clientMod.createRealtimeClient).toBe("function");
    expect(clientMod.bindings).toBeDefined();
  });
});
