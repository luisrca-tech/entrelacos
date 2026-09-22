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
  messageRequestReceipt,
  rsvpHistory,
  site,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuestGroup, deleteGuestGroup } from "./guestGroups";
import { createSite } from "./sites";

const prefix = `group-delete-${process.pid}-${randomUUID().slice(0, 8)}`;
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

  it("rejects mismatched confirmation without deleting the group", async () => {
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
    await expect(
      connection.db
        .select({ id: guestGroup.id })
        .from(guestGroup)
        .where(eq(guestGroup.id, groupId)),
    ).resolves.toEqual([{ id: groupId }]);
  });

  it("returns the same not-found result for unauthorized existing and absent groups", async () => {
    const unauthorized = {
      userId: `${prefix}-unauthorized`,
      role: "SITE_ADMIN" as const,
    };
    const missingId = `${prefix}-missing`;
    for (const targetId of [groupId, missingId]) {
      await expect(
        deleteGuestGroup(
          connection.db,
          unauthorized,
          siteId,
          targetId,
          { confirmGroupId: targetId, confirmGroupName: "Família Silva" },
          now,
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });

  it("cascades family-owned sessions, content, challenges, and rate-limit rows", async () => {
    const ids = {
      session: `${prefix}-session`,
      message: `${prefix}-message`,
      receipt: `${prefix}-receipt`,
      history: `${prefix}-history`,
      challenge: `${prefix}-challenge`,
      rate: `${prefix}-rate`,
    };
    await connection.db.transaction(async (tx) => {
      await tx.insert(familySession).values({
        id: ids.session,
        siteId,
        groupId,
        tokenHash: "a".repeat(64),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        createdAt: now,
      });
      await tx.insert(familyMessage).values({
        id: ids.message,
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
        id: ids.receipt,
        siteId,
        groupId,
        sessionId: ids.session,
        requestId: randomUUID(),
        requestHash: "b".repeat(64),
        revision: 1,
        result: "APPLIED",
        responseBody: { ok: true },
        createdAt: now,
      });
      await tx.insert(rsvpHistory).values({
        id: ids.history,
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
        id: ids.challenge,
        siteId,
        groupId,
        status: "PENDING",
        phoneE164: "+5511999999999",
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(guestRateLimitEvent).values({
        id: ids.rate,
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
      [familySession, ids.session],
      [familyMessage, ids.message],
      [messageRequestReceipt, ids.receipt],
      [rsvpHistory, ids.history],
      [guestVerificationChallenge, ids.challenge],
      [guestRateLimitEvent, ids.rate],
    ] as const) {
      expect(
        await connection.db.select().from(table).where(eq(table.id, id)),
      ).toHaveLength(0);
    }

    for (const targetId of [groupId, `${prefix}-missing-after-delete`]) {
      await expect(
        deleteGuestGroup(
          connection.db,
          owner,
          siteId,
          targetId,
          { confirmGroupId: targetId, confirmGroupName: "Família Silva" },
          new Date(now.getTime() + 2_000),
        ),
      ).rejects.toMatchObject({ status: 404, code: "GROUP_NOT_FOUND" });
    }
  });
});
