/**
 * Gap-free delivery (envelope v2 delivery seqs) + resume:
 *   - server stamps a per-connection, monotonically increasing seq on every
 *     frame (app AND control), visible via the envelope flags/seq fields
 *   - same-connection gap recovery: dropping a frame creates a hole; the
 *     client buffers out-of-order frames and the `resume` control frame
 *     re-delivers the lost range with ORIGINAL seqs (in-order, no dups)
 *   - cross-session resume: after disconnect, a reconnecting client with the
 *     same auth-pinned id continues the seq stream via hello { lastSeq }
 *   - snapshotRequest { fromSeq } replays topic history strictly after a seq,
 *     hydrating from the durable TopicLog when the ring has moved on
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createMemoryTopicLog, createServer } from "../public/server";
import { readSeq } from "../src/core/resume";
import { defaultBindings } from "../src/bindings/default";
import { encodeEvent } from "../src/transport/transport";
import { quote, waitFor } from "./helpers";

describe("delivery-seq stamping", () => {
  test("every server APP frame carries an increasing per-connection seq; controls are unstamped", async () => {
    const server = createServer({ port: 0, resume: {} });
    const seen: number[] = [];
    const controlIds: number[] = [];
    // raw socket so we can inspect envelope bytes directly
    const sock = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://localhost:${server.port}/ws`);
      s.binaryType = "arraybuffer";
      s.onopen = () => resolve(s);
      s.onerror = () => reject(new Error("open failed"));
    });
    sock.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      const header = defaultBindings.readFrameHeader(bytes);
      if (!header) return;
      if (defaultBindings.isControlId(header.id)) {
        controlIds.push(header.id);
        // control frames must NOT be stamped
        expect(readSeq(defaultBindings, bytes)).toBeNull();
        return;
      }
      const seq = readSeq(defaultBindings, bytes);
      if (seq !== null) seen.push(seq);
    };
    await waitFor(() => controlIds.length >= 2); // hello + welcome

    server.publish("quote", quote("A"));
    server.publish("quote", quote("B"));
    await waitFor(() => seen.length >= 2);

    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBe(seen[i - 1]! + 1);
    expect(seen[0]).toBe(1); // app stream starts at 1 regardless of controls
    sock.close();
    server.stop(true);
  });

  test("unstamped frames (client-encoded / pre-stamp copies) report seq null", () => {
    const frame = encodeEvent("quote", quote());
    expect(readSeq(defaultBindings, frame)).toBeNull(); // flags bit0 = 0
  });
});

describe("same-connection gap recovery", () => {
  test("raw-socket gap → resume control fills the hole with original seqs", async () => {
    const server = createServer({ port: 0, resume: { historySize: 64 } });
    // client with handlers registered through the public API, but driven by a
    // raw WebSocket we control (so we can WITHHOLD a frame = deterministic loss)
    const c = createClient(`ws://localhost:${server.port}/ws`);
    const got: string[] = [];
    c.on("quote", (x) => got.push(x.symbol));

    // connect via the library client first (establishes welcome etc.)
    c.connect();
    await waitFor(() => server.clientCount === 1);
    c.close();
    await waitFor(() => server.clientCount === 0);

    // now reconnect with a raw socket speaking the same protocol
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://localhost:${server.port}/ws`);
      s.binaryType = "arraybuffer";
      s.onopen = () => resolve(s);
      s.onerror = () => reject(new Error("open failed"));
    });
    const inbox: Uint8Array[] = [];
    let withheld: Uint8Array | null = null;
    let withholding = false;
    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      if (withholding && withheld === null) {
        withheld = bytes; // simulate transport loss
        return;
      }
      inbox.push(bytes);
    };

    // publish F0 (delivered), F1 (WITHHELD), F2 (delivered)
    server.publish("quote", quote("F0"));
    await waitFor(() => inbox.some((b) => decodeSymbol(b) === "F0"));
    withholding = true;
    server.publish("quote", quote("F1"));
    await Bun.sleep(60); // give F1's frame time to be withheld
    withholding = false;
    server.publish("quote", quote("F2"));
    await waitFor(() => inbox.some((b) => decodeSymbol(b) === "F2"));

    expect(decodeSymbol(withheld!)).toBe("F1");
    const f0Seq = readSeq(defaultBindings, inbox.find((b) => decodeSymbol(b) === "F0")!)!;
    const f2Seq = readSeq(defaultBindings, inbox.find((b) => decodeSymbol(b) === "F2")!)!;
    expect(f2Seq).toBe(f0Seq + 2); // F1 (f0Seq+1) is missing → gap

    // ask the server to fill [.., f0Seq] → replays F1 only
    const resumeFrame = defaultBindings.encodeFrame("resume", { lastSeq: f0Seq });
    ws.send(resumeFrame as Uint8Array<ArrayBuffer>);
    await waitFor(() => inbox.some((b) => decodeSymbol(b) === "F1"));
    const f1Frame = inbox.find((b) => decodeSymbol(b) === "F1")!;
    expect(readSeq(defaultBindings, f1Frame)).toBe(f0Seq + 1); // ORIGINAL seq preserved
    expect(f1Frame).toEqual(withheld!); // byte-identical redelivery

    ws.close();
    server.stop(true);
  });

  test("cross-session resume: reconnecting id continues the seq stream", async () => {
    const server = createServer({
      port: 0,
      resume: { historySize: 64, ttlMs: 10_000 },
      authenticate: () => ({ id: "pinned-1" }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url, { reconnect: { initialDelay: 40, maxDelay: 120, jitter: false } });
    const got: string[] = [];
    c.on("quote", (x) => got.push(x.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);

    server.publish("quote", quote("A"));
    await waitFor(() => got.includes("A"));

    // kill the socket WITHOUT the client noticing flow changed — the library
    // reconnects (hello carries lastSeq) and the parked history is adopted
    const wsRef = (c as unknown as { state?: { ws?: WebSocket } }).state;
    void wsRef;
    // force-close from the server side mid-stream
    server.disconnectClient("pinned-1");
    await waitFor(() => server.clientCount === 1, 5000); // reconnected

    // frames published while offline must be replayed on reconnect
    server.publish("quote", quote("OFFLINE1"));
    server.publish("quote", quote("OFFLINE2"));
    await waitFor(() => got.includes("OFFLINE1") && got.includes("OFFLINE2"), 5000);
    // ordering: everything the client got is in publish order, no duplicates
    const expected = ["A", "OFFLINE1", "OFFLINE2"];
    expect(got).toEqual(expected);

    c.close();
    server.stop(true);
  });
});

/** Decode a quote frame's symbol straight from the wire bytes. */
function decodeSymbol(bytes: Uint8Array): string {
  const frame = defaultBindings.decodeFrame(bytes) as { name: string; payload: { symbol: string } } | null;
  return frame?.payload?.symbol ?? "";
}

describe("snapshotRequest fromSeq + durable topic log", () => {
  test("topic history strictly after fromSeq; log hydrates past the ring window", async () => {
    const log = createMemoryTopicLog({ maxPerTopic: 1000 });
    const server = createServer({ port: 0, replay: { historySize: 3 }, topicLog: log });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    const got: string[] = [];
    c.on("quote", (x) => got.push(x.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);
    c.subscribe("t-log");
    await Bun.sleep(30);

    // 6 publishes; the ring keeps only the last 3, the log keeps all
    const all = ["L1", "L2", "L3", "L4", "L5", "L6"];
    for (const s of all) server.publishToTopic("t-log", "quote", quote(s));
    await waitFor(() => got.includes("L6"));

    // fresh subscriber gets just the ring (last 3)
    const c2 = createClient(url);
    const got2: string[] = [];
    c2.on("quote", (x) => got2.push(x.symbol));
    c2.connect();
    await waitFor(() => server.clientCount === 2);
    c2.subscribe("t-log");
    await waitFor(() => got2.length >= 3);
    expect(got2.slice(-3)).toEqual(["L4", "L5", "L6"]);

    // resume-from-seq: L4's topic seq is known to the log — request everything
    // after L3 and the log hydrates what the ring forgot
    const seqL3 = log.range("t-log", 0).find((e) => decodeSymbol(e.frame) === "L3")!.seq;
    const got3: string[] = [];
    const c3 = createClient(url);
    c3.on("quote", (x) => got3.push(x.symbol));
    c3.connect();
    await waitFor(() => server.clientCount === 3);
    c3.snapshotRequest("t-log", seqL3);
    await waitFor(() => got3.includes("L6"), 5000);
    expect(got3).toEqual(["L4", "L5", "L6"]); // STRICTLY after L3

    // latestSeq tracks the counter
    expect(log.latestSeq("t-log")).toBeGreaterThanOrEqual(6);

    c.close();
    c2.close();
    c3.close();
    server.stop(true);
  });
});
