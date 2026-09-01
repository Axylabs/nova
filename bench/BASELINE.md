# Perf baseline (perf hard gate)

Recorded **2026-08-17** before the functional-composition refactor (Phase 0).

> Gate rule: relative to THIS baseline on the same machine. Fail-fast if any phase
> shows >±5% drift in encode latency or throughput, or any new allocations
> (B/op > 0 on the `quote` zero-alloc path). Repo-memory historical numbers
> (~191ns quote, ~1.24M msg/s) are informational only — machine-dependent.

## `bun run bench:serialize`

```
serialize latency (min-of-N ns/op):
  quote     Rust FFI ZERO-ALLOC       :    230.0 ns   (encodeToScratch, no JSON)
  quote     Rust FFI (owned copy)     :    328.0 ns   (encodeEvent incl. 1 alloc)
  quote     JS-side flatc pack        :    593.0 ns
  portfolio Rust FFI (packed vector)  :    945.0 ns   (no JSON)
  portfolio JS-side flatc pack        :   1699.0 ns
  LARGE     Rust FFI (packed vector)  :  27082.0 ns   (200 positions, no JSON)
  LARGE     JS-side flatc pack        :  64204.0 ns

allocations (heap delta/op, after GC):
  quote encodeToScratch (zero-alloc)  :      0.0 B/op
  quote encodeEvent (owned copy)      :     -0.0 B/op
  quote speedup (zero-alloc vs JS)    : 2.58×
  portfolio speedup (Rust vs JS)      : 1.80×
  LARGE speedup (Rust vs JS)          : 2.37×
```

## `bun run bench:throughput`

```
server publish ×20000: 18.3 ms → 1090129 msg/s (server-side)
client received: 20000/20000
```

## Key gate numbers

| metric | baseline | gate (fail if) |
| --- | --- | --- |
| quote encodeToScratch | 230.0 ns / 0.0 B/op | > ~241 ns or B/op > 0 |
| portfolio (packed vector) | 945.0 ns | > ~992 ns |
| LARGE (200 positions) | 27082.0 ns | > ~28436 ns |
| throughput | 1,090,129 msg/s | < ~1.04M msg/s |

## `bun run bench:dispatch` (added 2026-08-24)

A/B of pre-optimization replicas vs current code on the per-message JS paths
(inbound dispatch, context creation, user-target delivery) — the paths
`bench:serialize`/`bench:throughput` never exercise. Two metrics: min-of-N
batched ns/op (FTL best case) and sustained ops/sec over a fixed window with
GC running inside the measurement (where per-event garbage actually bills).

Recorded on the same machine as the original baseline, Bun 1.4.1:

```
1. inbound dispatch (3 handlers + onAny)
   min/op   old 72.3 ns · new 62.7 ns (1.15× faster best-case)
   sustained old 6.5M ops/s · new 13.1M ops/s (+100% incl. GC)

2. user-targeted delivery bookkeeping (4 sockets / 10k clients)
   min/op   old 49.2 ns · new 42.9 ns (1.15× faster best-case)
   sustained old 15.0M ops/s · new 22.3M ops/s (+49% incl. GC)

3. event-trace record (debugger visibility added to every event)
   min/op   on 42.9 ns · off 10.5 ns
   sustained on 23.0M rec/s

4. payload preview capture (opt-in): ~120 ns/event — off by default
```

JSC tier ladder for the new dispatch path (stability probe, 6 windows after
2M-op warm): FTL ≈ 55M ops/s steady → DFG-only ≈ 9.4M → LLInt ≈ 1.6M — a
smooth monotonic ladder with no cliffs or oscillation between windows, i.e.
no deopt/reopt pathology; the hot loops iterate dense COW arrays and hit
monomorphic record shapes throughout.

| metric | baseline | gate (fail if) |
| --- | --- | --- |
| dispatch sustained (new) | ~13M ops/s | < ~12M ops/s |
| dispatch best-case (new) | ~63 ns/op | > ~70 ns/op |
| trace.record (on) | ~43 ns/op | > ~55 ns/op |
