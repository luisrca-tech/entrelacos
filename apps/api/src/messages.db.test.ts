import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  muralMessage,
  muralMessageRateLimitEvent,
  muralMessageRequestReceipt,
  site,
  siteOrigin,
  user,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicSiteMessage,
  deleteSiteMessage,
  listSiteMessages,
  readPublicMural,
} from "./messages";

const prefix = `public-mural-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2029-01-10T12:00:00.000Z");
const siteId = randomUUID();
const ownerId = `${prefix}-owner`;
const outsiderId = `${prefix}-outsider`;
const publicOrigin = `https://${prefix}.example.test`;
const ipFingerprint = "a".repeat(64);
let connection: DatabaseConnection;

function input(requestId: string = randomUUID(), text = "Com carinho") {
  return { requestId, authorName: "Ana Silva", text };
}

describe("public mural PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Mural Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
    });
    await connection.db.insert(user).values({
      id: outsiderId,
      name: "Other Admin",
      email: `${outsiderId}@example.test`,
      emailVerified: true,
      role: "SITE_ADMIN",
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
      publicUrl: `${publicOrigin}/`,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(siteOrigin).values({
      id: `${prefix}-origin`,
      siteId,
      origin: publicOrigin,
    });
  });

  afterAll(async () => {
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, outsiderId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("creates separate posts, replays idempotently, and lists them publicly and in admin", async () => {
    const firstInput = input();
    const first = await createPublicSiteMessage(
      connection.db,
      siteId,
      firstInput,
      ipFingerprint,
      now,
    );
    expect(first).toMatchObject({
      requestId: firstInput.requestId,
      acceptedAt: now.toISOString(),
      replayed: false,
      message: { authorName: "Ana Silva", text: "Com carinho" },
    });

    const replay = await createPublicSiteMessage(
      connection.db,
      siteId,
      firstInput,
      ipFingerprint,
      now,
    );
    expect(replay).toMatchObject({ replayed: true, message: first.message });

    const second = await createPublicSiteMessage(
      connection.db,
      siteId,
      input(randomUUID(), "Também quero deixar uma mensagem"),
      ipFingerprint,
      new Date(now.getTime() + 1_000),
    );
    expect(second.message.authorName).toBe(first.message.authorName);
    expect(second.message.id).not.toBe(first.message.id);

    await expect(
      createPublicSiteMessage(
        connection.db,
        siteId,
        { ...firstInput, text: "Texto diferente" },
        ipFingerprint,
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: "MESSAGE_CONFLICT" });

    const publicPage = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      { limit: 10 },
    );
    expect(publicPage.messages).toEqual([second.message, first.message]);

    const adminPage = await listSiteMessages(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { limit: 10 },
    );
    expect(adminPage.messages).toEqual(publicPage.messages);
  });

  it("limits successful posts per site and IP and returns a retry interval", async () => {
    const limitedIp = "b".repeat(64);
    const requests = Array.from({ length: 5 }, () => input());
    for (const request of requests) {
      await createPublicSiteMessage(
        connection.db,
        siteId,
        request,
        limitedIp,
        now,
      );
    }

    await expect(
      createPublicSiteMessage(connection.db, siteId, input(), limitedIp, now),
    ).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 3600,
    });

    await expect(
      connection.db
        .select({ ipFingerprint: muralMessageRateLimitEvent.ipFingerprint })
        .from(muralMessageRateLimitEvent)
        .where(
          and(
            eq(muralMessageRateLimitEvent.siteId, siteId),
            eq(muralMessageRateLimitEvent.ipFingerprint, limitedIp),
          ),
        ),
    ).resolves.toHaveLength(5);
  });

  it("searches author names without case or accent sensitivity across cursors", async () => {
    await createPublicSiteMessage(
      connection.db,
      siteId,
      { ...input(), authorName: "Jose\u0301 Alves" },
      "f".repeat(64),
      new Date(now.getTime() + 10_000),
    );
    await createPublicSiteMessage(
      connection.db,
      siteId,
      { ...input(), authorName: "Ana Silva" },
      "1".repeat(64),
      new Date(now.getTime() + 20_000),
    );
    await createPublicSiteMessage(
      connection.db,
      siteId,
      { ...input(), authorName: "JOSÉ Costa" },
      "2".repeat(64),
      new Date(now.getTime() + 30_000),
    );

    const actor = { userId: ownerId, role: "OWNER" as const };
    const first = await listSiteMessages(connection.db, actor, siteId, {
      limit: 1,
      search: "  jose  ",
    });
    expect(first.messages.map((message) => message.authorName)).toEqual([
      "JOSÉ Costa",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSiteMessages(connection.db, actor, siteId, {
      limit: 1,
      search: "JOSE",
      cursor: first.nextCursor as string,
    });
    expect(second.messages.map((message) => message.authorName)).toEqual([
      "Jose\u0301 Alves",
    ]);
    expect(second.nextCursor).toBeNull();

    await expect(
      listSiteMessages(connection.db, actor, siteId, {
        limit: 1,
        search: "ana",
        cursor: first.nextCursor as string,
      }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });

    await expect(
      listSiteMessages(
        connection.db,
        { userId: outsiderId, role: "SITE_ADMIN" },
        siteId,
        { search: "jose" },
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("treats SQL LIKE wildcards in a name search as literal characters", async () => {
    await createPublicSiteMessage(
      connection.db,
      siteId,
      { ...input(), authorName: "100%_test" },
      "3".repeat(64),
      new Date(now.getTime() + 40_000),
    );
    await createPublicSiteMessage(
      connection.db,
      siteId,
      { ...input(), authorName: "100xytest" },
      "4".repeat(64),
      new Date(now.getTime() + 50_000),
    );

    const result = await listSiteMessages(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { search: "100%_test" },
    );
    expect(result.messages.map((message) => message.authorName)).toEqual([
      "100%_test",
    ]);
  });

  it("deletes by message ID and keeps the idempotency tombstone", async () => {
    const created = await createPublicSiteMessage(
      connection.db,
      siteId,
      input(),
      "c".repeat(64),
      now,
    );
    const actor = { userId: ownerId, role: "OWNER" as const };
    await expect(
      deleteSiteMessage(connection.db, actor, siteId, created.message.id),
    ).resolves.toEqual({ ok: true });
    await expect(
      deleteSiteMessage(connection.db, actor, siteId, created.message.id),
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" });
    await expect(
      createPublicSiteMessage(
        connection.db,
        siteId,
        input(created.requestId),
        "c".repeat(64),
        now,
      ),
    ).rejects.toMatchObject({ status: 410, code: "MESSAGE_REMOVED" });

    await expect(
      connection.db
        .select()
        .from(muralMessageRequestReceipt)
        .where(
          and(
            eq(muralMessageRequestReceipt.siteId, siteId),
            eq(muralMessageRequestReceipt.requestId, created.requestId),
          ),
        ),
    ).resolves.toHaveLength(1);
    await expect(
      connection.db
        .select()
        .from(muralMessage)
        .where(
          and(
            eq(muralMessage.siteId, siteId),
            eq(muralMessage.id, created.message.id),
          ),
        ),
    ).resolves.toEqual([]);
  });

  it("rejects public writes while disabled or inactive", async () => {
    await connection.db
      .update(site)
      .set({ muralEnabled: false })
      .where(eq(site.id, siteId));
    const disabledPage = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      { limit: 1 },
    );
    expect(disabledPage.enabled).toBe(false);
    expect(disabledPage.messages).toHaveLength(1);
    expect(disabledPage.nextCursor).not.toBeNull();

    const disabledNextPage = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      { limit: 1, cursor: disabledPage.nextCursor as string },
    );
    expect(disabledNextPage.enabled).toBe(false);
    expect(disabledNextPage.messages).toHaveLength(1);

    await expect(
      createPublicSiteMessage(
        connection.db,
        siteId,
        input(),
        "d".repeat(64),
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: "MURAL_DISABLED" });

    await connection.db
      .update(site)
      .set({
        lifecycle: "INACTIVE",
        previousLifecycle: "ACTIVE",
        muralEnabled: true,
      })
      .where(eq(site.id, siteId));
    await expect(
      createPublicSiteMessage(
        connection.db,
        siteId,
        input(),
        "e".repeat(64),
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: "SITE_INACTIVE" });
    await connection.db
      .update(site)
      .set({ lifecycle: "ACTIVE", previousLifecycle: null })
      .where(eq(site.id, siteId));
  });
});
