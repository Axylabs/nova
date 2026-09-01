/**
 * Handler reliability — retry with backoff + a dead-letter sink for events
 * whose handlers keep failing. Opt-in via
 * `createServer({ events: { handlers: { retries, backoffMs, dlq } } })`.
 *
 * Without `handlers` (the default) dispatch is the plain zero-alloc registry
 * path — this layer is never touched. With it, client / remote / bridge
 * dispatches go through {@link deliverWithRetry}: each attempt uses the
 * registry's settling dispatch so async handler rejections count; failures
 * schedule the next attempt after an exponentially growing delay; exhausting
 * the budget hands the event to `dlq` (dead-letter queue) — by default a
 * counter-only sink.
 */

export type DeadLetterHandler = (info: {
  readonly name: string;
  readonly payload: unknown;
  readonly err: Error;
  readonly attempts: number;
}) => void;

export interface DeliveryPolicy {
  /** retry attempts AFTER the first try (0 = fire once), default 2 */
  retries?: number;
  /** base backoff before the first retry (doubles each attempt), default 100 */
  backoffMs?: number;
  /** called once when all attempts failed */
  dlq?: DeadLetterHandler;
}

export interface ResolvedDeliveryPolicy {
  retries: number;
  backoffMs: number;
  dlq: DeadLetterHandler;
}

export function resolveDeliveryPolicy(opts: DeliveryPolicy = {}): ResolvedDeliveryPolicy {
  return {
    retries: opts.retries ?? 2,
    backoffMs: opts.backoffMs ?? 100,
    dlq:
      opts.dlq ??
      (() => {
        /* counter-only default — surfaced via metrics.dlqCount */
      }),
  };
}

interface SettlingRegistry {
  settleDispatch(name: string, payload: unknown, ctx: unknown, mode?: "client" | "server"): Promise<Error[]>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatch `name` to `registry`, retrying (with doubling backoff) while any
 * handler fails, then dead-lettering. Resolves when the event reached its
 * final state (delivered / dead-lettered). Never throws.
 */
export async function deliverWithRetry(
  registry: SettlingRegistry,
  policy: ResolvedDeliveryPolicy,
  name: string,
  payload: unknown,
  ctx: unknown,
  onRetry?: () => void,
  mode: "client" | "server" = "client",
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const errors = await registry.settleDispatch(name, payload, ctx, mode);
    if (errors.length === 0) return;
    if (attempt >= policy.retries) {
      try {
        policy.dlq({ name, payload, err: errors[errors.length - 1]!, attempts: attempt + 1 });
      } catch {
        // a failing DLQ must never break the caller
      }
      return;
    }
    onRetry?.();
    await sleep(policy.backoffMs * 2 ** attempt);
  }
}
