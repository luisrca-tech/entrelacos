import { describe, expect, it } from "vitest";
import { PublicMessageRequestRateLimiter } from "./publicMessageRequestRateLimit";

describe("public message request rate limiter", () => {
  it("allows 30 requests per IP in a minute and reports the remaining window", () => {
    const limiter = new PublicMessageRequestRateLimiter();
    const now = new Date("2029-01-10T12:00:00.000Z");

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter.consume("fingerprint-a", now).allowed).toBe(true);
    }

    expect(limiter.consume("fingerprint-a", now)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(
      limiter.consume("fingerprint-a", new Date(now.getTime() + 60_000)),
    ).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("keeps a hard bound on stored IP windows", () => {
    const limiter = new PublicMessageRequestRateLimiter({ maxEntries: 2 });
    const now = new Date("2029-01-10T12:00:00.000Z");

    limiter.consume("fingerprint-a", now);
    limiter.consume("fingerprint-b", now);
    limiter.consume("fingerprint-c", now);

    expect(limiter.size).toBe(2);
  });
});
