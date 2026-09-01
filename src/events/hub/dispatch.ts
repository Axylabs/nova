/**
 * Handler dispatch — routes an inbound event to the registry, optionally with
 * the reliability layer (retry + DLQ). When no policy is configured this is a
 * plain fire-and-forget dispatch: zero overhead on the hot path.
 */
import type { EventContext } from "../types";
import type { HandlerRegistry } from "../registry";
import {
  deliverWithRetry,
  resolveDeliveryPolicy,
  type DeliveryPolicy,
  type ResolvedDeliveryPolicy,
} from "../delivery";

/** How the hub counts reliability activity (folded into metrics). */
export interface DispatchCounters {
  /** retry schedules by the delivery layer */
  handlerRetries: number;
  /** events dead-lettered after exhausting retries */
  dlqCount: number;
}

/**
 * Build the resolved policy + registry pair used by {@link createDispatcher}.
 * Returns `policy: null` when handlers are unconfigured (plain dispatch).
 */
export function resolveDispatchPolicy(
  opts: DeliveryPolicy | undefined,
  counters: DispatchCounters,
): ResolvedDeliveryPolicy | null {
  if (!opts) return null;
  return resolveDeliveryPolicy({
    ...opts,
    dlq: (info) => {
      counters.dlqCount++;
      opts.dlq?.(info);
    },
  });
}

export interface Dispatcher<B extends import("../../bindings/types").Bindings> {
  /** dispatch a client-sent event */
  client(name: string, payload: unknown, ctx: EventContext<B>): void;
  /** dispatch a server-side event (remote instance / bridge origin) */
  server(name: string, payload: unknown, ctx: EventContext<B>): void;
}

/**
 * Reliability-aware dispatcher. `mode` selects the handler surface
 * (client-sent vs server-side); retries are counted into `counters`.
 */
export function createDispatcher<B extends import("../../bindings/types").Bindings>(deps: {
  registry: HandlerRegistry & { settleDispatch: HandlerRegistry["settleDispatch"] };
  policy: ResolvedDeliveryPolicy | null;
  counters: DispatchCounters;
}): Dispatcher<B> {
  const { registry, policy, counters } = deps;
  const dispatch = (
    name: string,
    payload: unknown,
    ctx: EventContext<B>,
    mode: "client" | "server",
  ): void => {
    if (policy === null) {
      // default: plain dispatch, zero overhead
      if (mode === "server") registry.dispatchServerEvent(name, payload, ctx);
      else registry.dispatch(name, payload, ctx);
      return;
    }
    void deliverWithRetry(
      registry,
      policy,
      name,
      payload,
      ctx,
      () => {
        counters.handlerRetries++;
      },
      mode,
    );
  };
  return {
    client: (name, payload, ctx) => dispatch(name, payload, ctx, "client"),
    server: (name, payload, ctx) => dispatch(name, payload, ctx, "server"),
  };
}
