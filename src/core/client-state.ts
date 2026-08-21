/**
 * Client state + option types. `createClientState(url, opts)` builds the single
 * explicit state object the client action functions read/mutate. The option /
 * status types are the PUBLIC surface and are re-exported by `public/client.ts`.
 */
import type { EventName, Events } from "../schema";

export type ClientStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "closed";

export interface IgnReconnectOptions {
  /** initial reconnect delay (ms), default 250 */
  initialDelay?: number;
  /** maximum reconnect delay (ms), default 30000 */
  maxDelay?: number;
  /** randomize each delay (×0.5–1.5), default true */
  jitter?: boolean;
}

export interface IgnClientOptions {
  /** auto-reconnect on unexpected close, default false (boolean or options) */
  reconnect?: boolean | IgnReconnectOptions;
  /** app-level ping interval in ms (0 disables), default 15000 */
  heartbeatMs?: number;
  /** miss this many heartbeats before assuming the connection is dead, default 2 */
  heartbeatMisses?: number;
}

type Handler<K extends EventName> = (payload: Events[K]) => void;

export interface ClientState {
  url: string;
  opts: IgnClientOptions;
  ws: WebSocket | null;
  handlers: Map<EventName, Set<Handler<never>>>;
  anyHandlers: Set<(name: EventName, payload: unknown) => void>;
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
}

export function createClientState(url: string, opts: IgnClientOptions = {}): ClientState {
  return {
    url,
    opts,
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
  };
}

export function setStatus(state: ClientState, s: ClientStatus): void {
  if (state.status === s) return;
  state.status = s;
  for (const cb of state.statusCbs) cb(s);
}
