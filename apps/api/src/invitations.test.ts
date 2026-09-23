import { describe, expect, it } from "vitest";
import {
  deriveInvitationAccessPin,
  InvitationServiceError,
  normalizeInvitationName,
} from "./invitations";

describe("invitation identity helpers", () => {
  it("normalizes names for stable identity comparisons", () => {
    expect(normalizeInvitationName("  Família   Silva ")).toBe("familia silva");
  });

  it("derives a stable six-digit PIN scoped to site and invitation", () => {
    const seed = "a".repeat(64);
    const secret = "invitation-pin-secret-with-at-least-32-characters";
    const pin = deriveInvitationAccessPin("site-1", "invite-1", seed, secret);

    expect(pin).toMatch(/^\d{6}$/);
    expect(deriveInvitationAccessPin("site-1", "invite-1", seed, secret)).toBe(
      pin,
    );
    expect(
      deriveInvitationAccessPin("site-2", "invite-1", seed, secret),
    ).not.toBe(pin);
  });

  it("rejects unsafe PIN configuration", () => {
    expect(() =>
      deriveInvitationAccessPin("site-1", "invite-1", "bad-seed", "short"),
    ).toThrow(InvitationServiceError);
  });
});
