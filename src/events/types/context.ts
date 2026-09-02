/**
 * Event context + handler types — what every hub handler receives.
 *
 * Type-only module (part of the `src/events/types` barrel). Contexts are
 * built (and cached) by `src/events/hub/context-factory.ts`.
 */
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../../bindings/types";
import type { IgnServer } from "../../core/server";
import type { EmitTarget } from "./emit-target";
import type { EventClient } from "./client";
import type { EventsHub } from "./hub";

/** Where an event reached the hub from. */
export type EventSource = "client" | "remote" | "bridge";

/**
 * The context every handler receives — the "who / where / how do I reply"
 * bundle. For client-sent events `client` is the sender's record; for
 * server-side events (`onServerEvent`) there is no sender client.
 */
export interface EventContext<B extends Bindings = DefaultBindings> {
  /** where the event came from: a local client, another instance, or the bridge */
  readonly source: EventSource;
  /** the client that sent the event (undefined for remote/bridge events) */
  readonly client?: EventClient;
  /** cross-instance trace id (remote/bridge events; undefined when absent) */
  readonly traceId?: string;
  /** the events hub (for `hub.emit`, groups, client data, …) */
  readonly hub: EventsHub<B>;
  /** the underlying server (raw `publish`/`publishToClient`/… escape hatch) */
  readonly server: IgnServer<B>;
  /** emit helpers bound to this hub (reply without importing the singleton) */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K], target?: EmitTarget): void;
  emitToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  emitToUser<K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]): void;
  /** Deliver to the user on every instance/service in the cluster mesh. */
  emitToUserAnywhere<K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToClient<K extends EventNameOf<B>>(clientId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
}

/** A handler registered on the hub (client-sent events). May be async. */
export type EventHandler<B extends Bindings, K extends EventNameOf<B>> = (
  payload: EventsOf<B>[K],
  ctx: EventContext<B>,
) => void | Promise<void>;

/** A handler for server-side events (remote instances / bridge inbound). */
export type ServerEventHandler<B extends Bindings, K extends EventNameOf<B>> = (
  payload: EventsOf<B>[K],
  ctx: EventContext<B>,
) => void | Promise<void>;
