import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitation,
  invitationGuest,
  invitationMessage,
  invitationSession,
  messageRequestReceipt,
  site,
  user,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashInvitationSessionToken } from "./guestVerification";
import {
  deleteInvitationMessage,
  listSiteMessages,
  readInvitationMessage,
  readPublicMural,
  writeInvitationMessage,
} from "./messages";

const prefix = `invitation-messages-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2029-01-10T12:00:00.000Z");
const siteId = randomUUID();
const invitationId = `${prefix}-invitation`;
const ownerId = `${prefix}-owner`;
const token = "A".repeat(43);
let connection: DatabaseConnection;

describe("invitation messages PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Message Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
    });
    await connection.db.insert(site).values({
      id: siteId,
      repositorySlug: `${prefix}-site`,
      provisioningKey: `${prefix}-site:key`,
      displayName: "Ana & João",
      partnerOneName: "Ana",
      partnerTwoName: "João",
      eventDate: "2030-06-10",
      lifecycle: "ACTIVE",
      muralEnabled: true,
      publicUrl: "https://wedding.example.test/",
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.transaction(async (tx) => {
      await tx.insert(invitation).values({
        id: invitationId,
        siteId,
        name: "Família Silva",
        normalizedName: "família silva",
        phoneE164: "+5511999999999",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(invitationGuest).values({
        id: `${prefix}-guest`,
        siteId,
        invitationId,
        fullName: "João Silva",
        normalizedName: "joão silva",
        guestType: "ADULT",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(invitationSession).values({
        id: `${prefix}-session`,
        siteId,
        invitationId,
        tokenHash: hashInvitationSessionToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      });
    });
  });

  afterAll(async () => {
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("writes one invitation-owned message, replays idempotently, and lists it", async () => {
    const requestId = randomUUID();
    const input = { requestId, expectedRevision: 0, text: "Com carinho" };
    const first = await writeInvitationMessage(
      connection.db,
      token,
      input,
      now,
    );
    expect(first).toMatchObject({
      result: "APPLIED",
      replayed: false,
      message: {
        authorName: "Família Silva",
        invitationName: "Família Silva",
        revision: 1,
      },
    });
    expect(
      await writeInvitationMessage(connection.db, token, input, now),
    ).toMatchObject({
      result: "APPLIED",
      replayed: true,
    });
    await expect(
      writeInvitationMessage(
        connection.db,
        token,
        { ...input, text: "Alterado" },
        now,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(
      await readInvitationMessage(connection.db, token, now),
    ).toMatchObject({
      invitationId,
      currentRevision: 1,
      canEdit: true,
      message: { text: "Com carinho" },
    });
    const admin = await listSiteMessages(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { limit: 10 },
    );
    expect(admin.invitations).toEqual([
      expect.objectContaining({
        invitationId,
        message: expect.objectContaining({ text: "Com carinho" }),
      }),
    ]);
    const mural = await readPublicMural(
      connection.db,
      siteId,
      "https://wedding.example.test",
      { limit: 10 },
    );
    expect(mural.messages).toEqual([
      expect.objectContaining({
        invitationName: "Família Silva",
        text: "Com carinho",
      }),
    ]);
  });

  it("removes the message and tombstones prior write receipts", async () => {
    const result = await deleteInvitationMessage(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      invitationId,
      { expectedRevision: 1 },
      now,
    );
    expect(result).toEqual({ ok: true, currentRevision: 2 });
    expect(
      await connection.db
        .select()
        .from(invitationMessage)
        .where(
          and(
            eq(invitationMessage.siteId, siteId),
            eq(invitationMessage.invitationId, invitationId),
          ),
        ),
    ).toEqual([]);
    const receipts = await connection.db
      .select()
      .from(messageRequestReceipt)
      .where(
        and(
          eq(messageRequestReceipt.siteId, siteId),
          eq(messageRequestReceipt.invitationId, invitationId),
        ),
      );
    expect(receipts).toEqual([
      expect.objectContaining({ result: "REMOVED", responseBody: null }),
    ]);
    const mural = await readPublicMural(
      connection.db,
      siteId,
      "https://wedding.example.test",
      { limit: 10 },
    );
    expect(mural.messages).toEqual([]);
  });
});
