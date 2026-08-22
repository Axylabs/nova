---
name: nova-websocket-pubsub-core
description: The server/client composition of @ignex/nova — the functional style (no classes), action modules over explicit state, and the typed pub/sub surface. Use when extending the transport, auth, rooms, groups, replay, backpressure, or the client.
---

# nova: WebSocket pub/sub core

The public API is **functional composition over an explicit state object** —
no classes, no `this`. `docs/architecture.md` §"Functional composition"
documents this; the FP lint rules in `.oxlintrc.json` enforce it.

## Composition roots

- `src/core/server.ts` — `createServer(options)`: the ONLY place that knows
  how the pieces fit together. Builds `ServerState`, wires `Bun.serve`,
  returns a plain API object.
- `src/core/client.ts` — `createClient(url, opts)`: builds client state,
  returns a plain API object with closures.
- `public/*.ts` are thin re-export shims keeping the npm subpaths
  (`@ignex/nova/server`, `/client`, `/nats`, `/events`, `/bindings`,
  `/generate`, `/internal`) and the `dist` build stable — edit `src/core`,
  not `public/`.

## Action modules (pure-ish functions over state)

| Module | Responsibility |
| --- | --- |
| `src/core/auth.ts` | Upgrade gate (authenticate hook, token, origin, maxConnections) |
| `src/core/rooms.ts` + `ring.ts` | Membership + fan-out; per-topic bounded replay ring |
| `src/core/replay.ts` | Per-topic history snapshot on subscribe |
| `src/core/groups.ts` | Server-side targeting sets (no replay) |
| `src/core/backpressure.ts` | Pure `decide` → send/enqueue/drop/close |
| `src/core/outbound.ts` | The ONLY place touching `ws.send` + per-socket queue |
| `src/core/routing.ts` | Inbound dispatch (header-first, control vs app) |
| `src/core/metrics.ts`, `int64-guard.ts` | Counters; int64 encode guard (module-global by design) |
| `src/core/client-wire.ts`, `client-reconnect.ts`, `client-heartbeat.ts` | Client side (pure backoff math, heartbeat) |
| `src/transport/transport.ts` | `encodeToScratch` — direct (FFI) / JSON / pure-JS paths |
| `src/transport/scratch.ts`, `stats.ts`, `byte-buffer-pool.ts` | Reusable zero-alloc output, path counters, pooled ByteBuffer |

## Factories for encapsulated state

`createMetrics()` (`src/core/metrics.ts`), `createScratch()`
(`src/transport/scratch.ts`), `createStats()` (`src/transport/stats.ts`).
`int64-guard` intentionally stays a module-global (cheap `off`-mode no-op) so
threading it through generated encoders can't cost the hot path.

## Typed pub/sub surface

`createServer(options)` → plain object with `publish(name, payload)`,
`publishToTopic`, `publishToClient`, `publishToGroup`, `getClient(id)`,
`getClients()`, `groupMembers(g)`, `groups()`, `joinGroup`/`leaveGroup`,
`getMetrics()`, `drain()`/`stop()`. `createClient(url, opts)` → `send(name,
payload)`, `on(name, handler)`, `subscribe(topic)`, status + reconnect.
All names are typed via `EventNameOf<B>` from the bindings.

## Conventions

- New behavior = a new action module `(state, …) => …`, composed in
  `server.ts`/`client.ts`. Keep it pure where possible; side effects confined
  to `outbound.ts` (ws.send), `auth.ts` (upgrade), and the client-wire.
- Keep new code compliant with the FP lint rules (no-var, prefer-const,
  no-param-reassign `props:false`, no-nested-ternary, no-loop-func, …).
- **Perf gate**: `bench/BASELINE.md` — re-run `bench:serialize` +
  `bench:throughput` before/after hot-path changes; >5% drift on the gate
  numbers is a failure.

## Verify

- `bun test` (auth, backpressure, rooms, groups, replay, ring, targeting,
  security, bidirectional, e2e suites; NATS integration opt-in via `NATS_URL`).
- `bun run verify` (typecheck + lint + test) before pushing.
