import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  guestMember,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptGroup,
  site,
  user,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuestGroup, deleteGuestGroup } from "./guestGroups";
import { writeAdminRsvp } from "./rsvp";
import { createSite } from "./sites";

const prefix = `b5-rsvp-redaction-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2028-05-02T12:00:00.000Z");
const ownerId = `${prefix}-owner`;
const owner = { userId: ownerId, role: "OWNER" as const };

let connection: DatabaseConnection;
let siteId: string;
let removedGroupId: string;
let retainedGroupId: string;
let removedMemberId: string;
let retainedMemberId: string;
let legacyRemovedMemberId: string;

function legacyReceiptReconciliationSql(): string {
  const migration = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/database/migrations/0007_windy_sage.sql",
    ),
    "utf8",
  );
  const statements = migration.match(
    /UPDATE "rsvp_request_receipt" AS receipt[\s\S]+?ON CONFLICT DO NOTHING;/,
  );
  if (!statements)
    throw new Error("Legacy RSVP receipt reconciliation is missing");
  return statements[0].replaceAll("--> statement-breakpoint", "");
}

describe("RSVP receipt redaction PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
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
    const removedGroup = await createGuestGroup(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Removida",
        isForeign: false,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Removida", isRepresentative: true }],
      },
      now,
    );
    removedGroupId = removedGroup.id;
    removedMemberId = removedGroup.members[0]?.id ?? "";
    const retainedGroup = await createGuestGroup(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Mantida",
        isForeign: false,
        phone: "+5511988888888",
        members: [{ fullName: "Bia Mantida", isRepresentative: true }],
      },
      now,
    );
    retainedGroupId = retainedGroup.id;
    retainedMemberId = retainedGroup.members[0]?.id ?? "";
    const legacyRemovedGroup = await createGuestGroup(
      connection.db,
      owner,
      siteId,
      {
        name: "Família Legada",
        isForeign: false,
        phone: "+5511977777777",
        members: [{ fullName: "Caio Legado", isRepresentative: true }],
      },
      now,
    );
    legacyRemovedMemberId = legacyRemovedGroup.members[0]?.id ?? "";
    await deleteGuestGroup(
      connection.db,
      owner,
      siteId,
      legacyRemovedGroup.id,
      {
        confirmGroupId: legacyRemovedGroup.id,
        confirmGroupName: "Família Legada",
      },
      now,
    );
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("redacts affected admin receipts and preserves unaffected replays", async () => {
    const removedRequest = {
      requestId: randomUUID(),
      members: [
        {
          memberId: removedMemberId,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
        {
          memberId: retainedMemberId,
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
      members: [
        {
          memberId: retainedMemberId,
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

    const [removedReceipt] = await connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(
        and(
          eq(rsvpRequestReceipt.siteId, siteId),
          eq(rsvpRequestReceipt.requestId, removedRequest.requestId),
        ),
      );
    expect(removedReceipt).toMatchObject({
      responseStatus: "APPLIED",
      responseBody: removedResult,
    });
    expect(
      await connection.db
        .select()
        .from(rsvpRequestReceiptGroup)
        .where(eq(rsvpRequestReceiptGroup.receiptId, removedReceipt?.id ?? "")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: removedGroupId }),
        expect.objectContaining({ groupId: retainedGroupId }),
      ]),
    );

    await expect(
      deleteGuestGroup(
        connection.db,
        owner,
        siteId,
        removedGroupId,
        {
          confirmGroupId: removedGroupId,
          confirmGroupName: "Família Removida",
        },
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toEqual({ ok: true });

    const [redactedReceipt] = await connection.db
      .select()
      .from(rsvpRequestReceipt)
      .where(eq(rsvpRequestReceipt.id, removedReceipt?.id ?? ""));
    expect(redactedReceipt).toMatchObject({
      requestId: removedRequest.requestId,
      requestHash: removedReceipt?.requestHash,
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
          state: guestMember.rsvpState,
          revision: guestMember.rsvpRevision,
        })
        .from(guestMember)
        .where(eq(guestMember.id, retainedMemberId)),
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

  it("redacts a legacy mixed receipt when one response member was already deleted", async () => {
    const client = await connection.pool.connect();
    const receiptId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO rsvp_request_receipt (
          id, site_id, group_id, scope, actor_type, actor_id, request_id,
          request_hash, response_status, response_body, created_at
        ) VALUES ($1, $2, NULL, 'ADMIN', 'ADMIN', $3, $4, $5, 'APPLIED', $6::jsonb, $7)`,
        [
          receiptId,
          siteId,
          ownerId,
          randomUUID(),
          "a".repeat(64),
          JSON.stringify({
            requestId: randomUUID(),
            replayed: false,
            result: "APPLIED",
            members: [
              { id: retainedMemberId, state: "CONFIRMED", revision: 1 },
              {
                id: legacyRemovedMemberId,
                state: "DECLINED",
                revision: 1,
              },
            ],
          }),
          now,
        ],
      );

      await client.query(legacyReceiptReconciliationSql());

      const receipt = await client.query(
        `SELECT response_status, response_body, removed_at
         FROM rsvp_request_receipt WHERE id = $1`,
        [receiptId],
      );
      expect(receipt.rows[0]).toMatchObject({
        response_status: "REMOVED",
        response_body: null,
      });
      expect(receipt.rows[0]?.removed_at).toBeInstanceOf(Date);
      const links = await client.query(
        `SELECT group_id FROM rsvp_request_receipt_group WHERE receipt_id = $1`,
        [receiptId],
      );
      expect(links.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
