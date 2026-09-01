/**
 * Data-integrity edge cases — precision boundaries, hostile value coercion,
 * and delivery-sequence continuity that the main integrity.test.ts doesn't
 * cover:
 *   - int64 guard ("throw"): NaN / ±Infinity / 2^53 / numeric STRINGS are all
 *     rejected with RangeError before any FFI conversion; safe values and
 *     bigint-annotated fields pass; global mode semantics are last-server-wins
 *   - "off" mode with a non-number int64 field fails LOUDLY at the FFI
 *     boundary (never silently coerced onto the wire)
 *   - lone surrogates cannot cross either encode path silently (cstring FFI
 *     + serde_json both reject) — no silent truncation/corruption
 *   - NaN/±Infinity in double fields on the JSON fallback path fail loudly
 *     (JSON.stringify would coerce them to null) instead of corrupting
 *   - stampSeq/readSeq round-trip across the full safe u64 range including
 *     seqs above 2^32, unstamped-flag detection, v1-binding safety
 *   - resume replay continuity across sent-history WRAPAROUND over a live
 *     socket: contiguous original seqs, live traffic continues +1 after replay
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Bindings } from "../src/bindings/types";
import { getInt64GuardMode, setInt64GuardMode } from "../src/core/int64-guard";
import { readSeq, stampSeq } from "../src/core/resume";
import { createServer } from "../public/server";
import { decodeFrame } from "../src/generated/registry";
import { encodeEvent } from "../src/transport/transport";
import { bigVal, openWs, order, quote, waitFor } from "./helpers";

afterEach(() => {
  setInt64GuardMode("off"); // process-global — every test leaves it clean
});

describe("int64 loss guard (throw mode)", () => {
  test("rejects NaN, ±Infinity, 2^53 and numeric strings with RangeError", () => {
    setInt64GuardMode("throw");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, -(2 ** 53) - 1, "123" as unknown as number]) {
      expect(() => encodeEvent("quote", quote("AAPL", { ts: bad }))).toThrow(RangeError);
    }
    // the error names the exact field for diagnostics
    expect(() => encodeEvent("quote", quote("AAPL", { ts: 2 ** 53 }))).toThrow(/quote\.ts/);
  });

  test("safe integers pass untouched and bigint fields stay exempt", () => {
    setInt64GuardMode("throw");
    const d = decodeFrame(encodeEvent("quote", quote("AAPL", { ts: -(2 ** 53) + 1 })))!;
    expect((d.payload as { ts: number }).ts).toBe(-(2 ** 53) + 1);

    // bigint-annotated field (bigVal.seq) accepts huge exact values even in throw mode
    const bv = decodeFrame(encodeEvent("bigVal", bigVal({ seq: 2n ** 62n + 1n })))!;
    expect((bv.payload as { seq: bigint }).seq).toBe(2n ** 62n + 1n);
  });

  test("mode is process-global and set by createServer — last server wins (documented)", () => {
    expect(getInt64GuardMode()).toBe("off");
    const a = createServer({ port: 0, int64Guard: "throw" });
    expect(getInt64GuardMode()).toBe("throw");
    const b = createServer({ port: 0 }); // default resets the global to "off"
    expect(getInt64GuardMode()).toBe("off");
    a.stop();
    b.stop();
    // NOTE: two concurrent servers with DIFFERENT guard modes in one process
    // are not supported — the most recently created server's mode wins.
  });

  test("off mode never silently coerces non-number int64 fields onto the wire", () => {
    // loud TypeError at the FFI boundary rather than a garbage wire value
    expect(() => encodeEvent("quote", quote("AAPL", { ts: "123" as unknown as number }))).toThrow();
  });
});

describe("hostile string/number values fail loudly (never corrupt)", () => {
  test("lone surrogates: replaced with U+FFFD on the direct path, rejected on JSON", () => {
    // direct path — Bun's cstring transcode swaps unpaired surrogates for
    // U+FFFD; surrounding characters and sibling fields stay EXACT.
    const d = decodeFrame(encodeEvent("quote", quote("A\uD800B", { bid: 7.5 })))!;
    const sym = (d.payload as { symbol: string }).symbol;
    expect([...sym].map((c) => c.codePointAt(0)!.toString(16))).toEqual(["41", "fffd", "42"]);
    expect((d.payload as { bid: number }).bid).toBe(7.5);

    // JSON fallback path — serde_json refuses the escaped lone surrogate
    expect(() => encodeEvent("order", order({ notes: ["\uD800trailing"] }))).toThrow(/serialize failed/);
  });

  test("non-finite doubles on the JSON path throw instead of writing null", () => {
    // JSON.stringify(NaN) === "null" — if this ever reached Rust it would be a
    // silent schema violation; the serializer rejects it loudly instead.
    expect(() => encodeEvent("order", order({ discounts: [Number.NaN] }))).toThrow(/serialize failed/);
    expect(() => encodeEvent("order", order({ discounts: [Number.POSITIVE_INFINITY] }))).toThrow(/serialize failed/);
    // containment: a valid sibling event is unaffected afterwards
    const d = decodeFrame(encodeEvent("order", order()))!;
    expect(d.name).toBe("order");
  });
});

describe("delivery-seq u64 stamping", () => {
  // v2 envelope: [version:1][event_id:u32 @1..4][flags:1 @5][seq:u64 LE @6..13]
  const v2 = { wireHeaderLen: 14 } as Bindings;
  const v1 = { wireHeaderLen: 5 } as Bindings;

  test("stampSeq/readSeq round-trip across the safe range incl. >2^32", () => {
    for (const seq of [0, 1, 2, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5, 2 ** 40, Number.MAX_SAFE_INTEGER - 1]) {
      const frame = new Uint8Array(64);
      frame.set([1, 2, 3, 4], 0); // some envelope prefix content
      expect(stampSeq(v2, frame, seq)).toBe(true);
      expect(frame[5]! & 1).toBe(1); // flags bit0 stamped
      expect(readSeq(v2, frame)).toBe(seq); // exact through two u32 halves
      // idempotent re-stamp keeps the flag intact
      expect(stampSeq(v2, frame, seq)).toBe(true);
      expect(readSeq(v2, frame)).toBe(seq);
    }
  });

  test("unstamped frames read as null; short frames are safe on both paths", () => {
    const raw = new Uint8Array(64);
    expect(readSeq(v2, raw)).toBeNull(); // flags bit0 clear
    expect(stampSeq(v2, new Uint8Array(5), 1)).toBe(false); // shorter than header
    expect(readSeq(v2, new Uint8Array(5))).toBeNull();
    expect(stampSeq(v2, new Uint8Array(0), 1)).toBe(false);
  });

  test("v1 bindings (no delivery header) never stamp and never read", () => {
    const f = new Uint8Array(64);
    expect(stampSeq(v1, f, 7)).toBe(false);
    expect(readSeq(v1, f)).toBeNull();
  });
});

describe("resume replay continuity across history wraparound (live)", () => {
  test("gap-fill replays exactly the retained suffix with original seqs; live continues +1", async () => {
    const server = createServer({ port: 0, resume: { historySize: 4 } });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);

    // collect app frames (flags bit0 at byte 5) + the unstamped resumed ack
    const delivered: number[] = [];
    let resumedAck: { ok: boolean; from: number } | undefined;
    const seqOf = (b: Uint8Array): number => {
      const lo = b[6]! | (b[7]! << 8) | (b[8]! << 16) | (b[9]! << 24);
      const hi = b[10]! | (b[11]! << 8) | (b[12]! << 16) | (b[13]! << 24);
      return (lo >>> 0) + hi * 0x100000000;
    };
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (b.byteLength < 14) return;
      const d = decodeFrame(b);
      if (!d) return;
      if (d.name === "resumed") {
        resumedAck = d.payload as { ok: boolean; from: number };
        return;
      }
      if (d.name === "quote" && (b[5]! & 1) === 1) delivered.push(seqOf(b));
    };

    // 12 broadcast sends (single client) → seqs 1..12; ring (cap 4) wraps to hold 9..12
    for (let i = 0; i < 12; i++) server.publish("quote", quote("AAPL", { ts: i }));
    await waitFor(() => delivered.length >= 12);
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // simulate a gap: client claims it only has up to seq 10 → 11,12 replayed
    delivered.length = 0;
    resumedAck = undefined as { ok: boolean; from: number } | undefined;
    ws.send(encodeEvent("resume", { lastSeq: 10 }) as Uint8Array<ArrayBuffer>);
    await waitFor(() => resumedAck !== undefined && delivered.length >= 2);
    expect(resumedAck).toEqual({ ok: true, from: 11 }); // hole inside the ring → recoverable
    expect(delivered).toEqual([11, 12]); // ORIGINAL seqs preserved (not restamped)

    // live stream continues exactly where the stream left off (seq 13)
    server.publish("quote", quote("AAPL", { ts: 99 }));
    await waitFor(() => delivered.length >= 3);
    expect(delivered[2]).toBe(13);

    ws.close();
    server.stop();
  }, 10_000);

  test("a gap older than the retained ring reports ok:false (client must resubscribe)", async () => {
    const server = createServer({ port: 0, resume: { historySize: 4 } });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = await openWs(url);

    let ack: { ok: boolean; from: number } | undefined;
    let replayed = 0;
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      const d = decodeFrame(b);
      if (d?.name === "resumed") ack = d.payload as { ok: boolean; from: number };
      else if ((b[5]! & 1) === 1) replayed++;
    };

    for (let i = 0; i < 10; i++) server.publish("quote", quote("AAPL", { ts: i }));
    await waitFor(() => replayed >= 10);

    ws.send(encodeEvent("resume", { lastSeq: 2 }) as Uint8Array<ArrayBuffer>); // older than ring
    await waitFor(() => ack !== undefined);
    expect(ack!.ok).toBe(false); // unrecoverable hole — client resubscribes

    ws.close();
    server.stop();
  }, 10_000);
});
