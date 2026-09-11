import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";
import {
  guestGroup,
  guestMember,
  guestRateLimitEvent,
  guestVerificationChallenge,
  site,
} from "./schema";

const fixturePrefix = `t3-foundation-${process.pid}-${randomUUID()}`;
const siteId = `${fixturePrefix}-site`;
const foreignSiteId = `${fixturePrefix}-other-site`;
const groupId = `${fixturePrefix}-group`;
const memberId = `${fixturePrefix}-member`;
const duplicateGroupId = `${fixturePrefix}-duplicate-group`;
const duplicateMemberId = `${fixturePrefix}-duplicate-member`;
const foreignGroupId = `${fixturePrefix}-foreign-group`;
const foreignMemberId = `${fixturePrefix}-foreign-member`;
const sameNameGroupId = `${fixturePrefix}-same-name-group`;
const sameNameMemberId = `${fixturePrefix}-same-name-member`;

let connection: DatabaseConnection;

describe("Block 3 database foundation", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(site).values([
      {
        id: siteId,
        repositorySlug: siteId,
        provisioningKey: `${siteId}:provision`,
        displayName: "Foundation fixture",
        partnerOneName: "Ana",
        partnerTwoName: "João",
        eventDate: "2027-05-22",
      },
      {
        id: foreignSiteId,
        repositorySlug: foreignSiteId,
        provisioningKey: `${foreignSiteId}:provision`,
        displayName: "Other foundation fixture",
        partnerOneName: "Bia",
        partnerTwoName: "Caio",
        eventDate: "2027-05-23",
      },
    ]);
  });

  afterAll(async () => {
    await connection.db.delete(guestGroup).where(eq(guestGroup.id, groupId));
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(site).where(eq(site.id, foreignSiteId));
    await connection.close();
  });

  it("requires a site-bound group representative member", async () => {
    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: groupId,
        siteId,
        name: "Família Silva",
        normalizedName: "familia silva",
        isForeign: false,
        phoneE164: "+5511999999999",
        representativeMemberId: memberId,
      });
      await tx.insert(guestMember).values({
        id: memberId,
        siteId,
        groupId,
        fullName: "Ana Silva",
        normalizedName: "ana silva",
      });
    });

    const [storedGroup] = await connection.db
      .select({
        siteId: guestGroup.siteId,
        representativeMemberId: guestGroup.representativeMemberId,
      })
      .from(guestGroup)
      .where(eq(guestGroup.id, groupId));
    expect(storedGroup).toEqual({ siteId, representativeMemberId: memberId });

    const [storedSite] = await connection.db
      .select({ isDemo: site.isDemo })
      .from(site)
      .where(eq(site.id, siteId));
    expect(storedSite).toEqual({ isDemo: false });

    await expect(
      connection.db.transaction(async (tx) => {
        await tx.insert(guestGroup).values({
          id: duplicateGroupId,
          siteId,
          name: "Outra família",
          normalizedName: "outra familia",
          isForeign: false,
          phoneE164: "+5511999999999",
          representativeMemberId: duplicateMemberId,
        });
        await tx.insert(guestMember).values({
          id: duplicateMemberId,
          siteId,
          groupId: duplicateGroupId,
          fullName: "Outra pessoa",
          normalizedName: "outra pessoa",
        });
      }),
    ).rejects.toThrow();

    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: foreignGroupId,
        siteId: foreignSiteId,
        name: "Foreign group",
        normalizedName: "foreign group",
        isForeign: true,
        phoneE164: null,
        representativeMemberId: foreignMemberId,
      });
      await tx.insert(guestMember).values({
        id: foreignMemberId,
        siteId: foreignSiteId,
        groupId: foreignGroupId,
        fullName: "Alex Smith",
        normalizedName: "alex smith",
      });
    });

    await expect(
      connection.db.insert(guestMember).values({
        id: `${memberId}-foreign`,
        siteId: foreignSiteId,
        groupId,
        fullName: "Foreign member",
        normalizedName: "foreign member",
      }),
    ).rejects.toThrow();

    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: sameNameGroupId,
        siteId,
        name: "Família Silva",
        normalizedName: "familia silva",
        isForeign: false,
        phoneE164: "+5511988888888",
        representativeMemberId: sameNameMemberId,
      });
      await tx.insert(guestMember).values({
        id: sameNameMemberId,
        siteId,
        groupId: sameNameGroupId,
        fullName: "Ana Silva",
        normalizedName: "ana silva",
      });
    });

    await expect(
      connection.db.insert(guestGroup).values({
        id: `${fixturePrefix}-invalid-foreign-state`,
        siteId,
        name: "Missing phone",
        normalizedName: "missing phone",
        isForeign: false,
        phoneE164: null,
        representativeMemberId: `${fixturePrefix}-missing-member`,
      }),
    ).rejects.toThrow();
  });

  it("enforces the challenge lifetime and permits site-only lookup limits", async () => {
    const createdAt = new Date("2026-09-11T12:00:00.000Z");
    await expect(
      connection.db.insert(guestVerificationChallenge).values({
        id: `${fixturePrefix}-long-challenge`,
        siteId,
        groupId,
        phoneE164: "+5511999999999",
        createdAt,
        expiresAt: new Date("2026-09-11T12:10:00.001Z"),
        resendAvailableAt: new Date("2026-09-11T12:01:00.000Z"),
      }),
    ).rejects.toThrow();

    await connection.db.insert(guestRateLimitEvent).values({
      id: `${fixturePrefix}-lookup-event`,
      siteId,
      groupId: null,
      action: "LOOKUP",
      scopeKey: "a".repeat(64),
      ipFingerprint: "b".repeat(64),
      occurredAt: createdAt,
    });
  });
});
