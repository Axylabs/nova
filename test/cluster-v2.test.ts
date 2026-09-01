/**
 * Cluster v2 + events-layer reliability:
 *   - envelope v2: version byte, msgId, trace id round-trip; legacy envelopes rejected
 *   - ROUTED targeted delivery: emitToClient/emitToUser reach ONLY the owning
 *     instance (clusterRouted metric), not the full mesh
 *   - broker-redelivery dedupe window (same msgId delivered twice → dropped)
 *   - trace-id propagation into remote server-event contexts
 *   - handler retry with backoff + dead-letter sink
 *   - scheduled emits + cancel
 *   - cross-instance rpc (hub.call / hub.onMethod) over a shared bus
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import type { ClusterTransport } from "../public/events";
import {
  CLUSTER_ENV_VERSION,
  decodeClusterMessage,
  encodeClusterMessage,
} from "../src/events/cluster";
import { createClusterRpc } from "../src/events/cluster-rpc";
import { defaultBindings } from "../src/bindings/default";
import { quote, waitFor } from "./helpers";

/** In-memory cluster bus that RECORDS subjects so tests can assert routing. */
class RecordingBus implements ClusterTransport {
  connected = true;
  readonly published: string[] = [];
  private subs = new Map<string, Set<(d: Uint8Array) => void>>();
  publish(subject: string, data: Uint8Array): void {
    this.published.push(subject);
    const copy = new Uint8Array(data);
    queueMicrotask(() => {
      for (const [pattern, cbs] of this.subs) {
        const match = pattern.endsWith(".>")
          ? subject.startsWith(pattern.slice(0, -1))
          : pattern === subject;
        if (match) for (const cb of cbs) cb(copy);
      }
    });
  }
  subscribe(subject: string, cb: (d: Uint8Array) => void): () => void {
    let set = this.subs.get(subject);
    if (!set) {
      set = new Set();
      this.subs.set(subject, set);
    }
    set.add(cb);
    return () => {
      const s = this.subs.get(subject);
      if (s) s.delete(cb);
    };
  }
  async close(): Promise<void> {}
}

describe("cluster envelope v2", () => {
  test("round-trips origin/kind/key/name/msgId/traceId/frame", () => {
    const frame = new Uint8Array([9, 9, 9]);
    const bytes = encodeClusterMessage("inst-1", "client", "c-42", "quote", frame, "msg-1", "trace-1");
    expect(bytes[0]).toBe(CLUSTER_ENV_VERSION);
    const env = decodeClusterMessage(bytes);
    expect(env).not.toBeNull();
    expect(env!.origin).toBe("inst-1");
    expect(env!.kind).toBe("client");
    expect(env!.key).toBe("c-42");
    expect(env!.name).toBe("quote");
    expect(env!.msgId).toBe("msg-1");
    expect(env!.traceId).toBe("trace-1");
    expect([...env!.frame]).toEqual([9, 9, 9]);
  });

  test("legacy (v1) envelopes are rejected as errors, never misparsed", () => {
    // v1 layout: no leading version byte — first byte is originLen
    const legacy = new Uint8Array([7, 105, 110, 115, 116, 45, 49, 255]);
    expect(decodeClusterMessage(legacy)).toBeNull();
  });

  test("oversized fields fail loudly instead of corrupting peers", () => {
    expect(() =>
      encodeClusterMessage("x".repeat(300), "broadcast", "", "", new Uint8Array(0)),
    ).toThrow(RangeError);
  });
});

describe("routed targeted delivery", () => {
  test("emitToClient reaches only the owning instance's subject", async () => {
    const bus = new RecordingBus();
    const mkEvents = () => ({
      cluster: { prefix: "t", transport: bus, heartbeatMs: 1000, presenceTtlMs: 8000 },
      global: false,
    });
    const s1 = createServer({ port: 0, events: mkEvents() });
    const s2 = createServer({ port: 0, events: mkEvents() });

    const c2 = createClient(`ws://localhost:${s2.port}/ws`);
    const got: string[] = [];
    c2.on("quote", (x) => got.push(x.symbol));
    c2.connect();
    await waitFor(() => s2.clientCount === 1);
    // wait for presence to propagate so routing has an owner for c2
    await waitFor(() => s1.events!.clusterClients().some((r) => r.clientId === c2.clientId));

    bus.published.length = 0;
    s1.events!.emitToClient(c2.clientId, "quote", quote("ROUTED"));
    await waitFor(() => got.includes("ROUTED"));

    // every routed publish went to s2's per-instance subject — full mesh untouched
    expect(bus.published.length).toBeGreaterThan(0);
    for (const subject of bus.published) {
      expect(subject.startsWith("t.cluster.instance.")).toBe(true);
      expect(subject.endsWith(s2.events!.instanceId)).toBe(true);
    }
    expect(s1.getMetrics().events?.clusterRouted).toBeGreaterThan(0);

    c2.close();
    s1.stop(true);
    s2.stop(true);
  });

  test("unknown client falls back to the full mesh", async () => {
    const bus = new RecordingBus();
    const s1 = createServer({
      port: 0,
      events: {
        cluster: { prefix: "t", transport: bus },
        global: false,
      },
    });
    // no presence knowledge at all → wildcard subject
    s1.events!.emitToClient("nobody", "quote", quote("FALLBACK"));
    await Bun.sleep(30);
    expect(bus.published.some((s) => s.startsWith("t.cluster.client."))).toBe(true);
    s1.stop(true);
  });
});

describe("broker redelivery dedupe", () => {
  test("a replayed msgId is delivered once", async () => {
    const bus = new RecordingBus();
    const s1 = createServer({ port: 0, events: { cluster: { prefix: "t", transport: bus }, global: false } });
    const s2 = createServer({ port: 0, events: { cluster: { prefix: "t", transport: bus }, global: false } });
    const got: string[] = [];
    const c2 = createClient(`ws://localhost:${s2.port}/ws`);
    c2.on("quote", (x) => got.push(x.symbol));
    c2.connect();
    await waitFor(() => s2.clientCount === 1);

    s1.events!.emit("quote", quote("DUPE"));
    await waitFor(() => got.includes("DUPE"));

    // broker redelivers the exact same envelope: same msgId, same subject.
    const envBytes = encodeClusterMessage(
      "ext-inst",
      "broadcast",
      "",
      "quote",
      encodeQuoteFrame("TWICE"),
      "fixed-msg-id",
      "",
    );
    bus.publish("t.cluster.broadcast.quote", envBytes);
    await Bun.sleep(40);
    bus.publish("t.cluster.broadcast.quote", envBytes); // SAME msgId
    await Bun.sleep(80);

    const hits = got.filter((s) => s === "TWICE");
    expect(hits.length).toBe(1);
    expect(s2.getMetrics().events?.clusterDroppedDupe).toBeGreaterThanOrEqual(1);

    c2.close();
    s1.stop(true);
    s2.stop(true);
  });
});

/** Minimal pure-JS encode through the default bindings. */
function encodeQuoteFrame(symbol: string): Uint8Array {
  return defaultBindings.encodeFrame("quote", quote(symbol));
}

describe("trace-id propagation", () => {
  test("remote server-event handlers see the producer's trace id in ctx", async () => {
    const bus = new RecordingBus();
    const s1 = createServer({ port: 0, events: { cluster: { prefix: "t", transport: bus }, global: false } });
    const s2 = createServer({ port: 0, events: { cluster: { prefix: "t", transport: bus }, global: false } });

    const traces: string[] = [];
    s2.events!.onServerEvent("quote", (_p, ctx) => {
      traces.push(ctx.traceId ?? "");
    });
    // hand-craft a remote frame carrying a known trace id
    const envBytes = encodeClusterMessage(
      "producer-1",
      "broadcast",
      "",
      "quote",
      encodeQuoteFrame("TRACED"),
      "msg-trace",
      "trace-abc",
    );
    bus.publish("t.cluster.broadcast.quote", envBytes);
    await waitFor(() => traces.length === 1);
    expect(traces[0]).toBe("trace-abc");

    s1.stop(true);
    s2.stop(true);
  });
});

describe("handler reliability (retry + DLQ)", () => {
  test("failing handler retries then dead-letters", async () => {
    const dead: Array<{ name: string; attempts: number }> = [];
    let calls = 0;
    const s = createServer({
      port: 0,
      events: {
        global: false,
        handlers: { retries: 2, backoffMs: 10, dlq: (info) => dead.push({ name: info.name, attempts: info.attempts }) },
      },
    });
    s.events!.on("quote", () => {
      calls++;
      throw new Error("boom");
    });

    // drive the reliability layer directly through a client event
    const c = createClient(`ws://localhost:${s.port}/ws`, {});
    c.connect();
    await waitFor(() => s.clientCount === 1);
    s.allowInbound("quote");
    c.send("quote" as never, quote("FAIL") as never);
    await waitFor(() => dead.length === 1, 5000);

    expect(calls).toBe(3); // 1 try + 2 retries
    expect(dead[0]).toEqual({ name: "quote", attempts: 3 });
    expect(s.getMetrics().events?.handlerRetries).toBe(2);
    expect(s.getMetrics().events?.dlqCount).toBe(1);

    c.close();
    s.stop(true);
  });

  test("transient failure recovers within the retry budget (no DLQ)", async () => {
    let calls = 0;
    const s = createServer({
      port: 0,
      events: { global: false, handlers: { retries: 3, backoffMs: 5 } },
    });
    s.events!.on("quote", () => {
      calls++;
      if (calls === 1) throw new Error("first attempt fails"); // fails exactly once
    });

    const c = createClient(`ws://localhost:${s.port}/ws`);
    c.connect();
    await waitFor(() => s.clientCount === 1);
    s.allowInbound("quote");
    c.send("quote" as never, quote("RETRY") as never);
    await Bun.sleep(120); // let all retries settle
    expect(calls).toBe(2);
    expect(s.getMetrics().events?.dlqCount).toBe(0);
    expect(s.getMetrics().events?.handlerRetries).toBe(1);

    c.close();
    s.stop(true);
  });
});

describe("scheduled emits", () => {
  test("fires after delay with target; cancel prevents firing", async () => {
    const s = createServer({ port: 0, events: { global: false } });
    const got: string[] = [];
    const c = createClient(`ws://localhost:${s.port}/ws`);
    c.on("quote", (x) => got.push(x.symbol));
    c.connect();
    await waitFor(() => s.clientCount === 1);

    const id1 = s.events!.schedule("quote", quote("LATER"), undefined, 60);
    const id2 = s.events!.schedule("quote", quote("CANCELLED"), undefined, 5000);
    expect(s.events!.scheduledCount).toBe(2);
    expect(s.events!.cancelScheduled(id2)).toBe(true);
    expect(s.events!.scheduledCount).toBe(1);
    expect(s.events!.cancelScheduled(id2)).toBe(false); // already cancelled

    await waitFor(() => got.includes("LATER"), 3000);
    expect(got).toEqual(["LATER"]);
    expect(id1).not.toBe("");
    void id1;

    // targeted scheduling works too
    const idT = s.events!.schedule("quote", quote("TOGROUP"), { type: "group", group: "g" }, 20);
    await waitFor(() => got.includes("TOGROUP") || s.events!.scheduledCount === 0, 2000);
    void idT;

    c.close();
    s.stop(true);
  });
});

describe("cross-instance rpc", () => {
  test("hub.call ⇄ hub.onMethod over a shared bus", async () => {
    const bus = new RecordingBus();
    const mkEvents = () => ({ cluster: { prefix: "t", transport: bus }, global: false });
    const s1 = createServer({ port: 0, events: mkEvents() });
    const s2 = createServer({ port: 0, events: mkEvents() });
    await Bun.sleep(50);

    s2.events!.onMethod("peer.info", () => ({
      instanceId: s2.events!.instanceId,
      clients: s2.clientCount,
    }));
    s2.events!.onMethod("peer.fail", () => {
      throw new Error("nope");
    });

    // targeted call
    const s1Events = s1.events!;
    const s2InstanceId = s2.events!.instanceId;
    const res = await s1Events.call("peer.info", {}, { instanceId: s2InstanceId });
    expect((res as { instanceId: string }).instanceId).toBe(s2InstanceId);

    // error propagation
    await s1Events.call("peer.fail").then(
      () => expect.unreachable(),
      (err: Error) => expect(err.message).toContain("nope"),
    );

    // timeout against a silent method
    await s1Events
      .call("peer.silent", {}, { instanceId: s2InstanceId, timeoutMs: 100 })
      .then(
        () => expect.unreachable(),
        (err: Error) => expect(err.message).toContain("timed out"),
      );

    expect(s1.getMetrics().events!.rpcSent).toBeGreaterThanOrEqual(3);

    s1.stop(true);
    s2.stop(true);
  });

  test("createClusterRpc: first response wins on .any fan-in", async () => {
    const bus = new RecordingBus();
    const a = createClusterRpc({ instanceId: "A", prefix: "t", transport: bus });
    const b1 = createClusterRpc({ instanceId: "B1", prefix: "t", transport: bus });
    const b2 = createClusterRpc({ instanceId: "B2", prefix: "t", transport: bus });
    b1.on("whoami", () => "b1");
    b2.on("whoami", () => "b2");

    const res = (await a.call("whoami")) as string;
    expect(["b1", "b2"]).toContain(res);
    a.close();
    b1.close();
    b2.close();
  });
});
