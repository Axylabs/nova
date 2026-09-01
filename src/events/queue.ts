/**
 * Offload task queue — a small bounded worker pool that keeps ALL non-essential
 * work (cluster publishes, Redis/state-store writes, presence maintenance) off
 * the WebSocket hot path.
 *
 * Contract:
 *   - `enqueue` is O(1) and never throws; when the queue is full (over
 *     `maxPending`) the NEWEST task is dropped and counted (`drop-newest` —
 *     fresher state is more valuable than stale queued work).
 *   - Tasks may be async; workers await them with bounded concurrency
 *     (`workers`), so one slow Redis call can't stall the loop.
 *   - Errors are caught per task, counted, and forwarded to `onError`
 *     (default: nothing) — a failing task never takes the process down and
 *     never breaks the caller's hot path.
 *   - `close()` stops accepting; `drain()` resolves once queued + in-flight
 *     work has completed (used by graceful shutdown).
 *
 * Efficiency: storage is a pre-allocated {@link RingBuffer} (O(1) push/shift,
 * no `Array.shift` memmove while saturated) and IDLE WORKERS PARK on a
 * promise — zero timers, zero `setImmediate` spins, zero CPU while idle.
 * `enqueue` wakes exactly one parked worker; completion notifications drive
 * `drain()`.
 */
import { RingBuffer } from "../core/ring";

export interface TaskQueue {
  readonly pending: number;
  enqueue(task: () => void | Promise<void>): void;
  drain(): Promise<void>;
  close(): void;
  stats(): { queued: number; processed: number; dropped: number; errors: number };
}

export interface TaskQueueOptions {
  /** concurrent workers, default 2 */
  workers?: number;
  /** max queued tasks before drop-newest, default 4096 */
  maxPending?: number;
  onError?: (err: Error) => void;
}

export function createTaskQueue(opts: TaskQueueOptions = {}): TaskQueue {
  const workersN = Math.max(1, opts.workers ?? 2);
  const maxPending = Math.max(1, opts.maxPending ?? 4096);
  const onError = opts.onError;
  const tasks = new RingBuffer<() => void | Promise<void>>(Math.min(maxPending, 64));
  let queued = 0;
  let processed = 0;
  let dropped = 0;
  let errors = 0;
  let inflight = 0;
  let stopping = false;

  // parked-worker wakeups: enqueue resolves one sleeper; close resolves all
  const sleepers: Array<() => void> = [];
  const park = (): Promise<void> => new Promise((resolve) => sleepers.push(resolve));
  const wakeOne = (): void => {
    const w = sleepers.shift();
    if (w !== undefined) w();
  };
  const wakeAll = (): void => {
    while (sleepers.length > 0) sleepers.shift()!();
  };

  // drain notification: resolved once the queue AND in-flight work hit zero
  const drainWaiters: Array<() => void> = [];
  const notifyIdle = (): void => {
    if (drainWaiters.length === 0 || tasks.length > 0 || inflight > 0) return;
    const waiters = drainWaiters.splice(0, drainWaiters.length);
    for (const w of waiters) w();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = tasks.shift();
      if (task === undefined) {
        if (stopping) return;
        await park(); // parked — no CPU while idle
        continue;
      }
      inflight++;
      try {
        await task();
        processed++;
      } catch (err) {
        errors++;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inflight--;
      }
      notifyIdle();
    }
  };

  for (let i = 0; i < workersN; i++) void worker();

  return {
    get pending(): number {
      return tasks.length + inflight;
    },
    enqueue(task) {
      if (stopping) return;
      if (tasks.length >= maxPending) {
        dropped++;
        return;
      }
      tasks.push(task);
      queued++;
      wakeOne();
    },
    drain() {
      if (tasks.length === 0 && inflight === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
    close() {
      stopping = true;
      wakeAll(); // let parked workers see `stopping` and exit
    },
    stats() {
      return { queued, processed, dropped, errors };
    },
  };
}
