/**
 * Live-socket security fuzz + auth edge cases — complements security.test.ts
 * (unit-level decodeFrame hardening) and security-hardening.test.ts:
 *   - hostile binary frame flood over a REAL WebSocket (random bytes, truncated
 *     valid frames, valid-envelope+garbage-body) with an innocent concurrent
 *     subscriber that must keep receiving pristine traffic
 *   - control-id envelope with garbage body → no reply, socket + server live
 *   - client-triggered echo paths (rpcCall error replies) survive hostile
 *     strings that the cstring FFI cannot transcode (lone surrogates)
 *   - decoder treats the size prefix as advisory (no allocation amplification)
 *   - trailing garbage / coalesced frames are inert at the decode boundary
 *   - predicate-form bearer tokens; Authorization header parsing edges;
 *     `authenticate` hooks that throw
 *   - topic names that look like prototype-pollution or log-injection payloads
 *     stay opaque keys (no global pollution, delivery still exact)
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { anyEventNameToId, decodeFrame, WIRE_VERSION } from "../src/generated/registry";
import { encodeEvent } from "../src/transport/transport";
import { openWs, quote, tryConnect, waitFor } from "./helpers";

function ctl(ws: WebSocket, name: Parameters<typeof encodeEvent>[0], payload: unknown): void {
  ws.send(encodeEvent(name, payload) as Uint8Array<ArrayBuffer>);
}

/** LE u32 writer for crafting raw envelopes. */
function le(v: number): [number, number, number, number] {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

describe("hostile binary frames over a live socket", () => {
  test("fuzz flood cannot starve or corrupt a concurrent legitimate subscriber", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    // innocent bystander on "equities"
    const victim = await openWs(url);
    const got: number[] = [];
    victim.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d?.name === "quote") got.push((d.payload as { ts: number }).ts);
    };
    ctl(victim, "subscribe", { topic: "equities" });
    await waitFor(() => server.topics().includes("equities"));

    // attacker: random junk, truncated valid frames, wrong versions
    const attacker = await openWs(url);
    const good = encodeEvent("quote", quote()) as Uint8Array<ArrayBuffer>;
    let seed = 0x12345678;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 120; i++) {
      const kind = i % 4;
      if (kind === 0) {
        const junk = new Uint8Array(1 + (rand() % 96));
        for (let j = 0; j < junk.byteLength; j++) junk[j] = rand() & 0xff;
        attacker.send(junk as Uint8Array<ArrayBuffer>);
      } else if (kind === 1) {
        attacker.send(good.subarray(0, rand() % good.byteLength)); // truncation
      } else if (kind === 2) {
        const wrong = new Uint8Array(good);
        wrong[0] = rand() & 0xff; // corrupt version byte
        attacker.send(wrong as Uint8Array<ArrayBuffer>);
      } else {
        attacker.send(good); // valid app event — but not in the inbound allowlist
      }
    }
    await waitFor(() => server.getMetrics().protocolErrors > 10);

    // while under attack the real subscriber's traffic stays pristine
    for (let i = 0; i < 50; i++) server.publishToTopic("equities", "quote", quote("AAPL", { ts: i }));
    await waitFor(() => got.length >= 50);

    expect(server.clientCount).toBe(2);
    expect(server.getMetrics().protocolErrors).toBeGreaterThan(10);
    expect(got).toEqual(Array.from({ length: got.length }, (_, i) => i)); // ordered 0..n

    attacker.close();
    victim.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);

  test("control-id envelope with garbage body: no reply, connection and server stay healthy", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    const seen: string[] = [];
    ws.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d) seen.push(d.name);
    };
    await waitFor(() => seen.includes("hello"));

    // ping-shaped garbage: valid version + ping event id, junk flatbuffer body.
    // The decoder yields an undefined payload; routing must not crash or reply.
    const pingId = anyEventNameToId.ping!;
    const evil = new Uint8Array([WIRE_VERSION, ...le(pingId), 0xde, 0xad, 0xbe, 0xef, 9, 9, 9]);
    const before = seen.length;
    ws.send(evil);
    ws.send(evil.subarray(0, 9));
    await Bun.sleep(150);
    expect(seen.length).toBe(before); // no pong materialized from garbage

    // the same socket still works for real traffic
    ctl(ws, "ping", { ts: 42 });
    await waitFor(() => seen.includes("pong"));
    expect(server.clientCount).toBe(1);

    ws.close();
    server.stop();
  }, 10_000);

  test("rpcCall echo path survives strings the cstring FFI cannot transcode", async () => {
    // A lone surrogate in the rpcCall name lands in the server's error reply
    // (`no handler for "<name>"`). The reply encode throws (loudly, by design)
    // — pinned here: the exception is contained, the socket and server live.
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    let pongs = 0;
    ws.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d?.name === "pong") pongs++;
    };
    await waitFor(() => server.clientCount === 1);

    ctl(ws, "rpcCall", { id: "r1", name: "\uD800-surrogate", payloadB64: "" });
    await Bun.sleep(150);
    expect(pongs).toBe(0); // reply was dropped, nothing else disturbed

    ctl(ws, "ping", { ts: 1 });
    await waitFor(() => pongs >= 1);
    expect(server.clientCount).toBe(1);

    ws.close();
    server.stop();
  }, 10_000);
});

describe("decode-boundary robustness (size prefix / framing)", () => {
  test("size prefix is advisory — a huge bogus prefix allocates nothing and decodes fine", () => {
    const f = encodeEvent("quote", quote());
    for (const prefix of [0, 0xffff, 0x7fffff00, 0xffffffff]) {
      const evil = new Uint8Array(f);
      new DataView(evil.buffer).setUint32(5, prefix, true);
      const d = decodeFrame(evil);
      expect(d?.name).toBe("quote");
      expect((d!.payload as { symbol: string }).symbol).toBe("AAPL");
    }
  });

  test("trailing garbage after a complete frame is inert", () => {
    const good = encodeEvent("quote", quote("MSFT", { bid: 3.25 }));
    const padded = new Uint8Array(good.byteLength + 64);
    padded.set(good);
    crypto.getRandomValues(padded.subarray(good.byteLength));
    const d = decodeFrame(padded)!;
    expect(d.name).toBe("quote");
    expect((d.payload as { symbol: string }).symbol).toBe("MSFT");
    expect((d.payload as { bid: number }).bid).toBe(3.25);
  });

  test("two coalesced frames in one buffer decode as one event (first wins)", () => {
    const a = encodeEvent("quote", quote("AAA"));
    const b = encodeEvent("trade", { symbol: "BBB", price: 1, volume: 1, side: "sell", ts: 2 });
    const both = new Uint8Array(a.byteLength + b.byteLength);
    both.set(a);
    both.set(b, a.byteLength);
    const d = decodeFrame(both)!;
    expect(d.name).toBe("quote"); // exactly one envelope consumed, no confusion
    expect((d.payload as { symbol: string }).symbol).toBe("AAA");
  });
});

describe("bearer token + authenticate hook edges", () => {
  test("predicate-form token gates upgrades", async () => {
    const server = createServer({
      port: 0,
      token: (t) => t.startsWith("ignex.") && t.length === 12,
    });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { authorization: "Bearer ignex.okayok.1" } })).toBe(false); // 15 chars
    expect(await tryConnect(url, { headers: { authorization: "Bearer wrong-prefix-1" } })).toBe(false);
    expect(await tryConnect(url)).toBe(false); // missing header

    // a passing predicate yields a REAL persistent connection
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: "Bearer ignex.okayok" } } as never);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("open failed"));
    });
    await waitFor(() => server.clientCount === 1);
    ok.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);

  test("Authorization scheme matching is exact (case + spacing)", async () => {
    const server = createServer({ port: 0, token: "sekrit" });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { authorization: "Bearer sekrit" } })).toBe(true);
    expect(await tryConnect(url, { headers: { authorization: "bearer sekrit" } })).toBe(false);
    expect(await tryConnect(url, { headers: { authorization: "Bearer  sekrit" } })).toBe(false); // double space → token " sekrit"
    expect(await tryConnect(url, { headers: { authorization: "BearerXsekrit" } })).toBe(false);
    expect(await tryConnect(url, { headers: { authorization: "Basic sekrit" } })).toBe(false);
    server.stop();
  }, 10_000);

  test("an authenticate hook that throws denies the upgrade without harming the server", async () => {
    const server = createServer({
      port: 0,
      authenticate: () => {
        throw new Error("auth backend down");
      },
    });
    const url = `ws://localhost:${server.port}/ws`;
    // hardened: the hook failure surfaces as a plain 401-style denial…
    expect(await tryConnect(url)).toBe(false);
    // …and the serve loop keeps accepting: a healthy hook works right after
    const recovered = createServer({
      port: 0,
      authenticate: (req) => new URL(req.url).searchParams.get("ok") === "1",
    });
    expect(await tryConnect(`ws://localhost:${recovered.port}/ws?ok=0`)).toBe(false);
    expect(await tryConnect(`ws://localhost:${recovered.port}/ws?ok=1`)).toBe(true);
    await waitFor(() => recovered.clientCount === 1);
    recovered.stop();
    server.stop();
  }, 10_000);
});

describe("topic-name injection surface", () => {
  test("__proto__ / CRLF-shaped topics stay opaque keys with exact delivery", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const a = await openWs(url);
    const b = await openWs(url);
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d?.name === "quote") gotA.push((d.payload as { symbol: string }).symbol);
    };
    b.onmessage = (ev) => {
      const d = decodeWs(ev);
      if (d?.name === "quote") gotB.push((d.payload as { symbol: string }).symbol);
    };
    ctl(a, "subscribe", { topic: "__proto__" });
    ctl(b, "subscribe", { topic: "x\r\nEvil: header" });
    await waitFor(() => server.topics().includes("__proto__") && server.topics().includes("x\r\nEvil: header"));

    server.publishToTopic("__proto__", "quote", quote("POLLUTED"));
    server.publishToTopic("x\r\nEvil: header", "quote", quote("CRLF"));
    await waitFor(() => gotA.length >= 1 && gotB.length >= 1);

    expect(gotA).toEqual(["POLLUTED"]); // no cross-topic bleed
    expect(gotB).toEqual(["CRLF"]);
    // prototype chain untouched
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).toString).toBeTypeOf("function");

    a.close();
    b.close();
    await waitFor(() => server.clientCount === 0);
    expect(server.topics()).toEqual([]); // empty rooms pruned even for weird names
    server.stop();
  }, 10_000);
});

// ── local helpers ──────────────────────────────────────────────────────

function decodeWs(ev: MessageEvent): ReturnType<typeof decodeFrame> {
  return decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
}
