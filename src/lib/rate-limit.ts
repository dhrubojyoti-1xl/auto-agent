/**
 * A small in-memory limiter for the endpoints that cost real money or real
 * quota: Gmail syncs and AI report generation.
 *
 * It is deliberately not Redis. This is a single-region app on a free plan
 * whose expensive operations are already serialised per user, and the failure
 * this guards against is a manager holding down "Sync now" or a loop in a
 * browser tab — not a distributed attack. Per-instance counters handle that
 * completely, cost nothing, and add no service to operate.
 *
 * The limits are set where a person cannot reach them by working normally.
 * A limiter that interrupts ordinary use is worse than none, because the next
 * thing that happens is somebody removes it.
 */
type Hit = { count: number; resetAt: number };

const buckets = new Map<string, Hit>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const hit = buckets.get(key);

  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep: without it a long-lived instance accumulates one
    // entry per user per endpoint for ever.
    if (buckets.size > 500) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  hit.count++;
  if (hit.count > limit) {
    return {
      ok: false, remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - now) / 1000))
    };
  }
  return { ok: true, remaining: limit - hit.count, retryAfterSeconds: 0 };
}

/** Test seam. */
export function resetRateLimits(): void { buckets.clear(); }

export const LIMITS = {
  /** Reading a mailbox costs Gmail quota and takes real seconds. */
  sync:   { limit: Number(process.env.RATE_LIMIT_SYNC   || 10), windowMs: 60_000 },
  /** Every uncached generation is a paid API call. */
  report: { limit: Number(process.env.RATE_LIMIT_REPORT || 10), windowMs: 60_000 },
  /** Guessing the team password should not be free. */
  login:  { limit: Number(process.env.RATE_LIMIT_LOGIN  || 10), windowMs: 60_000 }
} as const;
