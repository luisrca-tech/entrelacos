import { createHash, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  account,
  adminAccessToken,
  familyMessage,
  familySession,
  guestGroup,
  guestMember,
  guestRateLimitEvent,
  guestVerificationChallenge,
  guestVerificationSend,
  messageRequestReceipt,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptGroup,
  session,
  site,
  siteDomain,
  siteMembership,
  siteOrigin,
  siteTerm,
  smsSendReservation,
  smsUsage,
  user,
  verification,
} from "@entrelacos/database/schema";
import { asc, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDemoSite } from "./demoReset";
import { normalizeGuestName } from "./guestGroups";
import { lookupGuestGroup } from "./guestLookup";

const prefix = `b7-demo-reset-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-04-01T12:00:00.000Z");
let connection: DatabaseConnection;
let demoSiteId: string;
let sentinelSiteId: string;
const ownerId = `${prefix}-owner`;

function fixtureDigest(label: string): string {
  return createHash("sha256").update(`${prefix}:${label}`).digest("hex");
}

function fixturePhone(sequence: number): string {
  return ["+55", "11", "9", sequence.toString().padStart(8, "0")].join("");
}

async function normalizedSnapshot(siteId: string, userId?: string) {
  const scoped = await Promise.all([
    connection.db.select().from(site).where(eq(site.id, siteId)),
    connection.db
      .select()
      .from(siteOrigin)
      .where(eq(siteOrigin.siteId, siteId)),
    connection.db
      .select()
      .from(siteDomain)
      .where(eq(siteDomain.siteId, siteId)),
    connection.db.select().from(siteTerm).where(eq(siteTerm.siteId, siteId)),
    connection.db
      .select()
      .from(siteMembership)
      .where(eq(siteMembership.siteId, siteId)),
    connection.db
      .select()
      .from(guestGroup)
      .where(eq(guestGroup.siteId, siteId)),
    connection.db
      .select()
      .from(guestMember)
      .where(eq(guestMember.siteId, siteId)),
    connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.siteId, siteId)),
    connection.db
      .select()
      .from(guestVerificationSend)
      .where(eq(guestVerificationSend.siteId, siteId)),
    connection.db
      .select()
      .from(guestRateLimitEvent)
      .where(eq(guestRateLimitEvent.siteId, siteId)),
    connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.siteId, siteId)),
    connection.db
      .select()
      .from(familyMessage)
      .where(eq(familyMessage.siteId, siteId)),
    connection.db
      .select()
      .from(messageRequestReceipt)
      .where(eq(messageRequestReceipt.siteId, siteId)),
    connection.db
      .select()
      .from(rsvpHistory)
      .where(eq(rsvpHistory.siteId, siteId)),
    connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(eq(rsvpRequestReceipt.siteId, siteId)),
    connection.db
      .select()
      .from(rsvpRequestReceiptGroup)
      .where(eq(rsvpRequestReceiptGroup.siteId, siteId)),
    connection.db.select().from(smsUsage).where(eq(smsUsage.siteId, siteId)),
    connection.db
      .select()
      .from(smsSendReservation)
      .where(eq(smsSendReservation.siteId, siteId)),
  ]);
  const identity = userId
    ? await Promise.all([
        connection.db.select().from(user).where(eq(user.id, userId)),
        connection.db.select().from(account).where(eq(account.userId, userId)),
        connection.db.select().from(session).where(eq(session.userId, userId)),
        connection.db
          .select()
          .from(verification)
          .where(eq(verification.identifier, `${userId}@example.test`)),
        connection.db
          .select()
          .from(adminAccessToken)
          .where(eq(adminAccessToken.userId, userId)),
      ])
    : [];
  return [...scoped, ...identity]
    .flat()
    .map((row) => JSON.stringify(row))
    .sort();
}

async function administrativeSnapshot(siteId: string, userId: string) {
  const rows = await Promise.all([
    connection.db
      .select({
        id: site.id,
        repositorySlug: site.repositorySlug,
        provisioningKey: site.provisioningKey,
        displayName: site.displayName,
        partnerOneName: site.partnerOneName,
        partnerTwoName: site.partnerTwoName,
        eventDate: site.eventDate,
        isDemo: site.isDemo,
        publicUrl: site.publicUrl,
        reviewApprovedAt: site.reviewApprovedAt,
        createdAt: site.createdAt,
      })
      .from(site)
      .where(eq(site.id, siteId)),
    connection.db
      .select()
      .from(siteOrigin)
      .where(eq(siteOrigin.siteId, siteId)),
    connection.db
      .select()
      .from(siteDomain)
      .where(eq(siteDomain.siteId, siteId)),
    connection.db.select().from(siteTerm).where(eq(siteTerm.siteId, siteId)),
    connection.db
      .select()
      .from(siteMembership)
      .where(eq(siteMembership.siteId, siteId)),
    connection.db.select().from(user).where(eq(user.id, userId)),
    connection.db.select().from(account).where(eq(account.userId, userId)),
    connection.db.select().from(session).where(eq(session.userId, userId)),
    connection.db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `${userId}@example.test`)),
    connection.db
      .select()
      .from(adminAccessToken)
      .where(eq(adminAccessToken.userId, userId)),
  ]);
  return rows
    .flat()
    .map((row) => JSON.stringify(row))
    .sort();
}

describe("Block 7 deterministic demo reset", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    demoSiteId = `${prefix}-demo`;
    await connection.db.insert(site).values({
      id: demoSiteId,
      repositorySlug: demoSiteId,
      provisioningKey: `${demoSiteId}:key`,
      displayName: "Block 7 Demo",
      partnerOneName: "Ana",
      partnerTwoName: "João",
      eventDate: "2029-06-10",
      lifecycle: "DRAFT",
      publicationState: "UNPUBLISHED",
      isDemo: true,
      muralEnabled: true,
      smsMonthlyLimit: 5,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    sentinelSiteId = `${prefix}-sentinel`;
    await connection.db.insert(site).values({
      id: sentinelSiteId,
      repositorySlug: sentinelSiteId,
      provisioningKey: `${sentinelSiteId}:key`,
      displayName: "Block 7 Sentinel",
      partnerOneName: "Bia",
      partnerTwoName: "Caio",
      eventDate: "2029-06-10",
      lifecycle: "ACTIVE",
      publicationState: "PUBLISHED",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: `${prefix}-sentinel-group`,
        siteId: sentinelSiteId,
        name: "Sentinel Group",
        normalizedName: "sentinel group",
        phoneE164: fixturePhone(99),
        representativeMemberId: `${prefix}-sentinel-member`,
        manualPinSeed: "f".repeat(64),
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
      await tx.insert(guestMember).values({
        id: `${prefix}-sentinel-member`,
        siteId: sentinelSiteId,
        groupId: `${prefix}-sentinel-group`,
        fullName: "Sentinel Guest",
        normalizedName: "sentinel-guest",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
    });
  });

  afterAll(async () => {
    await connection.db.delete(site).where(eq(site.id, demoSiteId));
    await connection.db.delete(site).where(eq(site.id, sentinelSiteId));
    await connection.db.delete(user).where(like(user.id, `${prefix}%`));
    await connection.close();
  });

  it("seeds the frozen dataset and restores the baseline", async () => {
    const clock = { now: () => fixedNow };
    const result = await resetDemoSite(
      connection.db,
      { userId: "owner", role: "OWNER" },
      demoSiteId,
      { clock },
    );

    expect(result).toEqual({
      siteId: demoSiteId,
      datasetVersion: "block7-demo-v1",
      result: "RESET",
      resetAt: fixedNow.toISOString(),
      counts: { groups: 5, members: 10, messages: 1 },
    });
    expect(
      await connection.db
        .select({ id: guestGroup.id })
        .from(guestGroup)
        .where(eq(guestGroup.siteId, demoSiteId)),
    ).toHaveLength(5);
    expect(
      await connection.db
        .select({ id: guestMember.id })
        .from(guestMember)
        .where(eq(guestMember.siteId, demoSiteId)),
    ).toHaveLength(10);
    const seededMembers = await connection.db
      .select({
        fullName: guestMember.fullName,
        normalizedName: guestMember.normalizedName,
      })
      .from(guestMember)
      .where(eq(guestMember.siteId, demoSiteId));
    expect(
      seededMembers.every(
        (member) =>
          member.normalizedName === normalizeGuestName(member.fullName),
      ),
    ).toBe(true);
    const seededGroups = await connection.db
      .select({
        id: guestGroup.id,
        isForeign: guestGroup.isForeign,
        messageRevision: guestGroup.messageRevision,
      })
      .from(guestGroup)
      .where(eq(guestGroup.siteId, demoSiteId))
      .orderBy(asc(guestGroup.id));
    expect(seededGroups).toEqual([
      { id: "b7-group-confirmed", isForeign: false, messageRevision: 0 },
      { id: "b7-group-declined", isForeign: false, messageRevision: 0 },
      { id: "b7-group-foreign", isForeign: true, messageRevision: 0 },
      { id: "b7-group-partial", isForeign: false, messageRevision: 0 },
      { id: "b7-group-pending", isForeign: false, messageRevision: 1 },
    ]);
    expect(
      await connection.db
        .select({ state: guestMember.rsvpState })
        .from(guestMember)
        .where(eq(guestMember.siteId, demoSiteId))
        .orderBy(asc(guestMember.id)),
    ).toEqual([
      { state: "CONFIRMED" },
      { state: "CONFIRMED" },
      { state: "DECLINED" },
      { state: "DECLINED" },
      { state: "PENDING" },
      { state: "CONFIRMED" },
      { state: "PENDING" },
      { state: "CONFIRMED" },
      { state: "PENDING" },
      { state: "PENDING" },
    ]);
    expect(
      await connection.db
        .select({ id: familyMessage.id })
        .from(familyMessage)
        .where(eq(familyMessage.siteId, demoSiteId)),
    ).toEqual([{ id: "b7-message" }]);
    expect(
      await connection.db
        .select({ id: rsvpHistory.id })
        .from(rsvpHistory)
        .where(eq(rsvpHistory.siteId, demoSiteId)),
    ).toEqual([{ id: "b7-rsvp-history" }]);
    expect(
      await connection.db
        .select({
          id: guestVerificationChallenge.id,
          status: guestVerificationChallenge.status,
        })
        .from(guestVerificationChallenge)
        .where(eq(guestVerificationChallenge.siteId, demoSiteId))
        .orderBy(asc(guestVerificationChallenge.id)),
    ).toEqual([
      { id: "b7-challenge-accepted", status: "PENDING" },
      { id: "b7-challenge-locked", status: "LOCKED" },
      { id: "b7-challenge-pending", status: "PENDING" },
      { id: "b7-challenge-unknown", status: "PENDING" },
    ]);
    expect(
      await connection.db
        .select({ id: guestVerificationSend.id })
        .from(guestVerificationSend)
        .where(eq(guestVerificationSend.siteId, demoSiteId)),
    ).toHaveLength(4);
    expect(
      await connection.db
        .select({ id: guestRateLimitEvent.id })
        .from(guestRateLimitEvent)
        .where(eq(guestRateLimitEvent.siteId, demoSiteId)),
    ).toHaveLength(2);
    expect(
      await connection.db
        .select({
          reserved: smsUsage.reserved,
          providerAccepted: smsUsage.providerAccepted,
          failedFinal: smsUsage.failedFinal,
          unknown: smsUsage.unknown,
          consumed: smsUsage.consumed,
        })
        .from(smsUsage)
        .where(eq(smsUsage.siteId, demoSiteId)),
    ).toEqual([
      {
        reserved: 0,
        providerAccepted: 1,
        failedFinal: 1,
        unknown: 1,
        consumed: 3,
      },
    ]);
    expect(
      await connection.db
        .select({ id: smsSendReservation.id })
        .from(smsSendReservation)
        .where(eq(smsSendReservation.siteId, demoSiteId)),
    ).toHaveLength(3);
    const [baseline] = await connection.db
      .select({
        lifecycle: site.lifecycle,
        previousLifecycle: site.previousLifecycle,
        publicationState: site.publicationState,
        isDemo: site.isDemo,
        rsvpDeadlineAt: site.rsvpDeadlineAt,
        rsvpDeadlineTimezone: site.rsvpDeadlineTimezone,
        muralEnabled: site.muralEnabled,
        smsMonthlyLimit: site.smsMonthlyLimit,
      })
      .from(site)
      .where(eq(site.id, demoSiteId));
    expect(baseline).toEqual({
      lifecycle: "ACTIVE",
      previousLifecycle: null,
      publicationState: "PUBLISHED",
      isDemo: true,
      rsvpDeadlineAt: null,
      rsvpDeadlineTimezone: null,
      muralEnabled: false,
      smsMonthlyLimit: null,
    });
    await expect(
      lookupGuestGroup(
        connection.db,
        demoSiteId,
        { fullName: "Paula Pending", phone: fixturePhone(1) },
        {
          ipAddress: "203.0.113.77",
          fingerprintSecret: fixtureDigest("lookup"),
          now: fixedNow,
        },
      ),
    ).resolves.toMatchObject({
      kind: "MATCH",
      siteId: demoSiteId,
      groupId: "b7-group-pending",
      representativeMemberId: "b7-member-pending-1",
    });
  });

  it("rejects non-owner and non-demo targets without changing rows", async () => {
    const before = await normalizedSnapshot(sentinelSiteId);
    await expect(
      resetDemoSite(
        connection.db,
        { userId: "site-admin", role: "SITE_ADMIN" },
        demoSiteId,
        { clock: { now: () => fixedNow } },
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      resetDemoSite(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        sentinelSiteId,
        { clock: { now: () => fixedNow } },
      ),
    ).rejects.toMatchObject({ status: 404, code: "DEMO_SITE_NOT_FOUND" });
    expect(await normalizedSnapshot(sentinelSiteId)).toEqual(before);
  });

  it("preserves administrative identity/configuration, removes residue, and is idempotent", async () => {
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Block 7 Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(account).values({
      id: `${prefix}-account`,
      userId: ownerId,
      accountId: ownerId,
      providerId: "credential",
      password: fixtureDigest("password"),
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(session).values({
      id: `${prefix}-session`,
      userId: ownerId,
      token: fixtureDigest("session-token"),
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60_000),
      createdAt: fixedNow,
      updatedAt: fixedNow,
      lastActiveAt: fixedNow,
    });
    await connection.db.insert(verification).values({
      id: `${prefix}-verification`,
      identifier: `${ownerId}@example.test`,
      value: fixtureDigest("verification-value"),
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60_000),
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(siteMembership).values({
      id: `${prefix}-membership`,
      siteId: demoSiteId,
      userId: ownerId,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(siteOrigin).values({
      id: `${prefix}-origin`,
      siteId: demoSiteId,
      origin: `https://${prefix}.example.test/`,
      createdAt: fixedNow,
    });
    await connection.db.insert(siteDomain).values({
      id: `${prefix}-domain`,
      siteId: demoSiteId,
      hostname: `${prefix}.example.test`,
      state: "ACTIVE",
      isPrimary: true,
      verifiedAt: fixedNow,
      expiresOn: "2029-06-10",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(siteTerm).values({
      id: `${prefix}-term`,
      siteId: demoSiteId,
      startsOn: "2028-01-01",
      endsOn: "2028-12-31",
      approvedAt: fixedNow,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.insert(adminAccessToken).values({
      id: `${prefix}-access-token`,
      userId: ownerId,
      siteId: demoSiteId,
      purpose: "RECOVERY",
      tokenHash: fixtureDigest("admin-access-token"),
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60_000),
      createdAt: fixedNow,
    });
    await connection.db
      .update(site)
      .set({
        lifecycle: "INACTIVE",
        previousLifecycle: "ACTIVE",
        publicationState: "PLACEHOLDER",
        rsvpDeadlineAt: new Date(fixedNow.getTime() + 86_400_000),
        rsvpDeadlineTimezone: "America/Sao_Paulo",
        muralEnabled: true,
        smsMonthlyLimit: 10,
      })
      .where(eq(site.id, demoSiteId));
    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: "b7-old-group",
        siteId: demoSiteId,
        name: "Old Residue",
        normalizedName: "old residue",
        phoneE164: fixturePhone(88),
        representativeMemberId: "b7-old-member",
        manualPinSeed: "8".repeat(64),
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
      await tx.insert(guestMember).values({
        id: "b7-old-member",
        siteId: demoSiteId,
        groupId: "b7-old-group",
        fullName: "Old Residue",
        normalizedName: "old-residue",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
    });

    const protectedBefore = await administrativeSnapshot(demoSiteId, ownerId);
    const sentinelBefore = await normalizedSnapshot(sentinelSiteId);
    let clockCalls = 0;
    const result = await resetDemoSite(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      demoSiteId,
      {
        clock: {
          now: () => {
            clockCalls += 1;
            return fixedNow;
          },
        },
      },
    );
    expect(clockCalls).toBe(1);
    expect(result.counts).toEqual({ groups: 5, members: 10, messages: 1 });
    expect(await administrativeSnapshot(demoSiteId, ownerId)).toEqual(
      protectedBefore,
    );
    expect(await normalizedSnapshot(sentinelSiteId)).toEqual(sentinelBefore);
    expect(
      await connection.db
        .select({ id: guestGroup.id })
        .from(guestGroup)
        .where(eq(guestGroup.id, "b7-old-group")),
    ).toHaveLength(0);

    const canonicalBefore = await normalizedSnapshot(demoSiteId);
    const second = await resetDemoSite(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      demoSiteId,
      { clock: { now: () => fixedNow } },
    );
    expect(second).toEqual(result);
    expect(await normalizedSnapshot(demoSiteId)).toEqual(canonicalBefore);
    expect(await normalizedSnapshot(sentinelSiteId)).toEqual(sentinelBefore);

    const concurrent = await Promise.all([
      resetDemoSite(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        demoSiteId,
        { clock: { now: () => fixedNow } },
      ),
      resetDemoSite(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        demoSiteId,
        { clock: { now: () => fixedNow } },
      ),
    ]);
    expect(concurrent).toEqual([result, result]);
    expect(await normalizedSnapshot(demoSiteId)).toEqual(canonicalBefore);
    expect(await normalizedSnapshot(sentinelSiteId)).toEqual(sentinelBefore);
  });

  it("rolls back deletions and baseline changes when deterministic seeding fails", async () => {
    await connection.db
      .delete(guestGroup)
      .where(eq(guestGroup.id, "b7-group-pending"));
    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: "b7-group-pending",
        siteId: sentinelSiteId,
        name: "Sentinel Collision",
        normalizedName: "sentinel collision",
        phoneE164: fixturePhone(98),
        representativeMemberId: `${prefix}-sentinel-collision-member`,
        manualPinSeed: "7".repeat(64),
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
      await tx.insert(guestMember).values({
        id: `${prefix}-sentinel-collision-member`,
        siteId: sentinelSiteId,
        groupId: "b7-group-pending",
        fullName: "Sentinel Collision Guest",
        normalizedName: "sentinel-collision-guest",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      });
    });

    const demoBefore = await normalizedSnapshot(demoSiteId);
    const sentinelBefore = await normalizedSnapshot(sentinelSiteId);
    await expect(
      resetDemoSite(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        demoSiteId,
        { clock: { now: () => fixedNow } },
      ),
    ).rejects.toThrow();
    expect(await normalizedSnapshot(demoSiteId)).toEqual(demoBefore);
    expect(await normalizedSnapshot(sentinelSiteId)).toEqual(sentinelBefore);

    await connection.db
      .delete(guestGroup)
      .where(eq(guestGroup.id, "b7-group-pending"));
    await resetDemoSite(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      demoSiteId,
      { clock: { now: () => fixedNow } },
    );
  });
});
