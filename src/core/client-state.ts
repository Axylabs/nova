/**
 * Client state + option types. `createClientState(url, opts)` builds the single
 * explicit state object the client action functions read/mutate. The option /
 * status types are the PUBLIC surface and are re-exported by `public/client.ts`.
 */

import { defaultBindings } from "../bindings/default";
import type { Bindings, DefaultBindings } from "../bindings/types";

export type ClientStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "closed";

export interface IgnReconnectOptions {
  /** initial reconnect delay (ms), default 250 */
  initialDelay?: number;
  /** maximum reconnect delay (ms), default 30000 */
  maxDelay?: number;
  /** randomize each delay (×0.5–1.5), default true */
  jitter?: boolean;
}

export interface IgnClientOptions<B extends Bindings = DefaultBindings> {
  /**
   * The wire stack (event ids, decoders, encoders). Defaults to the built-in
   * registry; pass your own (from `generateBindings` + `assembleBindings`) to
   * speak YOUR schema. When provided, the client API (`on` / `send` / ...) is
   * typed against your `Events`.
   */
  bindings?: B;
  /** auto-reconnect on unexpected close, default false (boolean or options) */
  reconnect?: boolean | IgnReconnectOptions;
  /** app-level ping interval in ms (0 disables), default 15000 */
  heartbeatMs?: number;
  /** miss this many heartbeats before assuming the connection is dead, default 2 */
  heartbeatMisses?: number;
  /**
   * Gap-free delivery (requires the server started with `resume`): track the
   * server's per-connection delivery seqs, detect gaps, and automatically
   * request re-delivery via the `resume` control frame. Buffered out-of-order
   * frames are bounded by `maxPending`. Default: true (no-op against servers
   * that don't stamp seqs).
   */
  resume?: boolean | { maxPending?: number; timeoutMs?: number };
  /** request/response default timeout (ms), default 10_000 */
  requestTimeoutMs?: number;
}

export interface ClientState {
  url: string;
  opts: IgnClientOptions<Bindings>;
  /** the wire stack this client speaks (ids / decoders / encoders). */
  bindings: Bindings;
  ws: WebSocket | null;
  handlers: Map<string, Set<(payload: unknown) => void>>;
  anyHandlers: Set<(name: string, payload: unknown) => void>;
  errorCbs: Set<(err: Error) => void>;
  statusCbs: Set<(status: ClientStatus) => void>;
  closed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  attempts: number;
  status: ClientStatus;
  subscribedTopics: Set<string>;
  lastPong: number;
  /** id the server assigned to this connection (from `welcome`; "" until known) */
  clientId: string;
  /** server-side groups this client belongs to (from `welcome`; [] until known) */
  groups: string[];

  // ── delivery-seq tracking / gap recovery (envelope v2) ──────────────────
  /** resolved resume options (enabled: false when off) */
  resume: { enabled: boolean; maxPending: number; timeoutMs: number };
  /** last CONTIGUOUS delivery seq processed (0 = none yet) */
  rxSeq: number;
  /** frames held out-of-order while a gap is being filled (seq → frame bytes) */
  pending: Map<number, Uint8Array[]>;
  /** seq the pending buffer is waiting to fill from */
  pendingFrom: number;
  /** in-flight resume request flag (throttles re-asks) */
  resumeInFlight: boolean;
  /** force-flush timer for an unfillable gap */
  gapTimer: ReturnType<typeof setTimeout> | null;
  /** request/response: correlation id → pending call */
  rpcPending: Map<string, { resolve: (payload: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; name: string }>;
  /** default request timeout (ms) */
  requestTimeoutMs: number;
}

export function createClientState<B extends Bindings = DefaultBindings>(
  url: string,
  opts: IgnClientOptions<B> = {},
): ClientState {
  return {
    url,
    opts,
    bindings: opts.bindings ?? defaultBindings,
    ws: null,
    handlers: new Map(),
    anyHandlers: new Set(),
    errorCbs: new Set(),
    statusCbs: new Set(),
    closed: false,
    reconnectTimer: null,
    heartbeatTimer: null,
    attempts: 0,
    status: "closed",
    subscribedTopics: new Set(),
    lastPong: 0,
    clientId: "",
    groups: [],
    resume: {
      enabled: opts.resume !== false,
      maxPending:
        (typeof opts.resume === "object" ? opts.resume.maxPending : undefined) ?? 1024,
      timeoutMs:
        (typeof opts.resume === "object" ? opts.resume.timeoutMs : undefined) ?? 5_000,
    },
    rxSeq: 0,
    pending: new Map(),
    pendingFrom: 0,
    resumeInFlight: false,
    gapTimer: null,
    rpcPending: new Map(),
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
  };
}

export function setStatus(state: ClientState, s: ClientStatus): void {
  if (state.status === s) return;
  state.status = s;
  for (const cb of state.statusCbs) cb(s);
}
