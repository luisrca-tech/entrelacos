import { describe, expect, it } from "vitest";
import {
  hashInvitationSessionToken,
  invitationPinMatches,
  invitationRateLimitScope,
} from "./guestVerification";

describe("invitation access security helpers", () => {
  it("compares valid PIN candidates without accepting different values", () => {
    expect(invitationPinMatches("004218", "004218")).toBe(true);
    expect(invitationPinMatches("004218", "004219")).toBe(false);
    expect(invitationPinMatches("004218", "4218")).toBe(false);
  });

  it("stores only a deterministic SHA-256 digest of session tokens", () => {
    const token = "s".repeat(43);
    const digest = hashInvitationSessionToken(token);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInvitationSessionToken(token)).toBe(digest);
    expect(hashInvitationSessionToken("t".repeat(43))).not.toBe(digest);
  });

  it("isolates access rate limits by site even for the same client IP", () => {
    const first = invitationRateLimitScope(
      "site-one",
      "203.0.113.10",
      "s".repeat(32),
    );
    const second = invitationRateLimitScope(
      "site-two",
      "203.0.113.10",
      "s".repeat(32),
    );

    expect(first).not.toBe(second);
    expect(first).not.toContain("203.0.113.10");
    expect(first).toBe(
      invitationRateLimitScope("site-one", "203.0.113.10", "s".repeat(32)),
    );
  });
});
