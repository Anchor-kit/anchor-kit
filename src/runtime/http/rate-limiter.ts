interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface InMemoryRateLimiterOptions {
  maxBuckets?: number;
  now?: () => number;
  cleanupIntervalMs?: number;
}

/**
 * In-memory fixed-window limiter. At capacity, expired buckets are removed;
 * if every bucket is still active, new client keys are rejected instead of
 * evicting active keys and silently granting them another window.
 */
export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private readonly cleanupIntervalMs: number;
  private lastCleanupAt: number;

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.maxBuckets = options.maxBuckets ?? 10_000;
    if (!Number.isInteger(this.maxBuckets) || this.maxBuckets < 1) {
      throw new RangeError('maxBuckets must be a positive integer');
    }
    this.now = options.now ?? (() => Date.now());
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    this.lastCleanupAt = this.now();
  }

  private cleanupExpiredBuckets(now: number, force = false): void {
    if (force || now - this.lastCleanupAt > this.cleanupIntervalMs) {
      for (const [key, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(key);
      }
      this.lastCleanupAt = now;
    }
  }

  public hit(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.now();
    this.cleanupExpiredBuckets(now);
    let bucket = this.buckets.get(key);

    if (bucket && now >= bucket.resetAt) {
      bucket = undefined;
    }

    if (!bucket) {
      if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) {
        this.cleanupExpiredBuckets(now, true);
      }

      if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) {
        let earliestResetAt = Number.POSITIVE_INFINITY;
        for (const activeBucket of this.buckets.values()) {
          earliestResetAt = Math.min(earliestResetAt, activeBucket.resetAt);
        }
        const resetSeconds = Math.max(1, Math.ceil((earliestResetAt - now) / 1000));
        return {
          allowed: false,
          retryAfterSeconds: resetSeconds,
          limit: rule.max,
          remaining: 0,
          resetSeconds,
        };
      }

      const createdBucket = {
        count: 1,
        resetAt: now + rule.windowMs,
      };
      this.buckets.set(key, createdBucket);
      const resetSeconds = Math.max(0, Math.ceil((createdBucket.resetAt - now) / 1000));
      return {
        allowed: true,
        retryAfterSeconds: Math.max(1, resetSeconds),
        limit: rule.max,
        remaining: Math.max(0, rule.max - createdBucket.count),
        resetSeconds,
      };
    }

    bucket.count += 1;
    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    const retryAfterSeconds = Math.max(1, resetSeconds);
    if (bucket.count > rule.max) {
      return {
        allowed: false,
        retryAfterSeconds,
        limit: rule.max,
        remaining: 0,
        resetSeconds,
      };
    }

    return {
      allowed: true,
      retryAfterSeconds,
      limit: rule.max,
      remaining: Math.max(0, rule.max - bucket.count),
      resetSeconds,
    };
  }
}
