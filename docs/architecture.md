# Architecture

ignex-nova is a TypeBox-driven **FlatBuffer transport over Bun WebSockets** with
a Rust FFI serializer — hidden behind a typed pub/sub API.

## Pipeline

The wire stack is generated from TypeBox schemas. The built-in registry
(`src/schema/index.ts`) runs the in-repo orchestrator (`scripts/generate.ts`);
**any** app can run the same emitters on its own schema via
`generateBindings` (`@ignex/nova/generate` → `src/codegen/`).

```
src/schema/index.ts (TypeBox — single source of truth: app events + control events)
        │  scripts/generate.ts   (or generateBindings() for YOUR schema)
        ▼
backend.fbs ──flatc --ts──▶ src/generated/ts/          (decoders, both sides)
        └───flatc --rust──▶ rust/src/generated/         (table builders)
src/codegen/rust-glue-gen.ts ─▶ rust/src/transcode/     (JSON glue + direct-args FFI)
src/codegen/direct-gen.ts ────▶ src/generated/direct-ser.ts (zero-alloc server encoder)
src/codegen/ts-ser-gen.ts ─────▶ src/generated/ts-ser.ts    (pure-JS browser encoder)
src/codegen/registry-gen.ts ───▶ src/generated/registry.ts  (event routing, both sides)
scripts/generate.ts ───────────▶ src/generated/wire-registry.json (name→id map for external consumers)
```

Every artifact is also emitted per-user-schema by `generateBindings`
(`src/codegen/*` emitters, `public/generate.ts`) into the app's
`ignex/generated/` folder, then assembled into a runtime `Bindings`
(`src/bindings/`) that `createServer` / `createClient` / `createNatsBridge`
accept via `options.bindings` (default: the built-in `defaultBindings`). See
[docs/generic-bindings.md](generic-bindings.md).

## Functional composition

The public API is built by **functional composition over an explicit state
object** — no classes, no `this`. `public/server.ts` and `public/client.ts`
are thin re-export shims that keep the npm entrypoints (`@ignex/nova/server`,
`@ignex/nova/client`) and the `dist` build stable; the implementation lives in
`src/core/`.

- **Composition roots** (`src/core/server/`, `src/core/client.ts`) — the only
  places that know how the pieces fit together. `createServer(options)` builds
  the `ServerState`, wires `Bun.serve`, and returns a plain API object;
  `createClient(url, opts)` builds the client state and returns a plain API
  object with closures over it.
- **Action modules** are pure-ish functions `(state, ...) => ...` that read/
  mutate the explicit state: `auth` (upgrade gate), `rooms` (membership +
  fan-out), `replay` (per-topic history), `backpressure` (pure `decide` → send/
  enqueue/drop/close), `outbound` (the only place that touches `ws.send` and
  the per-socket queue), `routing` (inbound dispatch), and the client's
  `client-wire` / `client-reconnect` (pure backoff math) / `client-heartbeat`.
- **Factories** for encapsulated mutable state: `createMetrics()`, `createScratch()`
  (reusable zero-alloc output buffer), per-event `EncodeRecord`s (encode-path
  counters resolved eagerly at `createTransport()` — instantiation time, not
  first-encode).
  `int64-guard` intentionally stays a module-global (cheap `off`-mode no-op) so
  threading it through the generated encoders can't cost the ~200ns hot path.
- **Dev discipline**: `bun run lint` (oxlint with FP rules: no-var,
  prefer-const, no-param-reassign `props:false`, prefer-arrow-callback,
  no-else-return, consistent-return, no-nested-ternary, no-loop-func, …) runs
  in CI after `tsc`. Perf is gated by `bench/BASELINE.md` — re-run
  `bench:serialize` + `bench:throughput` before/after hot-path changes and
  fail-fast on >±5% drift or new allocations.

## Encode paths (server)

- **Direct fast path (zero-alloc)** — directable events (flat types + packed
  vectors) are pushed straight into Rust FFI args from a reusable scratch; the
  output is written into a single reusable buffer. ~0 B/op.
- **JSON fallback** — nested tables/unions (e.g. `order`) serialize through
  `JSON.stringify → fb_serialize → serde_json`. Slower + allocating; the
  per-event encode path is observable via `server.getMetrics().pathCounts`.
- A payload containing an embedded NUL is routed to the JSON path (the
  `cstring` direct path would silently truncate it).

## Encode path (client / browser)

Browsers have no Rust FFI, so outgoing frames (app events **and** control
frames) are encoded by `generated/ts-ser.ts` — flatc's object API (`XxxT` +
`pack`) over a pooled `flatbuffers.Builder`. No JSON.

## Runtime layout

- `public/server.ts`, `public/client.ts`, `public/nats.ts` — thin re-export shims
  (npm entrypoints `@ignex/nova/server` / `client` / `nats` + the `dist` build).
  Implementation is in `src/core/` + `src/bridge/`.
- `src/core/server/index.ts` — `createServer` composition root: `Bun.serve`,
  client registry (id → socket), rooms, groups, inbound routing, control
  frames, auth/origin/token gates, backpressure, replay history, metrics,
  NATS bridge hook, graceful drain, `/health` + `/clients`. Decomposed into
  sibling modules: `client-info.ts` (pure introspection mapper),
  `http-routes.ts` (fetch handler), `socket-lifecycle.ts` (open/close as
  `(state, ws)` actions), `metrics-view.ts` (pure snapshot assembly).
- `src/core/client.ts` — `createClient` composition root: typed
  `on`/`send`/`subscribe`/`joinGroup`, reconnect with backoff, heartbeat, status
  events, `clientId`/`groups` (from the `welcome` control frame); the rpc
  plumbing (`client.request`) lives in `client-rpc.ts`.
- `src/core/{state,auth,rooms,groups,replay,backpressure,outbound,routing,resume,rate-limit}.ts` —
  server action modules over the explicit `ServerState`. `groups.ts` mirrors
  `rooms.ts` (targeting sets, no replay); `state.clients` is the id→socket
  registry, `state.groups` the group→members index. `rate-limit.ts` is the
  per-connection token bucket (`options.rateLimit`, default off); `auth.ts`
  compares literal bearer tokens in constant time and gates the HTTP admin
  surface; topic/group joins are authorized via `authorizeTopic` /
  `authorizeGroup`. `resume.ts` is gap-free delivery (below). `replay.ts`
  serves per-topic snapshots (`snapshotRequest { topic, fromSeq }`) and feeds
  the optional durable topic log; `topic-log.ts` is the pluggable durability
  seam (`createMemoryTopicLog()` ships in-repo).
- **Gap-free delivery** (`src/core/resume.ts`, envelope v2): with
  `createServer({ resume })` every APP frame is stamped (in place, pre-`ws.send`)
  with a per-connection delivery seq and recorded in a bounded per-connection
  history ring. A client that detects a hole sends `resume { lastSeq }`; the
  server replays from the ring with ORIGINAL seqs (in-order, duplicate-free).
  On disconnect the ring parks in a bounded/TTL'd graveyard keyed by client id;
  a reconnecting session adopts it via `hello { lastSeq }`. Control frames are
  never stamped (no ordering obligations), and external copies (NATS bridge /
  cluster envelope) are always taken BEFORE stamping mutates the scratch.
- `src/core/{client-state,client-wire,client-reconnect,client-heartbeat}.ts` —
  client action modules over the explicit client state.
- `src/bridge/` — optional NATS bridge (`createNatsBridge`;
  injectable `NatsTransport` for tests; eager non-blocking connect with retry;
  `nats/{index,types,real-transport,inbound}.ts` + `subjects.ts`),
  subject builders (`ignex.broadcast.*` / `ignex.topic.*` / `ignex.group.*` /
  inbound `ignex.inbound.>`). Outbound frames are copied from the shared
  scratch; inbound frames are decoded via `readFrameHeader`/`decodePayload` and
  forwarded to clients (never re-bridged). `subscribeRaw` exposes raw byte
  subscriptions (re-subscribed on reconnect) for the events cluster layer.
- `src/core/metrics.ts`, `src/core/int64-guard.ts` — `createMetrics()` factory
  + the exact-int64 safety net.
- `src/events/*` — the events layer (opt-in via `createServer({ events })`,
  public entry `@ignex/nova/events` → `public/events.ts`): `hub/` composition
  root (`server.events`, binds the module-global `emit`/`on` singleton;
  decomposed into `context-factory.ts` (cached handler contexts),
  `dispatch.ts` (reliability-aware dispatch), `metrics-snapshot.ts` (pure
  snapshot assembly), `resolve-cluster.ts` (transport resolution)),
  `types/` (`EventClient` records with `userId` + per-connection `data`,
  `EmitTarget` discriminated union, hub/options interfaces — one module per
  concern behind a barrel), `registry.ts`
  (multi-handler dispatch with isolation — copy-on-write lists,
  allocation-free dispatch, plus a settling variant for retries), `trace.ts`
  (the zero-GC event trace ring behind `server.getEventTrace()`),
  `clients.ts`/`data.ts` (client store: byId + byUser index), `groups.ts`
  (client groups reusing the transport registry + user groups), `emit.ts`
  (encode-once; bridge + cluster copies FIRST — pristine frames — then the
  stamped local fan-out), `cluster/` (v2 envelope codec in `envelope.ts`,
  presence codec + table, dedupe window, shared-state keys, NATS/Redis
  transports and memory/Redis state stores; ROUTED targeted delivery via
  per-instance subjects; broker-redelivery dedupe window), `delivery.ts`
  (opt-in handler retry/backoff + dead-letter sink via `events.handlers`),
  `schedule.ts` (`hub.schedule(name, payload, target, delayMs)` + cancel),
  `cluster-rpc.ts` (cross-instance request/response: `hub.call` /
  `hub.onMethod` over the cluster transport), `queue.ts` (bounded offload
  workers that keep all cluster/state work off the WS hot path), `global.ts`
  (the importable `emit`/`emitToGroup`/… singleton).
- `src/transport/{transport,scratch,stats}.ts` — object → frame encoding:
  `encodeToScratch` (direct/JSON), the reusable zero-alloc scratch, and
  encode-path stats.
- `src/generated/` — flatc `--ts`/`--rust` output + `registry.ts` +
  `direct-ser.ts` + `ts-ser.ts` + `wire-registry.json` (emitted; regenerated by
  `bun run generate`).
- `src/schema/index.ts` — TypeBox source of truth.
- `src/native/*` — the only place that talks to Rust: `dlopen` binding with a
  bind-time self-test (a failing direct symbol is disabled → JSON fallback),
  `buffer`/`buffer_length` ABI probing, per-platform addon resolution.
- `rust/` — a cdylib exporting `#[no_mangle] extern "C"` symbols, `panic_guard`-
  wrapped, `thread_local` reused `FlatBufferBuilder`.

## Client identity, targeting & the NATS bridge

- **Identity**: `authenticate(req)` may return `{ id, groups, meta }`; otherwise
  a UUID is assigned at upgrade (`auth.ts`). Ids are de-duplicated (409 at
  upgrade, stale-session kick at open). `state.clients: Map<id, socket>` is the
  live registry; the server sends the `welcome` control frame so each client
  knows its id + server-side groups.
- **Targeting**: `publishToClient(id, …)` (single socket, not bridged),
  `publishToGroup(group, …)` (server-side targeting sets — from auth metadata,
  `joinGroup(id, group)`, or client `joinGroup` control frames).
- **Bridge**: `createServer({ nats })` creates a `NatsBridge`. The fan-out path
  encodes once; the NATS copy is taken BEFORE per-socket delivery-seq stamping
  mutates the scratch header, so external consumers see pristine frames.
  Subjects are derived by `src/bridge/subjects.ts`. Inbound NATS events are
  decoded and forwarded via `fanOutAll` (no bridge call → loop prevention). All
  bridge counters fold into `server.getMetrics()`.

## Why it's fast

- Zero-alloc server encode (reusable scratch + Bun's synchronous `ws.send`
  copy).
- FlatBuffers = zero-parse reads, no JSON on the hot path.
- flatc guarantees the Rust builders and TS decoders agree byte-for-byte.

## Runtime & platform constraints

- **Server is Bun-only** (`bun:ffi`, `Bun.serve`). Node is not supported.
- The native addon is per-OS (`.so`/`.dylib`/`.dll`) — see
  `src/native/loader.ts`. Build it with `cargo build --release`.
- The **client** works in Bun AND browsers (bundle with
  `bun build --target=browser`).

## Known limits (documented, not hidden)

- Plain `number` int64 fields lose precision above ±2^53-1 — use
  `Type.BigInt()` fields for exact values, or enable `int64Guard`.
- The direct fast path covers flat types + packed vectors; nested single-object
  tables fall back to JSON (observable via metrics).
- Resume history is bounded (`resume.historySize`, default 256 frames) and the
  cross-session graveyard is TTL'd (`resume.ttlMs`, default 60s): a hole older
  than what is retained is reported `resumed { ok: false }` — clients should
  resubscribe topics for a fresh snapshot. Frames published while NO session
  for a client id exists are not buffered per-client (that's an offline-inbox
  feature, not resume).
- The durable topic log seam ships with a process-local implementation
  (`createMemoryTopicLog`); production adapters (NATS JetStream / Redis
  Streams / filesystem) implement the same three-method interface.
- Cluster envelope v2 is not understood by v1 peers (rolling upgrades count
  decode errors on the old instances until they are replaced).
- Cross-instance rpc `.any` calls are delivered to every instance; the first
  response wins and later responders still execute their handlers (keep
  `.any` methods idempotent, or address a specific instance).
