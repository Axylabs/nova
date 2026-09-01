/**
 * Handler registry — the "events file receives events" core. An ordered,
 * multi-handler-per-event registry with per-handler error isolation:
 * one throwing handler never prevents the others, and every failure is
 * counted (surfaced via `hub.metrics().handlerErrors`).
 *
 * Supports `on` / `off` / `once` / `onAny` / `removeAllListeners` and a
 * separate server-event registry (`onServerEvent`) for events that arrive
 * from other instances or the NATS bridge.
 *
 * The registry is BINDINGS-AGNOSTIC: names and payloads are `unknown` here,
 * and the `ctx` is passed through opaquely (the hub types it as
 * `EventContext<B>` at the boundary).
 *
 * Dispatch is ALLOCATION-FREE by construction (copy-on-write): handler lists
 * are plain arrays that are REPLACED on every mutation (`on`/`off`/`once`),
 * so `dispatch` iterates its snapshot directly — no `[...set]` copies on the
 * per-event hot path, and a handler that subscribes/unsubscribes mid-dispatch
 * can never corrupt the in-flight iteration.
 */

/** Opaque context — the hub hands a typed `EventContext<B>` through. */
export type DispatchContext = unknown;

type AnyHandler = (payload: unknown, ctx: DispatchContext) => void | Promise<void>;

export interface HandlerRegistry {
  on(name: string, handler: AnyHandler): void;
  off(name: string, handler?: AnyHandler): void;
  once(name: string, handler: AnyHandler): void;
  onAny(cb: AnyHandler): void;
  offAny(cb: AnyHandler): void;
  has(name: string): boolean;
  names(): string[];
  count(name: string): number;
  removeAll(name?: string): void;
  /** dispatch to every handler for `name` + every onAny handler. Isolated. */
  dispatch(name: string, payload: unknown, ctx: DispatchContext): void;
  /**
   * Like `dispatch` / `dispatchServerEvent`, but resolves AFTER every matched
   * handler settled (sync throw caught, async rejection awaited), collecting
   * the errors. Allocation-per-call — used by the reliability layer
   * (`delivery.ts`) for retry/DLQ decisions; the hot path keeps using
   * `dispatch`.
   */
  settleDispatch(name: string, payload: unknown, ctx: DispatchContext, mode?: "client" | "server"): Promise<Error[]>;
  /** register a server-side handler (remote / bridge events only) */
  onServerEvent(name: string, handler: AnyHandler): void;
  offServerEvent(name: string, handler?: AnyHandler): void;
  /** true when a server-event handler exists for `name` (avoids payload decode). */
  wantsServerEvent(name: string): boolean;
  dispatchServerEvent(name: string, payload: unknown, ctx: DispatchContext): void;
  onError(cb: (err: Error, name: string) => void): void;
  /** total handler exceptions since creation */
  readonly errorCount: number;
}

function invoke(handler: AnyHandler, payload: unknown, ctx: DispatchContext, onError: (err: Error) => void): void {
  try {
    const r = handler(payload, ctx);
    if (r && typeof (r as Promise<void>).then === "function") {
      void (r as Promise<void>).catch((err: unknown) => onError(err instanceof Error ? err : new Error(String(err))));
    }
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── copy-on-write list helpers ──────────────────────────────────────────────
// Mutations allocate (the write path); dispatch only reads.

const cowAdd = (arr: AnyHandler[] | undefined, h: AnyHandler): AnyHandler[] =>
  arr === undefined ? [h] : [...arr, h];

const cowRemove = (arr: AnyHandler[] | undefined, h?: AnyHandler): AnyHandler[] | undefined => {
  if (arr === undefined) return undefined;
  if (h === undefined) return undefined; // remove whole list
  const next = arr.filter((x) => x !== h);
  return next.length === 0 ? undefined : next;
};

export function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, AnyHandler[]>();
  let anyHandlers: AnyHandler[] = [];
  const serverHandlers = new Map<string, AnyHandler[]>();
  const errorCbs: Array<(err: Error, name: string) => void> = [];
  let errorCount = 0;

  const report = (err: Error, name: string): void => {
    errorCount++;
    for (const cb of errorCbs) {
      try {
        cb(err, name);
      } catch {
        // error reporters must never break dispatch
      }
    }
  };

  return {
    on(name, handler) {
      handlers.set(name, cowAdd(handlers.get(name), handler));
    },
    off(name, handler) {
      if (!handler) {
        handlers.delete(name);
        return;
      }
      const next = cowRemove(handlers.get(name), handler);
      if (next === undefined) handlers.delete(name);
      else handlers.set(name, next);
    },
    once(name, handler) {
      const wrap: AnyHandler = (payload, ctx) => {
        // remove FIRST so a re-entrant fire cannot invoke it twice
        const cur = handlers.get(name);
        if (cur !== undefined) {
          const next = cowRemove(cur, wrap);
          if (next === undefined) handlers.delete(name);
          else handlers.set(name, next);
        }
        return handler(payload, ctx);
      };
      handlers.set(name, cowAdd(handlers.get(name), wrap));
    },
    onAny(cb) {
      anyHandlers = [...anyHandlers, cb];
    },
    offAny(cb) {
      const next = anyHandlers.filter((x) => x !== cb);
      anyHandlers = next;
    },
    has(name) {
      return handlers.has(name) || anyHandlers.length > 0;
    },
    names() {
      return [...handlers.keys()];
    },
    count(name) {
      return handlers.get(name)?.length ?? 0;
    },
    removeAll(name) {
      if (name) handlers.delete(name);
      else handlers.clear();
    },
    dispatch(name, payload, ctx) {
      const list = handlers.get(name);
      if (list !== undefined) {
        for (let i = 0; i < list.length; i++) {
          const h = list[i];
          if (h !== undefined) invoke(h, payload, ctx, (err) => report(err, name));
        }
      }
      const anys = anyHandlers;
      for (let i = 0; i < anys.length; i++) {
        const h = anys[i];
        if (h === undefined) continue;
        invoke(
          (p) => {
            (h as (n: string, p: unknown, c: DispatchContext) => unknown)(name, p, ctx);
          },
          payload,
          ctx,
          (err) => report(err, name),
        );
      }
    },
    wantsServerEvent(name) {
      return (serverHandlers.get(name)?.length ?? 0) > 0;
    },
    async settleDispatch(name, payload, ctx, mode = "client") {
      const errors: Error[] = [];
      const run = async (h: AnyHandler): Promise<void> => {
        try {
          await h(payload, ctx);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
          report(errors[errors.length - 1]!, name);
        }
      };
      const jobs: Promise<void>[] = [];
      const source = mode === "server" ? serverHandlers.get(name) : handlers.get(name);
      if (source !== undefined) for (const h of source) jobs.push(run(h));
      await Promise.all(jobs);
      return errors;
    },
    onServerEvent(name, handler) {
      serverHandlers.set(name, cowAdd(serverHandlers.get(name), handler));
    },
    offServerEvent(name, handler) {
      if (!handler) {
        serverHandlers.delete(name);
        return;
      }
      const next = cowRemove(serverHandlers.get(name), handler);
      if (next === undefined) serverHandlers.delete(name);
      else serverHandlers.set(name, next);
    },
    dispatchServerEvent(name, payload, ctx) {
      const list = serverHandlers.get(name);
      if (list === undefined) return;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (h !== undefined) invoke(h, payload, ctx, (err) => report(err, name));
      }
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    get errorCount(): number {
      return errorCount;
    },
  };
}
