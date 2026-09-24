import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  invitation,
  invitationAccessChallenge,
  invitationGuest,
  invitationSession,
} from "./schema";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function invitationMigrationSql(): string {
  return readFileSync(
    join(migrationsDirectory, "0010_invitation_model.sql"),
    "utf8",
  );
}

describe("invitation database schema", () => {
  it("requires one unique per-site E.164 phone and keeps PIN seed on invitation", () => {
    expect(invitation.phoneE164.notNull).toBe(true);
    expect(invitation.email).toBeDefined();
    expect(invitation.manualPinSeed.notNull).toBe(true);
    expect(Object.hasOwn(invitation, "isIndividual")).toBe(false);
    expect(Object.hasOwn(invitation, "isForeign")).toBe(false);
    expect(Object.hasOwn(invitation, "representativeMemberId")).toBe(false);
  });

  it("stores each guest type and RSVP state under an invitation", () => {
    expect(invitationGuest.invitationId.notNull).toBe(true);
    expect(invitationGuest.guestType).toBeDefined();
    expect(invitationGuest.rsvpState).toBeDefined();
    expect(invitationGuest.rsvpRevision).toBeDefined();
    expect(invitationSession.invitationId.notNull).toBe(true);
    expect(invitationAccessChallenge.invitationId.notNull).toBe(true);
  });

  it("refuses to discard existing invitation data and preserves minimum guest invariant", () => {
    const sql = invitationMigrationSql();
    const lockPosition = sql.indexOf('LOCK TABLE "guest_group"');
    expect(lockPosition).toBeGreaterThanOrEqual(0);
    expect(lockPosition).toBeLessThan(sql.indexOf("DO $$"));
    for (const table of [
      "guest_group",
      "guest_member",
      "guest_verification_challenge",
      "guest_rate_limit_event",
      "family_session",
      "family_message",
      "message_request_receipt",
      "rsvp_history",
      "rsvp_request_receipt",
      "rsvp_request_receipt_group",
    ]) {
      expect(sql.slice(lockPosition, sql.indexOf("DO $$"))).toContain(
        `"${table}"`,
      );
      expect(sql).toContain(`IF EXISTS (SELECT 1 FROM "${table}" LIMIT 1)`);
    }
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).toContain("invitation_requires_guest");
    expect(sql).toContain("invitation_guest_requires_parent");
    expect(sql).toContain("invitation_guest_parent_lock");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
  });
});
