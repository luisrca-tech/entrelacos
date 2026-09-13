import { randomBytes, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familyMessage,
  familySession,
  guestGroup,
  guestMember,
  site,
  siteOrigin,
  user,
} from "@entrelacos/database/schema";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFamilySessionToken } from "./familySession";
import { createGuestGroup } from "./guestGroups";
import {
  deleteGroupMessage,
  listSiteMessages,
  readFamilyMessage,
  readMuralConfiguration,
  readPublicMural,
  updateMessageBlock,
  updateMuralConfiguration,
  writeFamilyMessage,
} from "./messages";
import { approveReview, createSite, startReview } from "./sites";

const fixturePrefix = `b5-messages-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2029-01-10T12:00:00.000Z");
const publicOrigin = `https://${fixturePrefix}.example.test`;
const ownerId = `${fixturePrefix}-owner`;
let connection: DatabaseConnection;
let siteId = "";
let groupId = "";
let representativeId = "";
let sessionId = "";
let familyToken = "";
let firstRequestId = "";

async function fixture() {
  const wedding = await createSite(
    connection.db,
    {
      repositorySlug: fixturePrefix,
      provisioningKey: `${fixturePrefix}:key`,
      displayName: "Message Wedding",
      coupleNames: ["Ana", "João"],
      eventDate: "2030-06-10",
    },
    fixedNow,
  );
  siteId = wedding.id;
  await startReview(connection.db, siteId, {}, fixedNow);
  await approveReview(connection.db, siteId, {}, fixedNow);
  await connection.db.insert(siteOrigin).values({
    id: `${fixturePrefix}-origin`,
    siteId,
    origin: publicOrigin,
  });
  const group = await createGuestGroup(
    connection.db,
    { userId: ownerId, role: "OWNER" },
    siteId,
    {
      name: "Família Inicial",
      isForeign: false,
      phone: "+5511999999999",
      members: [{ fullName: "Ana Inicial", isRepresentative: true }],
    },
    fixedNow,
  );
  groupId = group.id;
  representativeId = group.members[0]?.id ?? "";
  familyToken = randomBytes(32).toString("base64url");
  sessionId = `${fixturePrefix}-family-session`;
  await connection.db.insert(familySession).values({
    id: sessionId,
    siteId,
    groupId,
    tokenHash: hashFamilySessionToken(familyToken),
    expiresAt: new Date(fixedNow.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdAt: fixedNow,
  });
}

describe("messages PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Message Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
    });
    await fixture();
    await updateMuralConfiguration(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { enabled: true },
      fixedNow,
    );
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("derives family identity, keeps snapshots, and enforces idempotent revision writes", async () => {
    const requestId = randomUUID();
    firstRequestId = requestId;
    const first = await writeFamilyMessage(
      connection.db,
      familyToken,
      { requestId, expectedRevision: 0, text: "Olá 👩‍❤️‍👨" },
      fixedNow,
    );
    expect(first.result).toBe("APPLIED");
    expect(first.message.authorName).toBe("Ana Inicial");
    expect(first.message.groupName).toBe("Família Inicial");

    const replay = await writeFamilyMessage(
      connection.db,
      familyToken,
      { requestId, expectedRevision: 0, text: "Olá 👩‍❤️‍👨" },
      new Date(fixedNow.getTime() + 1_000),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.acceptedAt).toBe(first.acceptedAt);

    await expect(
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId, expectedRevision: 0, text: "Outro texto" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });

    await expect(
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId: randomUUID(), expectedRevision: 0, text: "Texto novo" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_CONFLICT", status: 409 });
  });

  it("serializes concurrent writes so exactly one matching revision is applied", async () => {
    const outcomes = await Promise.allSettled([
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId: randomUUID(), expectedRevision: 1, text: "Corrida A" },
        fixedNow,
      ),
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId: randomUUID(), expectedRevision: 1, text: "Corrida B" },
        fixedNow,
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "MESSAGE_CONFLICT", status: 409 },
    });
  });

  it("blocks writes while preserving the current family message and public privacy", async () => {
    await updateMuralConfiguration(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { enabled: true },
      fixedNow,
    );
    await updateMessageBlock(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      groupId,
      { blocked: true },
      fixedNow,
    );
    await expect(
      readFamilyMessage(connection.db, familyToken, fixedNow),
    ).resolves.toMatchObject({
      canEdit: false,
      readOnlyReason: "MESSAGE_BLOCKED",
      message: { text: expect.stringMatching(/^Corrida [AB]$/) },
    });
    await expect(
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId: randomUUID(), expectedRevision: 2, text: "Bloqueado" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_BLOCKED", status: 409 });
    const publicRead = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      {},
    );
    expect(publicRead.messages[0]).toEqual({
      id: expect.any(String),
      authorName: "Ana Inicial",
      groupName: "Família Inicial",
      text: expect.stringMatching(/^Corrida [AB]$/),
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    });
    expect(publicRead.messages[0]).not.toHaveProperty("revision");
    await expect(
      readMuralConfiguration(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        siteId,
      ),
    ).resolves.toEqual({ siteId, enabled: true });
    await expect(
      listSiteMessages(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        siteId,
        {},
      ),
    ).resolves.toMatchObject({
      groups: [
        {
          groupId,
          groupName: "Família Inicial",
          currentRevision: 2,
          message: { text: expect.stringMatching(/^Corrida [AB]$/) },
        },
      ],
    });
  });

  it("deletes receipts with the message, increments revision, and allows fresh snapshots", async () => {
    const deleted = await deleteGroupMessage(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      groupId,
      { expectedRevision: 2 },
      fixedNow,
    );
    expect(deleted).toEqual({ ok: true, currentRevision: 3 });
    await updateMessageBlock(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      groupId,
      { blocked: false },
      fixedNow,
    );
    await expect(
      writeFamilyMessage(
        connection.db,
        familyToken,
        { requestId: firstRequestId, expectedRevision: 0, text: "Olá 👩‍❤️‍👨" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_REMOVED", status: 410 });
    await expect(
      readPublicMural(connection.db, siteId, publicOrigin, {}),
    ).resolves.toMatchObject({
      messages: [],
    });
    await connection.db
      .update(guestGroup)
      .set({ name: "Família Atualizada" })
      .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)));
    await connection.db
      .update(guestMember)
      .set({ fullName: "Ana Atualizada" })
      .where(
        and(
          eq(guestMember.siteId, siteId),
          eq(guestMember.id, representativeId),
        ),
      );
    const republished = await writeFamilyMessage(
      connection.db,
      familyToken,
      { requestId: randomUUID(), expectedRevision: 3, text: "Mensagem nova" },
      fixedNow,
    );
    expect(republished.message).toMatchObject({
      authorName: "Ana Atualizada",
      groupName: "Família Atualizada",
      revision: 4,
    });
  });

  it("rejects malformed public cursors before exposing mural rows", async () => {
    await expect(
      readPublicMural(connection.db, siteId, publicOrigin, {
        cursor: "definitely-invalid",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });

  it("uses createdAt and id cursor ordering without reordering edits", async () => {
    const createdAt = new Date(fixedNow.getTime() + 1_000);
    const orderGroupId = `${fixturePrefix}-order-group`;
    const orderMemberId = `${fixturePrefix}-order-member`;
    await connection.db.transaction(async (tx) => {
      await tx.insert(guestGroup).values({
        id: orderGroupId,
        siteId,
        name: "Família Ordem",
        normalizedName: "familia ordem",
        isForeign: false,
        phoneE164: "+5511998888888",
        representativeMemberId: orderMemberId,
        messageRevision: 1,
        createdAt,
        updatedAt: createdAt,
      });
      await tx.insert(guestMember).values({
        id: orderMemberId,
        siteId,
        groupId: orderGroupId,
        fullName: "Bia Ordem",
        normalizedName: "bia ordem",
        createdAt,
        updatedAt: createdAt,
      });
      await tx.insert(familyMessage).values({
        id: `${fixturePrefix}-order-message`,
        siteId,
        groupId: orderGroupId,
        authorMemberId: orderMemberId,
        authorName: "Bia Ordem",
        groupName: "Família Ordem",
        text: "Mensagem mais nova",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      });
    });
    await writeFamilyMessage(
      connection.db,
      familyToken,
      {
        requestId: randomUUID(),
        expectedRevision: 4,
        text: "Mensagem editada",
      },
      new Date(fixedNow.getTime() + 2_000),
    );
    const firstPage = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      { limit: 1 },
    );
    expect(firstPage.messages[0]?.groupName).toBe("Família Ordem");
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await readPublicMural(
      connection.db,
      siteId,
      publicOrigin,
      { cursor: firstPage.nextCursor, limit: 1 },
    );
    expect(secondPage.messages[0]).toMatchObject({
      groupName: "Família Atualizada",
      text: "Mensagem editada",
      createdAt: fixedNow.toISOString(),
      updatedAt: new Date(fixedNow.getTime() + 2_000).toISOString(),
    });
    expect(secondPage.nextCursor).toBeNull();
  });

  it("fails closed for invalid family sessions, inactive sites, and foreign public tenants", async () => {
    await expect(
      readFamilyMessage(connection.db, "invalid-family-token", fixedNow),
    ).rejects.toMatchObject({ code: "SESSION_INVALID", status: 401 });
    await connection.db
      .update(familySession)
      .set({ revokedAt: fixedNow, revocationReason: "TEST" })
      .where(eq(familySession.id, sessionId));
    await expect(
      readFamilyMessage(connection.db, familyToken, fixedNow),
    ).rejects.toMatchObject({ code: "SESSION_INVALID", status: 401 });
    await connection.db
      .update(familySession)
      .set({ revokedAt: null, revocationReason: null })
      .where(eq(familySession.id, sessionId));
    await expect(
      readFamilyMessage(
        connection.db,
        familyToken,
        new Date(fixedNow.getTime() + 7 * 24 * 60 * 60 * 1000),
      ),
    ).rejects.toMatchObject({ code: "SESSION_INVALID", status: 401 });

    const foreign = await createSite(
      connection.db,
      {
        repositorySlug: `${fixturePrefix}-foreign`,
        provisioningKey: `${fixturePrefix}:foreign-key`,
        displayName: "Foreign Wedding",
        coupleNames: ["Bia", "Caio"],
        eventDate: "2030-06-11",
      },
      fixedNow,
    );
    await connection.db.insert(siteOrigin).values({
      id: `${fixturePrefix}-foreign-origin`,
      siteId: foreign.id,
      origin: `https://${fixturePrefix}-foreign.example.test`,
    });
    await expect(
      readPublicMural(connection.db, foreign.id, publicOrigin, {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await connection.db.delete(site).where(eq(site.id, foreign.id));

    await connection.db
      .update(site)
      .set({ lifecycle: "INACTIVE", previousLifecycle: "ACTIVE" })
      .where(eq(site.id, siteId));
    await expect(
      readPublicMural(connection.db, siteId, publicOrigin, {}),
    ).rejects.toMatchObject({ code: "SITE_INACTIVE", status: 409 });
  });
});
