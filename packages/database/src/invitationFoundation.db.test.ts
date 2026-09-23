import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";
import {
  invitation,
  invitationAccessChallenge,
  invitationGuest,
  invitationRateLimitEvent,
  site,
} from "./schema";

const fixturePrefix = `t1-invitation-${process.pid}-${randomUUID()}`;
const siteId = `${fixturePrefix}-site`;
const secondSiteId = `${fixturePrefix}-other-site`;
const invitationId = `${fixturePrefix}-invitation`;
const duplicateInvitationId = `${fixturePrefix}-duplicate`;
const internationalInvitationId = `${fixturePrefix}-international`;
const guestId = `${fixturePrefix}-guest`;
const childGuestId = `${fixturePrefix}-child`;

let connection: DatabaseConnection;

describe("invitation database foundation", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(site).values([
      {
        id: siteId,
        repositorySlug: siteId,
        provisioningKey: `${siteId}:provision`,
        displayName: "Invitation fixture",
        partnerOneName: "Ana",
        partnerTwoName: "João",
        eventDate: "2027-05-22",
      },
      {
        id: secondSiteId,
        repositorySlug: secondSiteId,
        provisioningKey: `${secondSiteId}:provision`,
        displayName: "Other invitation fixture",
        partnerOneName: "Bia",
        partnerTwoName: "Caio",
        eventDate: "2027-05-23",
      },
    ]);
  });

  afterAll(async () => {
    await connection.db
      .delete(invitationRateLimitEvent)
      .where(eq(invitationRateLimitEvent.id, `${fixturePrefix}-lookup-event`));
    await connection.db
      .delete(invitation)
      .where(eq(invitation.id, invitationId));
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(site).where(eq(site.id, secondSiteId));
    await connection.close();
  });

  it("stores multiple explicit guest types and protects invitation PIN seed", async () => {
    await connection.db.transaction(async (tx) => {
      await tx.insert(invitation).values({
        id: invitationId,
        siteId,
        name: "Família Silva",
        normalizedName: "familia silva",
        phoneE164: "+5511999999999",
        email: "ana@example.test",
      });
      await tx.insert(invitationGuest).values([
        {
          id: guestId,
          siteId,
          invitationId,
          fullName: "Ana Silva",
          normalizedName: "ana silva",
          guestType: "ADULT",
        },
        {
          id: childGuestId,
          siteId,
          invitationId,
          fullName: "Bia Silva",
          normalizedName: "bia silva",
          guestType: "CHILD",
        },
      ]);
    });

    const [storedInvitation] = await connection.db
      .select({
        siteId: invitation.siteId,
        manualPinSeed: invitation.manualPinSeed,
      })
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    expect(storedInvitation?.siteId).toBe(siteId);
    expect(storedInvitation?.manualPinSeed).toMatch(/^[a-f0-9]{64}$/);

    const guests = await connection.db
      .select({ guestType: invitationGuest.guestType })
      .from(invitationGuest)
      .where(eq(invitationGuest.invitationId, invitationId));
    expect(guests.map((guest) => guest.guestType).sort()).toEqual([
      "ADULT",
      "CHILD",
    ]);
  });

  it("requires a guest at commit and keeps phone unique per site", async () => {
    await expect(
      connection.db.transaction(async (tx) => {
        await tx.insert(invitation).values({
          id: `${fixturePrefix}-empty`,
          siteId,
          name: "Empty invitation",
          normalizedName: "empty invitation",
          phoneE164: "+5511888888888",
        });
      }),
    ).rejects.toThrow();

    await expect(
      connection.db.transaction(async (tx) => {
        await tx.insert(invitation).values({
          id: duplicateInvitationId,
          siteId,
          name: "Duplicate phone",
          normalizedName: "duplicate phone",
          phoneE164: "+5511999999999",
        });
        await tx.insert(invitationGuest).values({
          id: `${fixturePrefix}-duplicate-guest`,
          siteId,
          invitationId: duplicateInvitationId,
          fullName: "Outra pessoa",
          normalizedName: "outra pessoa",
          guestType: "ADULT",
        });
      }),
    ).rejects.toThrow();

    await connection.db.transaction(async (tx) => {
      await tx.insert(invitation).values({
        id: internationalInvitationId,
        siteId: secondSiteId,
        name: "International invitation",
        normalizedName: "international invitation",
        phoneE164: "+14155552671",
      });
      await tx.insert(invitationGuest).values({
        id: `${fixturePrefix}-international-guest`,
        siteId: secondSiteId,
        invitationId: internationalInvitationId,
        fullName: "Alex Smith",
        normalizedName: "alex smith",
        guestType: "ADULT",
      });
    });

    await expect(
      connection.db.insert(invitation).values({
        id: `${fixturePrefix}-invalid-phone`,
        siteId,
        name: "Invalid phone",
        normalizedName: "invalid phone",
        phoneE164: "not-e164",
      }),
    ).rejects.toThrow();
  });

  it("enforces challenge lifetime and supports invitation-independent lookup limits", async () => {
    const createdAt = new Date("2026-09-11T12:00:00.000Z");
    await expect(
      connection.db.insert(invitationAccessChallenge).values({
        id: `${fixturePrefix}-long-challenge`,
        siteId,
        invitationId,
        phoneE164: "+5511999999999",
        createdAt,
        expiresAt: new Date("2026-09-11T12:10:00.001Z"),
      }),
    ).rejects.toThrow();

    await connection.db.insert(invitationRateLimitEvent).values({
      id: `${fixturePrefix}-lookup-event`,
      siteId,
      invitationId: null,
      action: "LOOKUP",
      scopeKey: "a".repeat(64),
      ipFingerprint: "b".repeat(64),
      occurredAt: createdAt,
    });
  });
});
