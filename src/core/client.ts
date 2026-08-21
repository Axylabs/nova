/**
 * Client composition root — wires client-state + wire / reconnect / heartbeat
 * into the public `IgnClient` API object (no class, no `this`). This is the
 * ONLY place that knows how the pieces fit together; `connect` lives here
 * because it owns the socket lifecycle.
 *
 * Public entry: `public/client.ts` re-exports `createClient` + the types.
 */
import { WIRE_VERSION } from "../generated/registry";
import { encodeEventFrame } from "../generated/ts-ser";
import type { Events, EventName } from "../schema";
import { createClientState, setStatus, type ClientState, type ClientStatus, type IgnClientOptions } from "./client-state";
import { handleMessage, sendControl, sendFrame } from "./client-wire";
import { startHeartbeat, stopHeartbeat } from "./client-heartbeat";
import { scheduleReconnect } from "./client-reconnect";

/** The public client API (returned by `createClient`). */
export interface IgnClient {
  on<K extends EventName>(name: K, handler: (payload: Events[K]) => void): IgnClient;
  off<K extends EventName>(name: K, handler: (payload: Events[K]) => void): IgnClient;
  /** Register a handler that fires once for the event, then removes itself. */
  once<K extends EventName>(name: K, handler: (payload: Events[K]) => void): IgnClient;
  /** Register a handler for EVERY incoming app event (name + payload). */
  onAny(cb: (name: EventName, payload: unknown) => void): IgnClient;
  offAny(cb: (name: EventName, payload: unknown) => void): IgnClient;
  /** Names that currently have at least one handler. */
  events(): EventName[];
  /** Remove all handlers (optionally just for one event). */
  removeAllListeners(name?: EventName): IgnClient;
  /** Register an error callback (decode failures, wire-version mismatch). */
  onError(cb: (err: Error) => void): IgnClient;
  offError(cb: (err: Error) => void): IgnClient;
  /** Watch connection lifecycle: "connecting" | "connected" | "disconnected" | "reconnecting" | "closed". */
  onStatus(cb: (status: ClientStatus) => void): IgnClient;
  offStatus(cb: (status: ClientStatus) => void): IgnClient;
  readonly currentStatus: ClientStatus;
  connect(): IgnClient;
  close(): void;
  /** Send a typed app event to the server (server must allow it via `inbound`). */
  send<K extends EventName>(name: K, payload: Events[K]): void;
  /** Ask the server to subscribe this socket to a topic (room membership + replay). */
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Ask the server to add this socket to a server-side group. */
  joinGroup(group: string): void;
  leaveGroup(group: string): void;
  /** The id the server assigned this connection ("" until `welcome` arrives). */
  readonly clientId: string;
  /** Server-side groups this client belongs to ([] until `welcome` arrives). */
  readonly groups: string[];
}

export function createClient(url: string, opts: IgnClientOptions = {}): IgnClient {
  const state: ClientState = createClientState(url, opts);

  function connect(): IgnClient {
    state.closed = false;
    setStatus(state, state.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      state.attempts = 0;
      setStatus(state, "connected");
      sendControl(state, "hello", { version: WIRE_VERSION, caps: [], lastSeq: 0 });
      // re-subscribe topics from before the disconnect (server cleared them)
      for (const t of state.subscribedTopics) sendControl(state, "subscribe", { topic: t });
      startHeartbeat(state);
    };
    ws.onmessage = (ev) => handleMessage(state, ev.data as ArrayBuffer | string);
    ws.onclose = () => {
      stopHeartbeat(state);
      state.ws = null;
      if (state.closed) {
        setStatus(state, "closed");
        return;
      }
      scheduleReconnect(state, connect);
    };
    state.ws = ws;
    return api;
  }

  const api: IgnClient = {
    on(name, handler) {
      let set = state.handlers.get(name);
      if (!set) {
        set = new Set();
        state.handlers.set(name, set);
      }
      set.add(handler as never);
      return api;
    },
    off(name, handler) {
      state.handlers.get(name)?.delete(handler as never);
      return api;
    },
    once(name, handler) {
      const wrap = (payload: never): void => {
        api.off(name, wrap as never);
        handler(payload);
      };
      api.on(name, wrap as never);
      return api;
    },
    onAny(cb) {
      state.anyHandlers.add(cb);
      return api;
    },
    offAny(cb) {
      state.anyHandlers.delete(cb);
      return api;
    },
    events() {
      return [...state.handlers.keys()];
    },
    removeAllListeners(name) {
      if (name) state.handlers.delete(name);
      else state.handlers.clear();
      return api;
    },
    onError(cb) {
      state.errorCbs.add(cb);
      return api;
    },
    offError(cb) {
      state.errorCbs.delete(cb);
      return api;
    },
    onStatus(cb) {
      state.statusCbs.add(cb);
      return api;
    },
    offStatus(cb) {
      state.statusCbs.delete(cb);
      return api;
    },
    get currentStatus(): ClientStatus {
      return state.status;
    },
    connect,
    close() {
      state.closed = true;
      stopHeartbeat(state);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      state.ws?.close();
      state.ws = null;
      setStatus(state, "closed");
    },
    send(name, payload) {
      sendFrame(state, encodeEventFrame(name, payload));
    },
    subscribe(topic) {
      state.subscribedTopics.add(topic);
      sendControl(state, "subscribe", { topic });
    },
    unsubscribe(topic) {
      state.subscribedTopics.delete(topic);
      sendControl(state, "unsubscribe", { topic });
    },
    joinGroup(group) {
      sendControl(state, "joinGroup", { group });
    },
    leaveGroup(group) {
      sendControl(state, "leaveGroup", { group });
    },
    get clientId(): string {
      return state.clientId;
    },
    get groups(): string[] {
      return state.groups;
    },
  };

  return api;
}
