/**
 * Client composition root — wires client-state + wire / reconnect / heartbeat
 * into the public `IgnClient` API object (no class, no `this`). This is the
 * ONLY place that knows how the pieces fit together; `connect` lives here
 * because it owns the socket lifecycle.
 *
 * Generic over the wire stack: `createClient(url, { bindings })` with your own
 * generated bindings types `on` / `send` / ... against YOUR events. The default
 * is the built-in registry, so existing code keeps working unchanged.
 *
 * Public entry: `public/client.ts` re-exports `createClient` + the types.
 */
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";
import { createClientState, setStatus, type ClientState, type ClientStatus, type IgnClientOptions } from "./client-state";
import {
  handleMessage,
  emitError,
  sendControl,
  sendFrameQueued,
  flushPendingSends,
  flushPending,
} from "./client-wire";
import { startHeartbeat, stopHeartbeat } from "./client-heartbeat";
import { scheduleReconnect } from "./client-reconnect";
import { failAllPending, createRpcRequest } from "./client-rpc";

/** Result of a request/response round-trip. */
export interface RpcResult<P> {
  payload: P;
}

/** The public client API (returned by `createClient`). */
export interface IgnClient<B extends Bindings = DefaultBindings> {
  on<K extends EventNameOf<B>>(name: K, handler: (payload: EventsOf<B>[K]) => void): IgnClient<B>;
  off<K extends EventNameOf<B>>(name: K, handler: (payload: EventsOf<B>[K]) => void): IgnClient<B>;
  /** Register a handler that fires once for the event, then removes itself. */
  once<K extends EventNameOf<B>>(name: K, handler: (payload: EventsOf<B>[K]) => void): IgnClient<B>;
  /** Register a handler for EVERY incoming app event (name + payload). */
  onAny(cb: (name: EventNameOf<B>, payload: unknown) => void): IgnClient<B>;
  offAny(cb: (name: EventNameOf<B>, payload: unknown) => void): IgnClient<B>;
  /** Names that currently have at least one handler. */
  events(): EventNameOf<B>[];
  /** Remove all handlers (optionally just for one event). */
  removeAllListeners(name?: EventNameOf<B>): IgnClient<B>;
  /** Register an error callback (decode failures, wire-version mismatch). */
  onError(cb: (err: Error) => void): IgnClient<B>;
  offError(cb: (err: Error) => void): IgnClient<B>;
  /** Watch connection lifecycle: "connecting" | "connected" | "disconnected" | "reconnecting" | "closed". */
  onStatus(cb: (status: ClientStatus) => void): IgnClient<B>;
  offStatus(cb: (status: ClientStatus) => void): IgnClient<B>;
  readonly currentStatus: ClientStatus;
  connect(): IgnClient<B>;
  close(): void;
  /** Send a typed app event to the server (server must allow it via `inbound`). */
  send<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
  /**
   * Request/response: send `name` and await the responder's payload (encoded
   * with the SAME event schema). Rejects on timeout (`timeoutMs`, default
   * `requestTimeoutMs`) or when no responder is registered server-side.
   */
  request<K extends EventNameOf<B>>(
    name: K,
    payload: EventsOf<B>[K],
    opts?: { readonly timeoutMs?: number },
  ): Promise<RpcResult<EventsOf<B>[K]>>;
  /** Ask the server to subscribe this socket to a topic (room membership + replay). */
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Ask the server to re-send recorded topic history strictly after `fromSeq`. */
  snapshotRequest(topic: string, fromSeq?: number): void;
  /** Ask the server to add this socket to a server-side group. */
  joinGroup(group: string): void;
  leaveGroup(group: string): void;
  /** The id the server assigned this connection ("" until `welcome` arrives). */
  readonly clientId: string;
  /** Server-side groups this client belongs to ([] until `welcome` arrives). */
  readonly groups: string[];
}

export function createClient<B extends Bindings = DefaultBindings>(
  url: string,
  opts: IgnClientOptions<B> = {},
): IgnClient<B> {
  const state: ClientState = createClientState(url, opts);

  function connect(): IgnClient<B> {
    // idempotent: an already-open / opening socket is never leaked or replaced
    if (state.ws !== null) {
      const ready = state.ws.readyState;
      if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return api;
    }
    state.closed = false;
    setStatus(state, state.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    // ownership guard: once a NEWER socket occupies `state.ws`, callbacks from
    // this (stale) socket must not touch shared state or reschedule reconnects
    const ownsState = (): boolean => state.ws === null || state.ws === ws;
    ws.onopen = () => {
      if (!ownsState()) return;
      state.attempts = 0;
      setStatus(state, "connected");
      state.resumeInFlight = false;
      if (state.gapTimer !== null) {
        clearTimeout(state.gapTimer);
        state.gapTimer = null;
      }
      // carry the last contiguous delivery seq so a resume-capable server can
      // re-send what this session missed (cross-session resume)
      sendControl(state, "hello", {
        version: state.bindings.wireVersion,
        caps: [],
        lastSeq: state.resume.enabled ? state.rxSeq : 0,
      });
      // re-subscribe topics from before the disconnect (server cleared them)
      for (const t of state.subscribedTopics) sendControl(state, "subscribe", { topic: t });
      // deliver app events that were sent before the socket was open (send()
      // queues by default — no need to wait for the connected status)
      flushPendingSends(state);
      startHeartbeat(state);
    };
    ws.onmessage = (ev) => {
      if (!ownsState()) return;
      handleMessage(state, ev.data as ArrayBuffer | string);
    };
    ws.onerror = () => {
      // surface refused upgrades / transport failures (onclose follows and
      // drives the reconnect state machine — no double scheduling here)
      if (!ownsState()) return;
      emitError(state, new Error("ignex: connection error"));
    };
    ws.onclose = () => {
      if (!ownsState()) return; // replaced by a newer socket — its lifecycle wins
      stopHeartbeat(state);
      state.ws = null;
      state.resumeInFlight = false;
      flushPending(state); // accept in-flight gap loss; hello carries rxSeq on reconnect
      if (state.closed) {
        setStatus(state, "closed");
        return;
      }
      scheduleReconnect(state, connect);
    };
    state.ws = ws;
    return api;
  }

  const api: IgnClient<B> = {
    on(name, handler) {
      let set = state.handlers.get(name);
      if (!set) {
        set = new Set();
        state.handlers.set(name, set);
      }
      set.add(handler as (payload: unknown) => void);
      return api;
    },
    off(name, handler) {
      state.handlers.get(name)?.delete(handler as (payload: unknown) => void);
      return api;
    },
    once(name, handler) {
      const wrap = (payload: unknown): void => {
        api.off(name, wrap as never);
        (handler as (payload: unknown) => void)(payload);
      };
      api.on(name, wrap as never);
      return api;
    },
    onAny(cb) {
      state.anyHandlers.add(cb as (name: string, payload: unknown) => void);
      return api;
    },
    offAny(cb) {
      state.anyHandlers.delete(cb as (name: string, payload: unknown) => void);
      return api;
    },
    events() {
      return [...state.handlers.keys()] as EventNameOf<B>[];
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
      if (state.gapTimer !== null) {
        clearTimeout(state.gapTimer);
        state.gapTimer = null;
      }
      state.pending.clear();
      state.pendingFrom = 0;
      state.pendingSends = []; // never delivered — drop the queued app frames
      failAllPending(state, new Error("ignex: client closed"));
      state.ws?.close();
      state.ws = null;
      setStatus(state, "closed");
    },
    send(name, payload) {
      sendFrameQueued(state, state.bindings.encodeFrame(name, payload));
    },
    request(name, payload, opts) {
      return createRpcRequest(
        state,
        name,
        payload,
        opts,
        state.bindings,
      ) as Promise<RpcResult<EventsOf<B>[typeof name]>>;
    },
    subscribe(topic) {
      state.subscribedTopics.add(topic);
      sendControl(state, "subscribe", { topic });
    },
    unsubscribe(topic) {
      state.subscribedTopics.delete(topic);
      sendControl(state, "unsubscribe", { topic });
    },
    snapshotRequest(topic, fromSeq = 0) {
      sendControl(state, "snapshotRequest", { topic, fromSeq });
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
