# Transport-neutral messaging

Nova is a **schema and wire protocol**, not just a WebSocket server. The same
TypeBox-generated FlatBuffer frame travels over WebSockets, binary HTTP, SSE,
NATS, or an application-owned carrier. No envelope change is required.

Use `@ignex/nova/messaging` in browsers or Bun. Use
`@ignex/nova/messaging/server` when a Bun server should encode replies through
the Rust transport.

## Binary service-to-service calls

`createServiceHandler` adapts a typed contract to the standard
`Request => Promise<Response>` shape. It works directly in an Ignex route, a
standalone `Bun.serve` fetch handler, tests, or another Fetch-compatible host.

```ts
import {
  createNativeMessageCodec,
  createServiceHandler,
} from "@ignex/nova/messaging/server";
import { bindings } from "./realtime/bindings";

const codec = createNativeMessageCodec(bindings); // direct Rust when available
export const handleEvent = createServiceHandler({
  codec,
  maxMessageSize: 64 * 1024,
  authenticate: (req) => req.headers.get("authorization") === `Bearer ${SERVICE_TOKEN}`,
  onMessage(message) {
    if (message.name !== "order.update") return;
    // message.payload is narrowed to the order.update schema here.
    return { name: "order.update", payload: message.payload };
  },
});
```

The request must be a `POST` carrying one complete Nova frame with
`content-type: application/vnd.ignex.nova` (generic `application/octet-stream`
is accepted too). A reply event uses the same binary media type; no reply is a
`204`. Request bodies, including chunked bodies, are bounded before decoding.
Malformed/control frames are rejected and handler errors do not leak internals.

Call the service from another Bun service, a worker, or a browser:

```ts
import { createServiceClient } from "@ignex/nova/messaging";

const orders = createServiceClient("https://internal.example/events", {
  bindings,
  headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  timeoutMs: 5_000,
});

const updated = await orders.call("order.update", { orderId: "o-42" });
await orders.send("order.update", { orderId: "o-43" }); // successful empty reply
```

`call` requires a same-event reply and rejects malformed, oversized, or
mismatched responses. `send` accepts any successful empty response.

## Nova over SSE

SSE is text over HTTP, so each `data:` field contains base64 of one complete
Nova frame. `event:` mirrors the frame's schema name. Decoding validates both;
a mismatch is an error, not a type-confusion opportunity.

```ts
import {
  createNativeMessageCodec,
  createSseResponse,
} from "@ignex/nova/messaging/server";

const codec = createNativeMessageCodec(bindings);
export const orderEvents = createSseResponse((async function* () {
  yield {
    frame: codec.encode("order.update", { orderId: "o-42" }),
    id: "order-42-v1",
    retry: 1_000,
  };
})());
```

The response uses pull backpressure. Cancelling the response or aborting its
signal tears down the producer so timers, subscriptions, and loops can exit.

Consume incrementally in Bun or a browser:

```ts
import { openNovaSse } from "@ignex/nova/messaging";

const stream = await openNovaSse("https://api.example.com/orders/sse", {
  bindings,
  headers: { authorization: `Bearer ${USER_TOKEN}` },
});
for await (const message of stream.messages) {
  if (message.name === "order.update") console.log(message.payload.orderId);
}
stream.close(); // idempotent; aborts fetch and releases the stream reader
```

The parser handles arbitrary chunk boundaries, CRLF/LF, comments, folded data,
and end-of-stream dispatch. Events and decoded frames are size-bounded. Use
`readNovaSse(responseOrStream, { bindings })` when you already own the response.

## Ignex routes

Both APIs are ordinary Request/Response adapters, so no second server or
WebSocket plugin is required. Return `handleEvent(req)` or `orderEvents` from an
Ignex route. WS pub/sub remains available for bidirectional presence and rooms;
binary services are for backend calls and integrations; SSE is for one-way
streams through proxies and browsers; NATS is for broker-based distribution.


## Performance

`bun run bench:messaging` runs the interleaved loopback Nova-vs-JSON echo
benchmark. Declared-length requests use a bounded `arrayBuffer()` fast path;
unknown-length requests retain the streaming byte cap. Generated decoders read
FlatBuffer tables and vectors directly without intermediate unpack objects.
Plain-number int64 fields avoid temporary `BigInt` values, while exact bigint
fields keep the lossless path.

On the local Bun 1.4.4 run, small echo latency fell from 71.5 to 50.5 µs and
200-item vector echo latency from 264.4 to 176.6 µs. Bun JSON was still faster
end to end on this workload (41.0 and 127.4 µs respectively). Nova's benefits
are the shared schema and transports, native encoding, and binary interop—not
an automatic win for every HTTP route. Measure the actual application payload
before choosing a transport.
