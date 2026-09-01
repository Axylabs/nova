# Wire format

This document pins the on-the-wire contract so anyone can build an independent
client from the generated FlatBuffers schema — no Bun, no Rust, no FFI needed.

## Frame

Every WebSocket **binary** frame is:

```
┌──────────┬───────────────────┬─────────┬────────────┬──────────────────────────────────┐
│ version  │ event_id          │ flags   │ seq        │ size-prefixed FlatBuffer         │
│ 1 byte   │ u32 (LE)          │ 1 byte  │ u64 (LE)   │ (flatc: 4-byte size prefix + buf)│
└──────────┴───────────────────┴─────────┴────────────┴──────────────────────────────────┘
    offset 0      1..5               5           6..14       14..
```

- `version` = `WIRE_VERSION` (currently `2` — v2 added the delivery header).
  A peer MUST drop frames whose version it doesn't recognize (the decoders
  return `null`).
- `event_id` = **FNV-1a 32-bit hash of the event name** (e.g.
  `fnv1a32("quote")`). Stable across schema reordering; collisions are rejected
  at generate time. The id→name table is emitted in `src/generated/registry.ts`.
- `flags` — bit0 = "seq-valid" (see below); all other bits reserved, send 0.
- `seq` — per-CONNECTION delivery sequence, stamped by the SERVER on every
  **app** frame just before `ws.send` (Bun copies synchronously). Clients use
  it for gap detection + resume. Control frames are never stamped; frames that
  were not per-destination stamped carry `flags=0, seq=0`. Offsets are derived
  from `WIRE_HEADER_LEN`: flags at `len-9`, seq at `len-8..len`.
- The payload is a **size-prefixed FlatBuffer** (built by flatc, both Rust
  builders and the TS object API) with the root table for that event id.

There is **no per-frame checksum and no authentication** — the envelope id byte
is trusted. Integrity and AuthN are the application's job (see
[Security](#security)).

## String fields carry raw UTF-8

A FlatBuffer `string` field stores its content as raw UTF-8 bytes in the frame,
so any JSON document placed in a string field appears **verbatim** inside the
(binary) frame — expected behavior, not corruption. If a captured frame shows
`{"items":[...]}` text in the payload, the event schema models that data as a
`string` field (a JSON-in-a-string envelope, or a field written as
`Type.Any()`/`Type.Unknown()`, which the codegen now rejects at generate time —
see docs/generic-bindings.md). Prefer typed fields — `Type.Array(Table)` for
lists, `Type.Integer()` for counts — so the frame carries structure instead of
JSON text.

## Event ids

Event ids are stable hashes, so adding events, reordering the registry, or
adding fields does not renumber the wire format. Compute them with FNV-1a 32:

```
h = 2166136261
for each byte b of the UTF-8 event name:
    h ^= b
    h = (h * 16777619) mod 2^32
```

## Control frames

A fixed set of transport-internal events share the SAME frame format and the
SAME codegen, but are routed internally (never delivered to app handlers):

| name | direction | payload |
| --- | --- | --- |
| `hello` | both | `{ version, caps: string[], lastSeq }` — sent on connect; version mismatch → close(1002). `lastSeq > 0` asks the server to resume this client id's delivery stream after that seq (cross-session resume) |
| `welcome` | server→client | `{ clientId, groups: string[] }` — identity assigned to this connection (auth metadata or UUID) + its server-side groups |
| `subscribe` | client→server | `{ topic }` — join a room (server replies with replay history) |
| `unsubscribe` | client→server | `{ topic }` |
| `joinGroup` | client→server | `{ group }` — join a server-side group |
| `leaveGroup` | client→server | `{ group }` |
| `snapshotRequest` | client→server | `{ topic, fromSeq }` — replay recorded topic history STRICTLY after `fromSeq` (0 = from the beginning of retained history); hydrates from the durable topic log when the in-memory ring has moved on |
| `resume` | client→server | `{ lastSeq }` — same-connection gap recovery: re-send everything after the last CONTIGUOUS delivery seq (original seqs preserved) |
| `resumed` | server→client | `{ ok: boolean, from: number }` — ack before the replayed frames; `ok:false` = the hole is older than the retained history (partial recovery — resubscribe topics for a fresh snapshot) |
| `rpcCall` | client→server | `{ id, name, payloadB64 }` — request/response: `payloadB64` is base64 of a full wire frame encoded with event `name`'s schema; the response reuses the SAME schema |
| `rpcResult` | server→client | `{ id, ok, err, payloadB64 }` — correlated by `id`; `ok:false` carries a plain-text `err` |
| `ping` | client→server | `{ ts }` — heartbeat |
| `pong` | server→client | `{ ts }` |

Control ids are `fnv1a32` of the control name, dispatched via
`isControlId(id)` before user handlers.

## Rooms / topics

- `subscribe`/`unsubscribe` control frames manage server-side room membership.
- The server keeps an optional per-topic history (`replay: { historySize }`).
  On join it sends the recorded frames **oldest → newest** as a last-value
  snapshot, then live traffic follows. History is bounded (`historySize`),
  older frames are dropped.
- `publish` = global broadcast; `publishToTopic` = room only.

## Targeted delivery / groups

Every connection gets a stable **client id**: an explicit id from the
`authenticate` hook (`{ id, groups, meta }`) or an auto-generated UUID. The
server assigns it during the upgrade and delivers it in the `welcome` control
frame, so the client knows its own identity (`client.clientId`).

- `publishToClient(id, name, payload)` — send to ONE client by id (not bridged
to NATS).
- **Groups** are a server-side targeting dimension (no replay):
  - seeded from `authenticate` metadata (`{ groups: [...] }`),
  - managed programmatically (`joinGroup(id, group)` / `leaveGroup(id, group)`),
  - or joined by the client via the `joinGroup`/`leaveGroup` control frames.
- `publishToGroup(group, name, payload)` fans out to every member.
- Introspection: `getClient(id)` / `getClients()` / `groupMembers(group)` /
  `groups()` — also exposed as `GET /clients` on the server.

Rooms are client-joinable *subscriptions with optional replay*; groups are
server-side *targeting sets without replay*. Both are independent dimensions.

## NATS bridge

When `createServer({ nats: {...} })` is set, every broadcast / topic / group
publish is ALSO published to NATS as the **same wire frame** the WS clients
receive (encoded once, copied for NATS). Best-effort: if NATS is down the
frame is dropped and counted in `bridgeErrors` — the WS hot path never blocks.

| publish API | NATS subject |
| --- | --- |
| `publish(name, …)` | `{prefix}.broadcast.{name}` |
| `publishToTopic(topic, name, …)` | `{prefix}.topic.{topic}.{name}` |
| `publishToGroup(group, name, …)` | `{prefix}.group.{group}.{name}` |

`{prefix}` defaults to `ignex`. External apps push events INTO the hub by
publishing on `{prefix}.inbound.>` (default; configurable via
`inboundSubjects`); the server decodes them and forwards to all clients
(allowlisted by `inboundEvents`, control frames dropped, and never re-bridged —
no loops). `publishToClient` (single-socket) is intentionally not bridged.

Bridge state is observable via `server.getMetrics()`
(`natsStatus`, `bridged`, `bridgedBytes`, `bridgeErrors`, `bridgeInbound`).

### Decoding bridged frames (external consumers)

`bun run generate` emits `src/generated/wire-registry.json` — a machine-readable
`{ version, fingerprint, events: { name: id } }` map of the FNV-1a ids. A
consumer in any language:

1. reads `version` (byte 0) and `event_id` (bytes 1..5) from the frame,
2. maps `event_id` → name via `wire-registry.json`,
3. decodes the size-prefixed FlatBuffer from `frame[14..]` with a flatc build of
   `src/generated/fbs/backend.fbs`.

See `examples/nats-consumer.ts` for a working reference.

For YOUR OWN schema, `generateBindings` (see
[docs/generic-bindings.md](generic-bindings.md)) emits the same
`backend.fbs` + `wire-registry.json` into your project, plus a `fingerprint`
field — the cdylib and the generated registry share it, so a schema-mismatched
native addon fails the bind-time self-test instead of emitting undecodable
frames.

## Heartbeat

Clients send `ping` every `heartbeatMs` (default 15000). The server replies
`pong`. Bun's `idleTimeout` closes connections with no traffic, so pings keep
long-idle sockets alive; a client that misses `heartbeatMisses` pongs force-
closes and reconnects.

## Sequence / resume / request-response

- **Delivery seqs (v2)**: when the server starts with `resume`, every app frame
  it writes to a socket carries an increasing per-connection `seq` (envelope
  flags bit0). Clients track the stream; a GAP (lost frame — backpressure drop,
  transport hiccup) is recovered by sending `resume { lastSeq }`; the server
  replays from the connection's bounded sent-history ring with ORIGINAL seqs so
  redelivery is in-order and duplicate-free. On disconnect the ring parks in a
  per-client-id graveyard (bounded, TTL'd); a reconnecting session with the
  same auth-pinned id continues the stream via `hello { lastSeq }`.
- **Topic snapshots**: `snapshotRequest { topic, fromSeq }` replays recorded
  topic history strictly after a topic seq; a durable `topicLog`
  (`createServer({ topicLog })`, e.g. `createMemoryTopicLog()`) hydrates ranges
  the replay ring has already forgotten. Topic-history seqs are a SEPARATE
  counter (global replay order) from per-connection delivery seqs.
- **Request/response**: `client.request(name, payload)` wraps a full wire frame
  (base64) in an `rpcCall` control frame with a correlation id; the server's
  registered responder (via `server.handle(name, fn)` or `hub.onRequest`)
  returns the response payload encoded with the SAME event schema. Timeouts and
  errors are correlated client-side.

## Security

- **Trust model**: the envelope has no checksum/AuthN. A hostile peer can lie
  about the event id; the decoder is fuzz-safe (never throws / OOB) but will
  happily decode the payload as the claimed type. Add integrity at the
  application layer if the wire crosses an untrusted boundary.
- Server-side guards (all optional): `authenticate(req)` async hook, origin
  allowlist, bearer `token` (literal tokens compared in constant time),
  `maxConnections`, `maxMessageSize`, per-connection inbound rate limiting
  (`rateLimit`: token bucket over app AND control frames — drop or close 1008,
  counted in `metrics.rateLimited`).
- Join authorization: `authorizeTopic(topic, ws)` / `authorizeGroup(group, ws)`
  gate EVERY room/group join path (control frames, programmatic joins, and
  auth-seeded membership); rejections are counted in `metrics.rejectedJoins`.
  Leaving is always allowed.
- Introspection: `GET /clients` is gated by the same token/`authenticate`
  surface when one is configured (public only on servers with no auth at all);
  `/health` stays public (counters only).
- Slow consumers: `backpressure` policy (`drop-oldest`/`drop-newest`/
  `disconnect`) bounds per-socket buffering; without it a hot publish loop can
  balloon memory.
- Injection: unknown object keys and prototype-pollution keys are dropped on
  both encode paths; embedded NULs route to the JSON path so they round-trip
  exactly (never silently truncated).

## Building an independent client

1. `bun run generate` produces `generated/fbs/backend.fbs` — the FlatBuffers
   schema for every table (app + control).
2. Compile that `.fbs` with flatc for your language: `flatc --python
   --gen-object-api ...`, `--cpp`, `--go`, etc.
3. Read `version` (byte 0) and `event_id` (bytes 1..5) from each binary frame.
   Compute ids with FNV-1a 32 over the name (see above) or read the emitted
   `src/generated/registry.ts` table.
4. `flatbuffers.ByteBuffer(frame[14..])` + `getSizePrefixedRootAs<T>` (or the
   language equivalent) gives you the payload.
5. Implement the control frames (at minimum `hello` + `ping`/`pong`) to be a
   good citizen; `subscribe` for rooms.

Wire compatibility is guaranteed by flatc: the Rust builders (server) and the
generated TS object API (browser client) both derive from the same `.fbs`.
