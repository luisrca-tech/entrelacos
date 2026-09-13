import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familyMessage,
  familySession,
  guestGroup,
  guestRateLimitEvent,
  guestVerificationChallenge,
  guestVerificationSend,
  messageRequestReceipt,
  rsvpHistory,
  site,
  smsSendReservation,
  smsUsage,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuestGroup, deleteGuestGroup } from "./guestGroups";
import { createSite } from "./sites";

const prefix = `b5-group-delete-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2028-05-01T12:00:00.000Z");
const owner = { userId: "owner", role: "OWNER" as const };

let connection: DatabaseConnection;
let siteId: string;
let groupId: string;
let memberId: string;

describe("group deletion PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const wedding = await createSite(
      connection.db,
      {
        repositorySlug: prefix,
        provisioningKey: `${prefix}:key`,
        displayName: "Group deletion wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      now,
    );
    siteId = wedding.id;
    const group = await createGuestGroup(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      now,
    );
    groupId = group.id;
    memberId = group.members[0]?.id ?? "";
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.close();
  });

  it("rejects a mismatched confirmation without deleting the group", async () => {
    await expect(
      deleteGuestGroup(
        connection.db,
        owner,
        siteId,
        groupId,
        { confirmGroupId: groupId, confirmGroupName: "Wrong name" },
        now,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "GROUP_CONFIRMATION_MISMATCH",
    });

    expect(
      await connection.db
        .select({ id: guestGroup.id })
        .from(guestGroup)
        .where(eq(guestGroup.id, groupId)),
    ).toEqual([{ id: groupId }]);
  });

  it("does not reveal group existence to an unauthorized actor", async () => {
    const unauthorized = {
      userId: `${prefix}-unauthorized`,
      role: "SITE_ADMIN" as const,
    };
    const missingId = `missing-${randomUUID()}`;
    const errors = [];
    for (const targetId of [groupId, missingId]) {
      try {
        await deleteGuestGroup(
          connection.db,
          unauthorized,
          siteId,
          targetId,
          { confirmGroupId: targetId, confirmGroupName: "Família Silva" },
          now,
        );
        errors.push(undefined);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toEqual([
      expect.objectContaining({ status: 404, code: "NOT_FOUND" }),
      expect.objectContaining({ status: 404, code: "NOT_FOUND" }),
    ]);
  });

  it("deletes group-owned rows while retaining site SMS accounting", async () => {
    const sessionId = `${prefix}-family-session`;
    const challengeId = `${prefix}-challenge`;
    const sendId = `${prefix}-send`;
    const rateEventId = `${prefix}-rate-event`;
    const messageId = `${prefix}-message`;
    const messageReceiptId = `${prefix}-message-receipt`;
    const usageId = `${prefix}-usage`;
    const reservationId = `${prefix}-reservation`;
    const messageRequestId = randomUUID();

    await connection.db.transaction(async (tx) => {
      await tx.insert(familySession).values({
        id: sessionId,
        siteId,
        groupId,
        tokenHash: "a".repeat(64),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        createdAt: now,
      });
      await tx.insert(familyMessage).values({
        id: messageId,
        siteId,
        groupId,
        authorMemberId: memberId,
        authorName: "Ana Silva",
        groupName: "Família Silva",
        text: "Mensagem persistida",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(messageRequestReceipt).values({
        id: messageReceiptId,
        siteId,
        groupId,
        sessionId,
        requestId: messageRequestId,
        requestHash: "b".repeat(64),
        revision: 1,
        result: "APPLIED",
        responseBody: { ok: true },
        createdAt: now,
      });
      await tx.insert(rsvpHistory).values({
        id: `${prefix}-history`,
        siteId,
        groupId,
        memberId,
        groupName: "Família Silva",
        memberDisplayName: "Ana Silva",
        beforeState: "PENDING",
        afterState: "CONFIRMED",
        actorType: "ADMIN",
        actorId: "owner",
        actorDisplayName: "Owner",
        occurredAt: now,
      });
      await tx.insert(guestVerificationChallenge).values({
        id: challengeId,
        siteId,
        groupId,
        mode: "MOCK",
        status: "PENDING",
        phoneE164: "+5511999999999",
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        resendAvailableAt: new Date(now.getTime() + 60 * 1000),
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(smsUsage).values({
        id: usageId,
        siteId,
        periodStart: now,
        periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        mode: "SIMULATED",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(smsSendReservation).values({
        id: reservationId,
        siteId,
        usageId,
        mode: "SIMULATED",
        reservedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(guestVerificationSend).values({
        id: sendId,
        siteId,
        groupId,
        challengeId,
        smsReservationId: reservationId,
        phoneE164: "+5511999999999",
        status: "RESERVED",
        reservedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(guestRateLimitEvent).values({
        id: rateEventId,
        siteId,
        groupId,
        action: "LOOKUP",
        scopeKey: `${siteId}:${groupId}`,
        ipFingerprint: "c".repeat(64),
        occurredAt: now,
      });
    });

    await expect(
      deleteGuestGroup(
        connection.db,
        owner,
        siteId,
        groupId,
        { confirmGroupId: groupId, confirmGroupName: "Família Silva" },
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toEqual({ ok: true });

    expect(
      await connection.db
        .select()
        .from(guestGroup)
        .where(eq(guestGroup.id, groupId)),
    ).toHaveLength(0);
    for (const [table, id] of [
      [familySession, sessionId],
      [familyMessage, messageId],
      [messageRequestReceipt, messageReceiptId],
      [rsvpHistory, `${prefix}-history`],
      [guestVerificationChallenge, challengeId],
      [guestVerificationSend, sendId],
      [guestRateLimitEvent, rateEventId],
    ] as const) {
      expect(
        await connection.db.select().from(table).where(eq(table.id, id)),
      ).toHaveLength(0);
    }
    expect(
      await connection.db
        .select({ id: smsUsage.id })
        .from(smsUsage)
        .where(eq(smsUsage.id, usageId)),
    ).toEqual([{ id: usageId }]);
    expect(
      await connection.db
        .select({ id: smsSendReservation.id })
        .from(smsSendReservation)
        .where(eq(smsSendReservation.id, reservationId)),
    ).toEqual([{ id: reservationId }]);
  });

  it("returns the same not-found result for absent and repeated deletion", async () => {
    const missingId = `missing-${randomUUID()}`;
    for (const targetId of [groupId, missingId]) {
      await expect(
        deleteGuestGroup(
          connection.db,
          owner,
          siteId,
          targetId,
          { confirmGroupId: targetId, confirmGroupName: "Família Silva" },
          now,
        ),
      ).rejects.toMatchObject({ status: 404, code: "GROUP_NOT_FOUND" });
    }
  });
});
