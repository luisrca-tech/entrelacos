import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";
import {
  adminAccessToken,
  site,
  siteMembership,
  siteTerm,
  user,
} from "./schema";

const fixturePrefix = `t3-schema-${process.pid}-${randomUUID()}`;
const siteId = `${fixturePrefix}-site`;
const secondSiteId = `${fixturePrefix}-site-2`;
const userId = `${fixturePrefix}-user`;
const otherUserId = `${fixturePrefix}-other-user`;
const membershipId = `${fixturePrefix}-membership`;
const secondMembershipId = `${fixturePrefix}-membership-2`;
const tokenId = `${fixturePrefix}-token`;

let connection: DatabaseConnection;

async function insertSite(id: string) {
  await connection.db.insert(site).values({
    id,
    repositorySlug: id,
    provisioningKey: `${id}:provision`,
    displayName: "Schema fixture",
    partnerOneName: "Ana",
    partnerTwoName: "João",
    eventDate: "2027-05-22",
  });
}

describe("Block 2 database constraints", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(user).values([
      {
        id: userId,
        name: "Schema Fixture",
        email: `${userId}@example.test`,
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
      {
        id: otherUserId,
        name: "Other Fixture",
        email: `${otherUserId}@example.test`,
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    ]);
    await insertSite(siteId);
    await insertSite(secondSiteId);
    await connection.db.insert(siteMembership).values({
      id: membershipId,
      siteId,
      userId,
    });
  });

  afterAll(async () => {
    await connection.db
      .delete(adminAccessToken)
      .where(eq(adminAccessToken.id, tokenId));
    await connection.db.delete(siteTerm).where(eq(siteTerm.siteId, siteId));
    await connection.db
      .delete(siteMembership)
      .where(eq(siteMembership.id, membershipId));
    await connection.db
      .delete(siteMembership)
      .where(eq(siteMembership.id, secondMembershipId));
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(site).where(eq(site.id, secondSiteId));
    await connection.db.delete(user).where(eq(user.id, userId));
    await connection.db.delete(user).where(eq(user.id, otherUserId));
    await connection.close();
  });

  it("enforces one site membership per user and binds tokens to that membership", async () => {
    await expect(
      connection.db.insert(siteMembership).values({
        id: secondMembershipId,
        siteId: secondSiteId,
        userId,
      }),
    ).rejects.toThrow();

    const [insertedToken] = await connection.db
      .insert(adminAccessToken)
      .values({
        id: tokenId,
        userId,
        siteId,
        purpose: "ACTIVATION",
        tokenHash: "a".repeat(64),
        expiresAt: new Date("2026-09-12T12:00:00.000Z"),
        createdAt: new Date("2026-09-11T12:00:00.000Z"),
      })
      .returning({
        id: adminAccessToken.id,
        tokenHash: adminAccessToken.tokenHash,
      });
    expect(insertedToken).toEqual({ id: tokenId, tokenHash: "a".repeat(64) });

    await expect(
      connection.db.insert(adminAccessToken).values({
        id: `${tokenId}-mismatch`,
        userId: otherUserId,
        siteId,
        purpose: "ACTIVATION",
        tokenHash: "a".repeat(64),
        expiresAt: new Date("2026-09-12T12:00:00.000Z"),
        createdAt: new Date("2026-09-11T12:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });

  it("rejects an inactive site without previous lifecycle and reverses term dates", async () => {
    await expect(
      connection.db
        .update(site)
        .set({ lifecycle: "INACTIVE" })
        .where(eq(site.id, siteId)),
    ).rejects.toThrow();

    await expect(
      connection.db.insert(siteTerm).values({
        id: `${fixturePrefix}-term`,
        siteId,
        startsOn: "2028-01-01",
        endsOn: "2027-01-01",
        approvedAt: new Date("2026-09-11T12:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });
});
