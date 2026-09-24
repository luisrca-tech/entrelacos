import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitationGuest,
  muralMessage,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptInvitation,
  site,
  user,
} from "@entrelacos/database/schema";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvitation,
  deleteInvitation,
  updateInvitation,
} from "./invitations";
import { writeAdminRsvp } from "./rsvp";
import { createSite } from "./sites";

const prefix = `rsvp-redaction-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2028-05-02T12:00:00.000Z");
const ownerId = `${prefix}-owner`;
const owner = { userId: ownerId, role: "OWNER" as const };

let connection: DatabaseConnection;
let siteId: string;
let removedInvitationId: string;
let retainedInvitationId: string;
let removedGuestId: string;
let retainedGuestId: string;

describe("RSVP receipt redaction PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    await connection.db.insert(user).values({
      id: ownerId,
      name: "RSVP Redaction Owner",
      email: `${ownerId}@example.test`,
      role: "OWNER",
      state: "ACTIVE",
    });
    const wedding = await createSite(
      connection.db,
      {
        repositorySlug: prefix,
        provisioningKey: `${prefix}:key`,
        displayName: "RSVP redaction wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      now,
    );
    siteId = wedding.id;
    const removed = await createInvitation(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Removida",
        phone: "+5511999999999",
        guests: [{ fullName: "Ana Removida", guestType: "ADULT" }],
      },
      now,
    );
    const retained = await createInvitation(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Mantida",
        phone: "+5511988888888",
        guests: [{ fullName: "Bia Mantida", guestType: "ADULT" }],
      },
      now,
    );
    removedInvitationId = removed.id;
    retainedInvitationId = retained.id;
    removedGuestId = removed.guests[0]?.id ?? "";
    retainedGuestId = retained.guests[0]?.id ?? "";
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("redacts mixed admin receipts and preserves unaffected idempotent replays", async () => {
    const muralMessageId = randomUUID();
    await connection.db.insert(muralMessage).values({
      id: muralMessageId,
      siteId,
      authorName: "Convidado independente",
      text: "Felicidades aos noivos!",
      createdAt: now,
    });
    const removedRequest = {
      requestId: randomUUID(),
      guests: [
        {
          guestId: removedGuestId,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
        {
          guestId: retainedGuestId,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
      ],
    };
    const removedResult = await writeAdminRsvp(
      connection.db,
      owner,
      siteId,
      removedRequest,
      now,
    );
    expect(removedResult.result).toBe("APPLIED");

    const retainedRequest = {
      requestId: randomUUID(),
      guests: [
        {
          guestId: retainedGuestId,
          state: "CONFIRMED" as const,
          expectedRevision: 1,
        },
      ],
    };
    const retainedResult = await writeAdminRsvp(
      connection.db,
      owner,
      siteId,
      retainedRequest,
      now,
    );
    expect(retainedResult.result).toBe("NO_CHANGE");

    const [receipt] = await connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(
        and(
          eq(rsvpRequestReceipt.siteId, siteId),
          eq(rsvpRequestReceipt.requestId, removedRequest.requestId),
        ),
      );
    expect(receipt).toMatchObject({
      responseStatus: "APPLIED",
      responseBody: removedResult,
    });
    expect(
      await connection.db
        .select()
        .from(rsvpRequestReceiptInvitation)
        .where(
          and(
            eq(rsvpRequestReceiptInvitation.siteId, siteId),
            eq(rsvpRequestReceiptInvitation.receiptId, receipt?.id ?? ""),
          ),
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invitationId: removedInvitationId }),
        expect.objectContaining({ invitationId: retainedInvitationId }),
      ]),
    );

    await expect(
      deleteInvitation(
        connection.db,
        owner,
        siteId,
        removedInvitationId,
        {
          confirmInvitationId: removedInvitationId,
          confirmInvitationName: "Família Removida",
        },
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toEqual({ ok: true });

    expect(
      await connection.db
        .select({ id: muralMessage.id })
        .from(muralMessage)
        .where(eq(muralMessage.id, muralMessageId)),
    ).toEqual([{ id: muralMessageId }]);

    const [redactedReceipt] = await connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(eq(rsvpRequestReceipt.id, receipt?.id ?? ""));
    expect(redactedReceipt).toMatchObject({
      requestId: removedRequest.requestId,
      requestHash: receipt?.requestHash,
      responseStatus: "REMOVED",
      responseBody: null,
      removedAt: new Date(now.getTime() + 1_000),
    });
    await expect(
      writeAdminRsvp(connection.db, owner, siteId, removedRequest, now),
    ).rejects.toMatchObject({ status: 410, code: "RSVP_RESULT_REMOVED" });

    expect(
      await connection.db
        .select({
          state: invitationGuest.rsvpState,
          revision: invitationGuest.rsvpRevision,
        })
        .from(invitationGuest)
        .where(eq(invitationGuest.id, retainedGuestId)),
    ).toEqual([{ state: "CONFIRMED", revision: 1 }]);
    expect(
      await connection.db
        .select()
        .from(rsvpHistory)
        .where(eq(rsvpHistory.siteId, siteId)),
    ).toHaveLength(1);
    await expect(
      writeAdminRsvp(connection.db, owner, siteId, retainedRequest, now),
    ).resolves.toMatchObject({
      requestId: retainedRequest.requestId,
      replayed: true,
      result: "NO_CHANGE",
    });
  });

  it("tombstones a cached RSVP response when one guest is removed", async () => {
    const record = await createInvitation(
      connection.db,
      owner,
      siteId,
      {
        name: "Convite com ajuste",
        phone: "+5511977777777",
        guests: [
          { fullName: "Convidado removido", guestType: "ADULT" },
          { fullName: "Convidado mantido", guestType: "CHILD" },
        ],
      },
      now,
    );
    const removedId = record.guests[0]?.id ?? "";
    const retained = record.guests[1];
    const request = {
      requestId: randomUUID(),
      guests: [
        {
          guestId: removedId,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
      ],
    };
    await writeAdminRsvp(connection.db, owner, siteId, request, now);

    await updateInvitation(
      connection.db,
      owner,
      siteId,
      record.id,
      {
        guests: [
          {
            id: retained?.id,
            fullName: retained?.fullName ?? "Convidado mantido",
            guestType: "CHILD",
          },
        ],
      },
      new Date(now.getTime() + 1_000),
    );

    const [receipt] = await connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(
        and(
          eq(rsvpRequestReceipt.siteId, siteId),
          eq(rsvpRequestReceipt.requestId, request.requestId),
        ),
      );
    expect(receipt).toMatchObject({
      responseStatus: "REMOVED",
      responseBody: null,
      removedAt: new Date(now.getTime() + 1_000),
    });
    await expect(
      writeAdminRsvp(connection.db, owner, siteId, request, now),
    ).rejects.toMatchObject({ status: 410, code: "RSVP_RESULT_REMOVED" });
  });
});
