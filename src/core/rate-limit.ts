/**
 * Per-connection inbound rate limiting — a token bucket evaluated on EVERY
 * inbound frame (app AND control) before any decode work, so a flooding
 * client pays ~nothing and can't starve the loop.
 *
 * Default OFF (`options.rateLimit` unset → `null`, zero hot-path overhead).
 * When enabled, each connection lazily gets its own limiter on its first
 * inbound frame (no per-connect allocation for idle listeners):
 *
 *   - tokens refill continuously at `messagesPerSecond`;
 *   - bucket capacity is `burst` (default = messagesPerSecond), so short
 *     spikes ride through while sustained floods are shed;
 *   - `policy: "drop"` silently sheds over-limit frames (counted in
 *     `metrics.rateLimited`); `policy: "close"` closes the socket 1008.
 */
export interface RateLimitOptions {
  /** sustained inbound frames per second per connection, default 100 */
  messagesPerSecond?: number;
  /** burst capacity above the sustained rate, default = messagesPerSecond */
  burst?: number;
  /** what happens to over-limit frames, default "drop" */
  policy?: "drop" | "close";
}

/** Fully-resolved options (defaults applied once at server creation). */
export type ResolvedRateLimit = Required<RateLimitOptions>;

export interface RateLimiter {
  readonly policy: "drop" | "close";
  /** Consume one inbound frame; false = over limit. Monotonic `now` (epoch ms). */
  allow(now: number): boolean;
}

const MIN_RATE = 0.001; // guard against a zero refill (permanent lock-up)

/** Apply option defaults once at instantiation time (not per message). */
export function resolveRateLimit(opts?: RateLimitOptions): ResolvedRateLimit | null {
  if (!opts) return null;
  const messagesPerSecond = Math.max(MIN_RATE, opts.messagesPerSecond ?? 100);
  const burst = Math.max(1, opts.burst ?? Math.ceil(messagesPerSecond));
  return { messagesPerSecond, burst, policy: opts.policy ?? "drop" };
}

/**
 * Create one connection's limiter from resolved options. The bucket starts
 * FULL (`burst` tokens) so a well-behaved client is never punished for
 * connecting right after a burst of legitimate traffic.
 */
export function createRateLimiter(r: ResolvedRateLimit): RateLimiter {
  let tokens = r.burst;
  let last = -1; // anchored on the FIRST frame (no pre-first-frame credit)
  return {
    policy: r.policy,
    allow(now: number): boolean {
      if (last < 0) {
        last = now;
      } else if (now > last) {
        // continuous refill since the last consume (clamped to capacity)
        tokens = Math.min(r.burst, tokens + ((now - last) / 1000) * r.messagesPerSecond);
        last = now;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
