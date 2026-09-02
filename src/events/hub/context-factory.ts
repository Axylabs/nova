/**
 * Context factory — builds and CACHES the {@link EventContext} handed to
 * handlers.
 *
 * Contexts are CACHED (instantiation-time work, not per-event work): every
 * EventContext is immutable and its closures are bound to the stable hub API,
 * so one context per client record + one shared context per client-less
 * source is built once and reused — dispatching an event allocates nothing.
 *
 * The hub reference is injected lazily (`getHub`) because the factory is
 * constructed before the hub API object exists.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings } from "../../bindings/types";
import type { WsData } from "../../core/state";
import type { EventClient, EventContext, EventSource } from "../types";

export interface ContextFactory<B extends Bindings> {
  /** context for a client-sent event (cached per client record) */
  forClient(client: EventClient): EventContext<B>;
  /** full form: explicit client + source (client-less sources share one ctx) */
  make(client: EventClient | undefined, source: EventSource): EventContext<B>;
}

export function createContextFactory<B extends Bindings>(deps: {
  server: IgnServerOf<B>;
  getHub: () => EventsHubOf<B>;
}): ContextFactory<B> {
  const { server, getHub } = deps;

  /** Assemble a fresh context bound to the stable hub API. */
  const buildCtx = (client: EventClient | undefined, source: EventSource): EventContext<B> => {
    const hub = getHub();
    const ctx: EventContext<B> = {
      source,
      hub,
      server,
      emit: (name, payload, target) => hub.emit(name as never, payload as never, target),
      emitToGroup: (group, name, payload) => hub.emitToGroup(group, name as never, payload as never),
      emitToUser: (userId, name, payload) => hub.emitToUser(userId, name as never, payload as never),
      emitToUserAnywhere: (userId, name, payload) =>
        hub.emitToUserAnywhere(userId, name as never, payload as never),
      emitToClient: (clientId, name, payload) =>
        hub.emitToClient(clientId, name as never, payload as never),
      emitToTopic: (topic, name, payload) => hub.emitToTopic(topic, name as never, payload as never),
      ...(client ? { client } : {}),
    };
    return ctx;
  };

  // caches: per-client contexts + one shared context per client-less source
  const ctxByClient = new WeakMap<object, EventContext<B>>();
  const sharedCtxs = new Map<EventSource, EventContext<B>>();

  return {
    forClient(client) {
      let ctx = ctxByClient.get(client);
      if (ctx === undefined) {
        ctx = buildCtx(client, "client");
        ctxByClient.set(client, ctx);
      }
      return ctx;
    },
    make(client, source) {
      if (client === undefined) {
        let shared = sharedCtxs.get(source);
        if (shared === undefined) {
          shared = buildCtx(undefined, source);
          sharedCtxs.set(source, shared);
        }
        return shared;
      }
      return this.forClient(client);
    },
  };
}

/** Structural stand-ins to keep this module free of circular type imports. */
type IgnServerOf<B extends Bindings> = import("../../core/server").IgnServer<B>;
type EventsHubOf<B extends Bindings> = import("../types").EventsHub<B>;
export type HubSocket = ServerWebSocket<WsData>;
