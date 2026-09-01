/**
 * Scheduled emits — delayed/deferred event delivery with cancellation.
 * Backs `hub.schedule(name, payload, target?, delayMs)` (time-based events:
 * reminder pushes, cooldowns, TTL'd notices).
 *
 * Implementation is a plain per-entry `setTimeout` wheel: scheduling volume in
 * an events hub is human-scale (thousands), where timer accuracy and O(1)
 * cancel beat a heap's memory compactness. Entries are tracked in a Map so
 * `cancel(id)` is exact; `clear()` drops everything (used on close). Timers
 * never reference sockets directly — they call the hub's emit at fire time,
 * so cluster routing / bridge semantics stay identical to a normal emit.
 */

export type EmitFn = (name: string, payload: unknown, target?: unknown) => void;

export interface Scheduler {
  /** schedule one emit; returns its id (cancel with it) */
  schedule(name: string, payload: unknown, target: unknown, delayMs: number): string;
  /** cancel a scheduled emit — true when it had not fired yet */
  cancel(id: string): boolean;
  /** ids currently pending */
  pending(): string[];
  readonly size: number;
  clear(): void;
}

interface Entry {
  timer: ReturnType<typeof setTimeout>;
  name: string;
  payload: unknown;
  target: unknown;
}

export function createScheduler(emit: EmitFn): Scheduler {
  const entries = new Map<string, Entry>();

  const fire = (id: string): void => {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    try {
      emit(e.name, e.payload, e.target);
    } catch {
      // emit must not throw (hub guards this too)
    }
  };

  return {
    schedule(name, payload, target, delayMs) {
      const id = crypto.randomUUID();
      const ms = Math.max(0, delayMs);
      entries.set(id, { name, payload, target, timer: setTimeout(() => fire(id), ms) });
      return id;
    },
    cancel(id) {
      const e = entries.get(id);
      if (!e) return false;
      clearTimeout(e.timer);
      entries.delete(id);
      return true;
    },
    pending() {
      return [...entries.keys()];
    },
    get size(): number {
      return entries.size;
    },
    clear() {
      for (const e of entries.values()) clearTimeout(e.timer);
      entries.clear();
    },
  };
}
