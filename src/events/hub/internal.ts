/**
 * Hub internal contracts — the surface the server drives plus the factory
 * options. Not part of the public {@link EventsHub}; consumed by
 * `src/core/server/index.ts` (which attaches/detaches sockets) and by the hub's own
 * composition root.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings } from "../../bindings/types";
import type { NatsBridge } from "../../bridge/nats";
import type { IgnServer } from "../../core/server";
import type { ServerState, WsData } from "../../core/state";
import type { EventClient } from "../types";
import type { EventsHub, EventsOptions } from "../types";

/** Internal surface the server drives (not part of the public `EventsHub`). */
export interface EventsHubInternal<B extends Bindings = DefaultBindings>
  extends EventsHub<B> {
  attach(ws: ServerWebSocket<WsData>): EventClient | undefined;
  detach(ws: ServerWebSocket<WsData>): EventClient | undefined;
  onGroupChange(group: string, ws: ServerWebSocket<WsData>, joined: boolean): void;
  dispatchBridgeInbound(name: string, payload: unknown): void;
}

export interface CreateEventsHubOptions<B extends Bindings> {
  state: ServerState;
  server: IgnServer<B>;
  bindings: Bindings;
  /** the server's own NATS bridge (reused by the cluster when `cluster.nats: true`) */
  serverBridge?: NatsBridge;
  options: EventsOptions<B>;
}
