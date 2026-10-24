import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialOperation,
  receivingAccount,
  receivingPixPreparation,
  receivingSetupHolder,
  session,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReceivingSetupRepository } from "./receivingSetupRepository";

let connection: DatabaseConnection;
const fixtures: { siteId: string; userId: string }[] = [];
beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  if (!connection) return;
  for (const f of fixtures) {
    await connection.db
      .delete(receivingPixPreparation)
      .where(eq(receivingPixPreparation.siteId, f.siteId));
    await connection.db
      .delete(financialOperation)
      .where(eq(financialOperation.siteId, f.siteId));
    await connection.db
      .delete(receivingAccount)
      .where(eq(receivingAccount.siteId, f.siteId));
    await connection.db
      .delete(receivingSetupHolder)
      .where(eq(receivingSetupHolder.siteId, f.siteId));
    await connection.db
      .delete(siteMembership)
      .where(eq(siteMembership.siteId, f.siteId));
    await connection.db.delete(session).where(eq(session.userId, f.userId));
    await connection.db.delete(site).where(eq(site.id, f.siteId));
    await connection.db.delete(user).where(eq(user.id, f.userId));
  }
  await connection.close();
});
async function fixture(authorizePix = true) {
  const siteId = randomUUID(),
    userId = randomUUID(),
    sessionId = randomUUID(),
    accountId = randomUUID();
  fixtures.push({ siteId, userId });
  let time = new Date();
  await connection.db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: siteId,
    displayName: "Pix preparation fixture",
    partnerOneName: "One",
    partnerTwoName: "Two",
    eventDate: "2027-10-24",
    isDemo: true,
  });
  await connection.db.insert(user).values({
    id: userId,
    name: "Fixture holder",
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await connection.db.insert(session).values({
    id: sessionId,
    userId,
    token: randomUUID(),
    createdAt: time,
    lastActiveAt: time,
    expiresAt: new Date(time.getTime() + 3600000),
  });
  await connection.db
    .insert(siteMembership)
    .values({ id: randomUUID(), siteId, userId, role: "SITE_ADMIN" });
  await connection.db.insert(receivingSetupHolder).values({
    id: randomUUID(),
    siteId,
    environment: "sandbox",
    holderUserId: userId,
    designatedByUserId: userId,
    designatedAt: time,
    consentId: randomUUID(),
    consentVersion: "asaas-receiving-v1",
    consentAt: time,
    consentSessionId: sessionId,
    consentAuthenticatedAt: time,
  });
  await connection.db.insert(receivingAccount).values({
    id: accountId,
    siteId,
    environment: "sandbox",
    provider: "ASAAS",
    operatorUserId: userId,
    accountReference: `child-${accountId}`,
    recipientReference: `wallet-${accountId}`,
    isCurrent: true,
    credentialVersion: 1,
    credentialKeyId: "fixture-key",
    credentialNonce: "nonce",
    credentialCiphertext: "ciphertext",
    credentialTag: "tag",
  });
  await connection.db.insert(financialOperation).values({
    id: randomUUID(),
    siteId,
    accountId,
    environment: "sandbox",
    kind: "ACCOUNT_CREATE",
    state: "SUCCEEDED",
    requestId: randomUUID(),
    requestHash: "a".repeat(64),
    requestSnapshot: {},
  });
  const actor = { siteId, userId, sessionId };
  const binding = {
    provider: "ASAAS" as const,
    siteId,
    accountBindingId: accountId,
    environment: "sandbox" as const,
    accountReference: `child-${accountId}`,
    recipientReference: `wallet-${accountId}`,
  };
  const options = {
    mode: "sandbox" as const,
    applicationEnvironment: "development" as const,
    policyVersion: "policy-v1",
    maxAuthAgeMs: 300000,
    now: () => time,
  };
  const repository = () =>
    createReceivingSetupRepository(connection.db, options);
  if (authorizePix)
    await repository().consentIncomingPix(
      actor,
      accountId,
      "asaas-incoming-pix-v1",
    );
  return {
    actor,
    binding,
    repository,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}
describe("incoming Pix dispatch fence in PostgreSQL", () => {
  it("requires a distinct, replay-safe Pix authorization while preserving the opening consent", async () => {
    const f = await fixture(false);
    const [before] = await connection.db
      .select()
      .from(receivingSetupHolder)
      .where(eq(receivingSetupHolder.siteId, f.actor.siteId));
    await expect(
      f.repository().armIncomingPix(f.actor, f.binding),
    ).rejects.toMatchObject({ code: "PIX_PREPARATION_CONSENT_REQUIRED" });
    await f
      .repository()
      .consentIncomingPix(
        f.actor,
        f.binding.accountBindingId,
        "asaas-incoming-pix-v1",
      );
    const [accepted] = await connection.db
      .select()
      .from(receivingSetupHolder)
      .where(eq(receivingSetupHolder.siteId, f.actor.siteId));
    await f
      .repository()
      .consentIncomingPix(
        f.actor,
        f.binding.accountBindingId,
        "asaas-incoming-pix-v1",
      );
    const [replayed] = await connection.db
      .select()
      .from(receivingSetupHolder)
      .where(eq(receivingSetupHolder.siteId, f.actor.siteId));
    expect(accepted.consentId).toBe(before.consentId);
    expect(accepted.consentVersion).toBe(before.consentVersion);
    expect(accepted.pixPreparationConsent).toEqual(
      replayed.pixPreparationConsent,
    );
    expect(accepted.pixPreparationConsent).toMatchObject({
      version: "asaas-incoming-pix-v1",
      accountId: f.binding.accountBindingId,
      userId: f.actor.userId,
    });
    expect(await f.repository().armIncomingPix(f.actor, f.binding)).toBeTypeOf(
      "string",
    );
  });
  it("claims once across independent concurrent instances and survives a restart before dispatch", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.repository().armIncomingPix(f.actor, f.binding),
      f.repository().armIncomingPix(f.actor, f.binding),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.repository().armIncomingPix(f.actor, f.binding)).toBeNull();
    const [stored] = await connection.db
      .select()
      .from(receivingPixPreparation)
      .where(eq(receivingPixPreparation.accountId, f.binding.accountBindingId));
    expect(stored).toMatchObject({
      state: "ARMED",
      attempts: 1,
      actorUserId: f.actor.userId,
      sessionId: f.actor.sessionId,
    });
  });
  it.each(["SUBMITTED", "UNKNOWN"] as const)(
    "never rearms a %s attempt, even after the provider cooldown",
    async (outcome) => {
      const f = await fixture();
      const id = await f.repository().armIncomingPix(f.actor, f.binding);
      assert(id);
      await f.repository().settleIncomingPix(id, outcome);
      f.advance(120000);
      expect(
        await f.repository().armIncomingPix(f.actor, f.binding),
      ).toBeNull();
    },
  );
  it("retries only a definite rejection after one minute and ignores stale attempt outcomes", async () => {
    const f = await fixture();
    const first = await f.repository().armIncomingPix(f.actor, f.binding);
    assert(first);
    await f.repository().settleIncomingPix(first, "REJECTED");
    expect(await f.repository().armIncomingPix(f.actor, f.binding)).toBeNull();
    f.advance(60000);
    const second = await f.repository().armIncomingPix(f.actor, f.binding);
    expect(second).toBeTypeOf("string");
    expect(second).not.toBe(first);
    await f.repository().settleIncomingPix(first, "SUBMITTED");
    const [stored] = await connection.db
      .select()
      .from(receivingPixPreparation)
      .where(eq(receivingPixPreparation.accountId, f.binding.accountBindingId));
    expect(stored).toMatchObject({
      state: "ARMED",
      attempts: 2,
      attemptId: second,
    });
  });
  it("denies dispatch after session revocation and for another native wallet", async () => {
    const f = await fixture();
    await expect(
      f.repository().armIncomingPix(f.actor, {
        ...f.binding,
        recipientReference: "foreign-wallet",
      }),
    ).rejects.toMatchObject({ code: "RECEIVING_ACCOUNT_REQUIRED" });
    await connection.db
      .delete(session)
      .where(eq(session.id, f.actor.sessionId));
    await expect(
      f.repository().armIncomingPix(f.actor, f.binding),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED" });
    expect(
      await connection.db
        .select()
        .from(receivingPixPreparation)
        .where(
          eq(receivingPixPreparation.accountId, f.binding.accountBindingId),
        ),
    ).toHaveLength(0);
  });
});
