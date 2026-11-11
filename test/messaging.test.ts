/** Transport-neutral binary services and Nova-over-SSE contract tests. */
import { describe, expect, test } from "bun:test";
import {
  createMessageCodec,
  createServiceClient,
  createServiceHandler,
  createSseResponse,
  decodeSseEvent,
  encodeSseEvent,
  NOVA_CONTENT_TYPE,
  openNovaSse,
  readNovaSse,
} from "../public/messaging";
import { createNativeMessageCodec } from "../public/messaging-server";
import { defaultBindings } from "../src/bindings/default";
import { quote, waitFor } from "./helpers";

const q = (symbol = "AAPL") => quote(symbol);

const request = (body: Uint8Array, headers: Record<string, string> = {}) =>
  new Request("http://service.test/events", {
    method: "POST",
    headers: { "content-type": NOVA_CONTENT_TYPE, ...headers },
    body: body as Uint8Array<ArrayBuffer>,
  });

describe("binary Nova services", () => {
  test("typed call and one-way send share the same schema without WebSockets", async () => {
    const seen: string[] = [];
    const handler = createServiceHandler({
      onMessage(message) {
        if (message.name !== "quote") return;
        seen.push(message.payload.symbol);
        if (message.payload.symbol === "ONE-WAY") return;
        return { name: "quote", payload: { ...message.payload, symbol: `RE:${message.payload.symbol}` } };
      },
    });
    const client = createServiceClient("http://service.test/events", { fetch: handler });
    expect((await client.call("quote", q("CALL"))).symbol).toBe("RE:CALL");
    await client.send("quote", q("ONE-WAY"));
    expect(seen).toEqual(["CALL", "ONE-WAY"]);
  });

  test("native codec preserves direct Rust encoding for service replies", async () => {
    const codec = createNativeMessageCodec(defaultBindings);
    const handler = createServiceHandler({
      codec,
      onMessage: (message) => message.name === "quote"
        ? { name: "quote", payload: message.payload }
        : undefined,
    });
    const response = await handler(request(codec.encode("quote", q("NATIVE"))));
    expect(response.status).toBe(200);
    const decoded = codec.decode(new Uint8Array(await response.arrayBuffer()));
    expect(decoded?.name).toBe("quote");
    if (decoded?.name !== "quote") throw new Error("missing quote reply");
    expect(decoded.payload.symbol).toBe("NATIVE");
  });

  test("guard, media type, malformed frame, size, and handler-error boundaries", async () => {
    const handler = createServiceHandler({
      maxMessageSize: 128,
      authenticate: (req) => req.headers.get("authorization") === "Bearer ok",
      onMessage: () => {
        throw new Error("private detail");
      },
    });
    expect((await handler(request(defaultBindings.encodeFrame("quote", q())))).status).toBe(401);
    const authorized = { authorization: "Bearer ok" };
    expect((await handler(request(defaultBindings.encodeFrame("quote", q()), {
      ...authorized,
      "content-type": "application/json",
    }))).status).toBe(415);
    expect((await handler(request(new Uint8Array(129), authorized))).status).toBe(413);
    expect((await handler(request(new Uint8Array([1, 2, 3]), authorized))).status).toBe(400);
    const failed = await handler(request(defaultBindings.encodeFrame("quote", q()), authorized));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private detail");
    expect((await handler(new Request("http://service.test/events"))).status).toBe(405);
  });

  test("client rejects HTTP failures, mismatched replies, and oversized responses", async () => {
    const failure = createServiceClient("http://service.test", {
      fetch: async () => new Response("no", { status: 503 }),
    });
    await expect(failure.send("quote", q())).rejects.toThrow("503");

    const mismatch = createServiceClient("http://service.test", {
      fetch: async () => new Response(defaultBindings.encodeFrame("trade", {
        symbol: "T", price: 1, volume: 1, side: "buy", ts: 1,
      }) as Uint8Array<ArrayBuffer>),
    });
    await expect(mismatch.call("quote", q())).rejects.toThrow("mismatched");

    const limited = createServiceClient("http://service.test", {
      maxMessageSize: 4,
      fetch: async () => new Response(defaultBindings.encodeFrame("quote", q()) as Uint8Array<ArrayBuffer>),
    });
    await expect(limited.call("quote", q())).rejects.toThrow("exceeded");
  });
});

describe("Nova over SSE", () => {
  test("SSE response streams typed frames with ids and retry metadata", async () => {
    const response = createSseResponse((async function* () {
      yield { frame: defaultBindings.encodeFrame("quote", q("ONE")), id: "e-1", retry: 250 };
      yield defaultBindings.encodeFrame("quote", q("TWO"));
    })());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = [];
    for await (const event of readNovaSse(response)) events.push(event);
    expect(events.map((event) => event.name === "quote" ? event.payload.symbol : "")).toEqual(["ONE", "TWO"]);
    expect(events[0]?.id).toBe("e-1");
    expect(events[0]?.retry).toBe(250);
  });

  test("incremental parser handles byte splits, CRLF, comments, and multi-line data", async () => {
    const encoded = new TextDecoder().decode(encodeSseEvent(defaultBindings.encodeFrame("quote", q("SPLIT"))));
    const withComment = `: keepalive\r\n${encoded.replaceAll("\n", "\r\n")}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(withComment);
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readNovaSse(stream)) events.push(event);
    expect(events.length).toBe(1);
    expect(events[0]?.name).toBe("quote");
    if (events[0]?.name !== "quote") throw new Error("missing quote event");
    expect(events[0].payload.symbol).toBe("SPLIT");
  });

  test("fetch opener validates content type and closes the stream", async () => {
    const response = createSseResponse((async function* () {
      yield defaultBindings.encodeFrame("quote", q("FETCH"));
    })());
    const opened = await openNovaSse("http://service.test/sse", { fetch: async () => response });
    const first = await opened.messages.next();
    expect(first.value?.name).toBe("quote");
    if (first.value?.name !== "quote") throw new Error("missing quote event");
    expect(first.value.payload.symbol).toBe("FETCH");
    opened.close();
    await waitFor(() => opened.response.body?.locked === false);
    expect(opened.response.body?.locked).toBe(false);
  });

  test("codec rejects event/frame mismatch and invalid SSE fields", () => {
    const frame = defaultBindings.encodeFrame("quote", q());
    expect(() => decodeSseEvent("event: trade\ndata: AA==", defaultBindings)).toThrow();
    const forged = new TextDecoder().decode(encodeSseEvent(frame));
    const mismatched = forged.replace("event: quote", "event: trade");
    expect(() => decodeSseEvent(mismatched, defaultBindings)).toThrow("does not match");
    const fake = {
      ...defaultBindings,
      readFrameHeader: () => ({ name: "bad\nname", id: 1 }),
    };
    expect(() => encodeSseEvent(frame, fake)).toThrow("single-line");
    expect(() => encodeSseEvent({ frame, id: "bad\nid" })).toThrow("newlines");
  });

  test("consumer cancellation tears down the producer", async () => {
    let cancelled = false;
    const response = createSseResponse((async function* () {
      try {
        yield defaultBindings.encodeFrame("quote", q("FIRST"));
        yield defaultBindings.encodeFrame("quote", q("SECOND"));
      } finally {
        cancelled = true;
      }
    })());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => cancelled);
    expect(cancelled).toBe(true);
  });

  test("portable codec rejects control frames on service boundaries", () => {
    const codec = createMessageCodec(defaultBindings);
    expect(codec.decode(defaultBindings.encodeFrame("ping", { ts: 1 }))).toBeNull();
  });
});
