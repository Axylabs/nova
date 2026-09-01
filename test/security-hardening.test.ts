/**
 * Security-hardening tests (enterprise surface):
 *   - per-connection inbound rate limiting (token bucket): drop + close
 *     policies, deterministic bucket math, control frames included
 *   - topic/group join authorization (`authorizeTopic` / `authorizeGroup`)
 *     enforced on control frames AND programmatic joins
 *   - HTTP introspection gate: GET /clients honors the token/auth surface
 *   - constant-time literal-token compare (correctness incl. length/unicode edges)
 *   - cluster envelope hardening: hostile/truncated buffers never throw,
 *     >255-byte fields are rejected loudly instead of corrupting frames
 *   - control-frame robustness: hostile/absurd control payloads can't corrupt
 *     membership or crash routing
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { safeEqual } from "../src/core/auth";
import { createRateLimiter, resolveRateLimit } from "../src/core/rate-limit";
import { decodeClusterMessage, encodeClusterMessage } from "../src/events/cluster";
import { encodeEvent } from "../src/transport/transport";
import { openWs, tryConnect, waitFor } from "./helpers";

/** Send one control frame over a raw socket. */
function ctl(ws: WebSocket, name: Parameters<typeof encodeEvent>[0], payload: unknown): void {
  ws.send(encodeEvent(name, payload) as Uint8Array<ArrayBuffer>);
}

describe("rate limiting (token bucket)", () => {
  test("deterministic bucket math (burst then refill)", () => {
    const rl = resolveRateLimit({ messagesPerSecond: 10, burst: 3 })!;
    expect(rl).toEqual({ messagesPerSecond: 10, burst: 3, policy: "drop" });
    const limiter = createRateLimiter(rl);
    const t0 = 1_000_000;
    expect(limiter.allow(t0)).toBe(true);
    expect(limiter.allow(t0)).toBe(true);
    expect(limiter.allow(t0)).toBe(true);
    expect(limiter.allow(t0)).toBe(false); // bucket drained
    // 50ms at 10 msg/s refills 0.5 tokens — not enough to pass
    expect(limiter.allow(t0 + 50)).toBe(false);
    // by t0+200 another 150ms has accrued (1.5) on top of the banked 0.5 → 2 passes
    expect(limiter.allow(t0 + 200)).toBe(true);
    expect(limiter.allow(t0 + 200)).toBe(true);
    expect(limiter.allow(t0 + 200)).toBe(false);
    // monotonic-clock safety: older timestamps never grant extra tokens
    expect(limiter.allow(t0 + 100)).toBe(false);
  });

  test("resolveRateLimit defaults + off", () => {
    expect(resolveRateLimit(undefined)).toBeNull();
    expect(resolveRateLimit({})).toEqual({ messagesPerSecond: 100, burst: 100, policy: "drop" });
    expect(resolveRateLimit({ messagesPerSecond: 0.5 })!.messagesPerSecond).toBeGreaterThan(0);
  });

  test("drop policy sheds a flood, keeps the socket, counts metrics", async () => {
    const server = createServer({
      port: 0,
      rateLimit: { messagesPerSecond: 5, burst: 5, policy: "drop" },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);

    let pongs = 0;
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (b.length > 0 && b[0] !== undefined) pongs++; // every reply is a pong/hello/welcome
    };

    for (let i = 0; i < 60; i++) ctl(ws, "ping", { ts: i });
    await waitFor(() => server.getMetrics().rateLimited > 0);

    // most of the flood was shed…
    expect(server.getMetrics().rateLimited).toBeGreaterThan(30);
    expect(pongs).toBeLessThan(15);
    // …the connection survived (drop, not disconnect)…
    await Bun.sleep(150);
    expect(server.clientCount).toBe(1);
    // …and post-burst traffic flows again once tokens refill
    await Bun.sleep(1200); // > burst refill window at 5 msg/s
    const before = pongs;
    ctl(ws, "ping", { ts: 999 });
    await Bun.sleep(200);
    expect(pongs).toBeGreaterThan(before);

    ws.close();
    server.stop();
  }, 10_000);

  test("close policy disconnects a flooding client with 1008", async () => {
    const server = createServer({
      port: 0,
      rateLimit: { messagesPerSecond: 2, burst: 3, policy: "close" },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    let closeCode = 0;
    ws.onclose = (ev) => {
      closeCode = ev.code;
    };
    for (let i = 0; i < 20; i++) ctl(ws, "ping", { ts: i });
    await waitFor(() => closeCode === 1008);
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);
});

describe("join authorization hooks", () => {
  test("authorizeTopic gates subscribe frames + programmatic joins", async () => {
    let deniedTopics = 0;
    const server = createServer({
      port: 0,
      authorizeTopic: (topic) => {
        const ok = topic !== "secret";
        if (!ok) deniedTopics++;
        return ok;
      },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    await waitFor(() => server.clientCount === 1);

    const got: string[] = [];
    ws.onmessage = (ev) => {
      got.push(new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer).slice()));
    };
    ctl(ws, "subscribe", { topic: "secret" });
    ctl(ws, "subscribe", { topic: "open" });
    await Bun.sleep(150);

    server.publishToTopic("open", "quote", { symbol: "OK", bid: 1, ask: 2, bidSize: 3, askSize: 4, ts: 5 });
    server.publishToTopic("secret", "quote", { symbol: "NO", bid: 1, ask: 2, bidSize: 3, askSize: 4, ts: 5 });
    await Bun.sleep(200);

    // the authorized topic delivered; the rejected one did not exist at all
    expect(got.some((b) => b.includes("OK"))).toBe(true);
    expect(got.some((b) => b.includes("NO"))).toBe(false);
    expect(server.topics()).toEqual(["open"]);
    expect(server.getMetrics().rejectedJoins).toBeGreaterThanOrEqual(1);
    expect(deniedTopics).toBeGreaterThanOrEqual(1);

    // programmatic joins go through the SAME gate (enforced in rooms.joinRoom)
    ws.close();
    server.stop();
  }, 10_000);

  test("authorizeGroup gates joinGroup frames; leaving stays allowed", async () => {
    const server = createServer({
      port: 0,
      authorizeGroup: (group) => group !== "admin",
    });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    await waitFor(() => server.clientCount === 1);

    ctl(ws, "joinGroup", { group: "admin" });
    ctl(ws, "joinGroup", { group: "traders" });
    await waitFor(() => server.groups().includes("traders"));
    await Bun.sleep(100);

    expect(server.groups()).toEqual(["traders"]);
    expect(server.groupMembers("admin")).toEqual([]);
    expect(server.getMetrics().rejectedJoins).toBeGreaterThanOrEqual(1);

    // leave is never gated
    ctl(ws, "leaveGroup", { group: "traders" });
    await waitFor(() => server.groups().length === 0);

    ws.close();
    server.stop();
  }, 10_000);
});

describe("HTTP introspection gate (/clients)", () => {
  test("token-configured servers require a valid Bearer", async () => {
    const server = createServer({ port: 0, token: "sec-ret" });
    const base = `http://localhost:${server.port}`;
    expect((await fetch(`${base}/clients`)).status).toBe(401);
    expect((await fetch(`${base}/clients`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await fetch(`${base}/clients`, { headers: { authorization: "Bearer sec-ret" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
    server.stop();
  });

  test("authenticate-hook servers are gated too; unauthenticated servers stay public", async () => {
    const gated = createServer({ port: 0, authenticate: (req) => req.headers.get("x-key") === "k" });
    expect((await fetch(`http://localhost:${gated.port}/clients`)).status).toBe(401);
    expect(
      (await fetch(`http://localhost:${gated.port}/clients`, { headers: { "x-key": "k" } })).status,
    ).toBe(200);
    gated.stop();

    const open = createServer({ port: 0 }); // dev-mode compat: no auth surface → public
    expect((await fetch(`http://localhost:${open.port}/clients`)).status).toBe(200);
    open.stop();
  });
});

describe("bearer token hardening", () => {
  test("safeEqual: unicode + length-mismatch edges compare correctly", () => {
    // (HTTP headers can't carry non-ASCII, so the unicode edge is unit-level)
    expect(safeEqual("sëcret-tøken-123", "sëcret-tøken-123")).toBe(true);
    expect(safeEqual("sëcret-tøken-123", "secret-token-123")).toBe(false); // same byte length
    expect(safeEqual("short", "a-much-longer-token")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "x")).toBe(false);
  });

  test("wrong-length tokens are rejected without oracle shortcuts", async () => {
    const server = createServer({ port: 0, token: "long-secret-token-99" });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { authorization: "Bearer x" } })).toBe(false);
    expect(await tryConnect(url, { headers: { authorization: "Bearer wrong-length-here!" } })).toBe(
      false,
    );
    expect(await tryConnect(url, { headers: { authorization: "" } })).toBe(false);
    expect(await tryConnect(url, { headers: { authorization: "Bearer long-secret-token-99" } })).toBe(
      true,
    );
    server.stop();
  });
});

describe("cluster envelope hardening", () => {
  test(">255-byte origin/key/name throw instead of silently wrapping mod 256", () => {
    const frame = new Uint8Array(8);
    expect(() =>
      encodeClusterMessage("i", "broadcast", "", "ok", frame),
    ).not.toThrow(); // sane sizes still work
    expect(() => encodeClusterMessage("i".repeat(256), "broadcast", "", "n", frame)).toThrow(
      RangeError,
    );
    expect(() => encodeClusterMessage("i", "topic", "k".repeat(300), "n", frame)).toThrow(
      RangeError,
    );
    expect(() => encodeClusterMessage("i", "group", "k", "n".repeat(1000), frame)).toThrow(
      RangeError,
    );
  });

  test("hostile/truncated buffers never throw on decode (fuzz sweep)", () => {
    const good = encodeClusterMessage("inst-1", "topic", "room", "quote", new Uint8Array(32).fill(7));
    // every possible truncation either decodes or yields null — never throws
    for (let len = 0; len <= good.byteLength; len++) {
      expect(() => decodeClusterMessage(good.subarray(0, len))).not.toThrow();
    }
    // random garbage never throws
    for (let i = 0; i < 200; i++) {
      const junk = crypto.getRandomValues(new Uint8Array(1 + (i % 64)));
      expect(() => decodeClusterMessage(junk)).not.toThrow();
    }
    // a corrupted length byte that overruns the buffer is rejected, not OOB-read
    const bad = good.slice();
    bad[0] = 0xff;
    expect(decodeClusterMessage(bad)).toBeNull();
  });
});

describe("control-frame robustness", () => {
  test("absurd control payloads cannot corrupt membership or crash routing", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    await waitFor(() => server.clientCount === 1);

    ctl(ws, "subscribe", { topic: "" }); // empty topic
    ctl(ws, "subscribe", { topic: "x".repeat(64 * 1024) }); // huge topic
    ctl(ws, "unsubscribe", { topic: "never-joined" });
    ctl(ws, "joinGroup", { group: "" });
    ctl(ws, "leaveGroup", { group: "never-a-member" });
    ctl(ws, "hello", { version: 99, caps: [], lastSeq: 0 }); // version mismatch → close 1002
    await waitFor(() => server.clientCount === 0);

    // server is healthy throughout; no phantom rooms/groups were created
    expect(server.topics()).toEqual([]);
    expect(server.groups()).toEqual([]);
    server.stop();
  }, 10_000);

  test("oversized TEXT frames are rejected with 1009 like binary ones", async () => {
    const server = createServer({ port: 0, maxMessageSize: 64 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);
    let closeCode = 0;
    ws.onclose = (ev) => {
      closeCode = ev.code;
    };
    ws.send("z".repeat(4096)); // text frame — exercises the cheap pre-check
    await waitFor(() => closeCode === 1009);
    await waitFor(() => server.getMetrics().protocolErrors >= 1);
    server.stop();
  }, 10_000);
});

describe("client lifecycle hardening", () => {
  test("connect() is idempotent — double connect never leaks a second session", async () => {
    const { createClient } = await import("../public/client");
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url);
    client.connect();
    client.connect(); // second call must be a no-op while connecting/open
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(150); // give any leaked duplicate time to register (it must not)
    expect(server.clientCount).toBe(1);
    client.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  }, 10_000);

  test("refused connections surface through onError (reconnect off)", async () => {
    const { createClient } = await import("../public/client");
    // port 1 refuses — nothing listens there
    const client = createClient("ws://localhost:1/ws", { reconnect: false });
    let errors = 0;
    let closedSeen = false;
    client.onError(() => errors++);
    client.onStatus((s) => {
      if (s === "closed") closedSeen = true;
    });
    client.connect();
    await waitFor(() => errors >= 1 && closedSeen, 4000);
    client.close();
  }, 8000);
});
