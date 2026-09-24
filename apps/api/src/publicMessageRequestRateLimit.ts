const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 30;
const MAX_ENTRIES = 10_000;

type Window = { startedAt: number; count: number };

export type PublicMessageRateLimitResult =
  | { allowed: true; retryAfterSeconds: 0 }
  | { allowed: false; retryAfterSeconds: number };

export class PublicMessageRequestRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(
    options: {
      limit?: number;
      windowMs?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.limit = options.limit ?? REQUEST_LIMIT;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 1 ||
      !Number.isSafeInteger(this.windowMs) ||
      this.windowMs < 1 ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1
    ) {
      throw new Error("Invalid public message rate limiter configuration");
    }
  }

  get size(): number {
    return this.windows.size;
  }

  consume(
    ipFingerprint: string,
    now = new Date(),
  ): PublicMessageRateLimitResult {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp) || !ipFingerprint) {
      throw new Error("Public message rate limit key and time are required");
    }

    const current = this.windows.get(ipFingerprint);
    if (
      current &&
      timestamp >= current.startedAt &&
      timestamp < current.startedAt + this.windowMs
    ) {
      if (current.count >= this.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.startedAt + this.windowMs - timestamp) / 1000),
          ),
        };
      }
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.windows.delete(ipFingerprint);
    if (this.windows.size >= this.maxEntries) {
      const oldestKey = this.windows.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.windows.delete(oldestKey);
    }
    this.windows.set(ipFingerprint, { startedAt: timestamp, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
