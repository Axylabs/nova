/**
 * Event trace tests — the debugger-facing "what fired" ring:
 *   - every emitted / published / received event is recorded with direction,
 *     name, target + key, and frame size
 *   - the ring wraps at capacity and `recent` returns newest-first rows
 *   - filters (direction / name) and aggregate stats work
 *   - payload capture is OFF by default and opt-in per server
 *   - IGNEX_NOVA_TRACE=0 / trace.enabled=false disable recording entirely
 *   - dispatch stays allocation-disciplined: registry mutation during a
 *     dispatch cannot corrupt the in-flight iteration (copy-on-write)
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { createClient } from "../public/client";
import { emit, unbindEvents } from "../public/events";
import { createHandlerRegistry } from "../src/events/registry";
import { createEventTrace } from "../src/events/trace";
import { quote, waitFor } from "./helpers";

async function connectClient(url: string) {
  const c = createClient(url);
  c.connect();
  await waitFor(() => c.clientId !== "");
  return c;
}

describe("event trace — unit", () => {
  test("records rows with direction/name/target/key/bytes and reads newest-first", () => {
    const t = createEventTrace({ capacity: 8 });
    t.record("out.emit", "quote", "user", "u-1", 42);
    t.record("in.client", "trade", undefined, "c-9", 24);
    t.record("out.publish", "quote", "broadcast", undefined, 40);

    const rows = t.recent();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.direction).toBe("out.publish");
    expect(rows[0]?.target).toBe("broadcast");
    expect(rows[2]?.direction).toBe("out.emit");
    expect(rows[2]?.key).toBe("u-1");
    expect(rows[2]?.bytes).toBe(42);
    // seq ordering is monotonic across wrap
    expect(rows[0]!.seq > rows[1]!.seq && rows[1]!.seq > rows[2]!.seq).toBe(true);
  });

  test("wraps at capacity; stats reflect the retained window + totals", () => {
    const cap = 4;
    const t = createEventTrace({ capacity: cap });
    for (let i = 0; i < 10; i++) t.record("out.emit", "quote", "broadcast", undefined, i);
    expect(t.recent()).toHaveLength(cap);
    // newest-first: last written record first
    expect(t.recent()[0]?.bytes).toBe(9);
    const s = t.stats();
    expect(s.size).toBe(cap);
    expect(s.total).toBe(10);
    expect(s.outCount).toBe(cap);
    expect(s.inCount).toBe(0);
    expect(s.bytes).toBe(6 + 7 + 8 + 9);
    expect(s.byName.quote).toBe(cap);
    expect(s.last?.name).toBe("quote");
  });

  test("filters by direction and name", () => {
    const t = createEventTrace({ capacity: 16 });
    t.record("out.emit", "quote", "broadcast", undefined, 10);
    t.record("in.client", "quote", undefined, "c-1", 10);
    t.record("in.client", "trade", undefined, "c-1", 12);
    t.record("in.remote", "order", undefined, undefined, 30);

    expect(t.recent({ direction: "in.client" })).toHaveLength(2);
    expect(t.recent({ name: "quote" })).toHaveLength(2);
    expect(t.recent({ direction: "in.client", name: "trade" })).toHaveLength(1);
    expect(t.recent({ direction: "in.remote" })[0]?.name).toBe("order");
  });

  test("payload capture is opt-in", () => {
    const off = createEventTrace({});
    expect(off.captures).toBe(false);
    off.record("out.emit", "quote", "broadcast", undefined, 10, "SHOULD-NOT-STORE");
    expect(off.recent()[0]?.payload).toBeUndefined();

    const on = createEventTrace({ capturePayloadChars: 64 });
    expect(on.captures).toBe(true);
    on.record("out.emit", "quote", "broadcast", undefined, 10, '{"symbol":"AAPL"}');
    expect(on.recent()[0]?.payload).toBe('{"symbol":"AAPL"}');
  });

  test("disabled traces record nothing but keep their surface", () => {
    const t = createEventTrace({ enabled: false });
    t.record("out.emit", "quote", "broadcast", undefined, 10);
    expect(t.recent()).toEqual([]);
    const s = t.stats();
    expect(s.enabled).toBe(false);
    expect(s.size).toBe(0);
  });

  test("clear() drops retained rows (totals survive)", () => {
    const t = createEventTrace({ capacity: 4 });
    t.record("out.emit", "quote", "broadcast", undefined, 5);
    t.clear();
    expect(t.recent()).toHaveLength(0);
    expect(t.stats().total).toBe(1);
  });
});

describe("event trace — server integration", () => {
  test("publish* paths record out.publish rows with targets", () => {
    const server = createServer({ port: 0 });
    server.publish("quote", quote());
    server.publishToTopic("room-1", "quote", quote());
    server.publishToGroup("vip", "quote", quote());
    server.publishToClient("nope", "quote", quote()); // offline → no row

    const rows = server.getEventTrace().recent;
    // newest-first: group was published last
    expect(rows.map((r) => r.target)).toEqual(["group", "topic", "broadcast"]);
    expect(rows[0]?.key).toBe("vip");
    expect(rows[1]?.key).toBe("room-1");
    expect(server.getEventTrace().stats.byName.quote).toBe(3);
    server.stop();
  });

  test("client-sent events are recorded as in.client rows", async () => {
    const server = createServer({ port: 0, inbound: ["trade"] });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    c.send("trade", { symbol: "MSFT", price: 1, volume: 1, side: "buy", ts: 2 });
    await waitFor(() =>
      server.getEventTrace().recent.some((r) => r.direction === "in.client"),
    );
    const row = server.getEventTrace().recent.find((r) => r.direction === "in.client");
    expect(row?.name).toBe("trade");
    expect(row?.key).toBe(c.clientId);
    expect((row?.bytes ?? 0)).toBeGreaterThan(0);
    c.close();
    server.stop();
  });

  test("events-layer emits are recorded as out.emit rows", async () => {
    unbindEvents();
    const server = createServer({ port: 0, events: {} });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    // targeted user emit through the bound global singleton
    emit("quote", quote("T1"), { type: "user", userId: "u-77" });
    await waitFor(() => server.getEventTrace().recent.some((r) => r.direction === "out.emit"));
    const row = server.getEventTrace().recent.find((r) => r.direction === "out.emit");
    expect(row?.name).toBe("quote");
    expect(row?.target).toBe("user");
    expect(row?.key).toBe("u-77");
    c.close();
    server.stop();
  });

  test("trace can be disabled per server and via clearEventTrace()", () => {
    const off = createServer({ port: 0, trace: { enabled: false } });
    off.publish("quote", quote());
    expect(off.getEventTrace().enabled).toBe(false);
    expect(off.getEventTrace().recent).toHaveLength(0);
    off.stop();

    const on = createServer({ port: 0 });
    on.publish("quote", quote());
    expect(on.getEventTrace().recent).toHaveLength(1);
    on.clearEventTrace();
    expect(on.getEventTrace().recent).toHaveLength(0);
    expect(on.getEventTrace().stats.total).toBe(1); // totals survive clear
    on.stop();
  });
});

describe("handler registry — copy-on-write dispatch", () => {
  test("subscribing during dispatch does not invoke the new handler mid-flight", () => {
    const reg = createHandlerRegistry();
    const seen: string[] = [];
    reg.on("evt", () => {
      seen.push("first");
      // mutate DURING iteration: must not affect this dispatch
      reg.on("evt", () => {
        seen.push("added-mid-flight");
      });
    });
    reg.dispatch("evt", undefined, undefined);
    expect(seen).toEqual(["first"]);
    // second dispatch: "first" runs (and re-adds — COW keeps this dispatch on
    // the old snapshot), then the handler added during dispatch #1 runs.
    reg.dispatch("evt", undefined, undefined);
    expect(seen).toEqual(["first", "first", "added-mid-flight"]);
  });

  test("off/once semantics survive the COW refactor", () => {
    const reg = createHandlerRegistry();
    let n = 0;
    const h = (): void => {
      n++;
    };
    reg.on("e", h);
    reg.once("e", () => {
      n += 10;
    });
    reg.dispatch("e", undefined, undefined);
    expect(n).toBe(11); // once fired exactly once
    reg.off("e", h);
    reg.dispatch("e", undefined, undefined);
    expect(n).toBe(11); // plain handler removed
    expect(reg.count("e")).toBe(0);
  });

  test("error isolation still counts failures without breaking other handlers", async () => {
    const reg = createHandlerRegistry();
    const errors: string[] = [];
    reg.onError((err, name) => errors.push(`${name}:${err.message}`));
    reg.on("e", () => {
      throw new Error("boom");
    });
    let ok = 0;
    reg.on("e", () => {
      ok++;
    });
    reg.dispatch("e", undefined, undefined);
    await Bun.sleep(10);
    expect(ok).toBe(1);
    expect(errors).toEqual(["e:boom"]);
    expect(reg.errorCount).toBe(1);
  });
});
