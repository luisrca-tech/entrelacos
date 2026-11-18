import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialOperation,
  receivingAccount,
  receivingDestination,
  site,
  user,
  withdrawalIntent,
} from "@entrelacos/database/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReceivingNominationRepository } from "./receivingNominationRepository";
import { createReceivingSetupRepository } from "./receivingSetupRepository";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";

// Production sites onboarded before the Pagar.me switch keep their previous
// provider's account, operations and withdrawals. Setup, holder naming and
// history must treat them as history, never answer 503.
const connection = createDatabaseConnection({ target: "test" });
const fixture = `legacy-${randomUUID()}`;
const siteId = `${fixture}-site`;
const userId = `${fixture}-holder`;
const accountId = `${fixture}-account`;
const withdrawalId = `${fixture}-withdrawal`;

beforeAll(async () => {
  await verifyDatabaseConnection(connection);
  const db = connection.db;
  const at = new Date("2026-10-01T12:00:00.000Z");
  await db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: siteId,
    displayName: "Legacy provider fixture",
    partnerOneName: "One",
    partnerTwoName: "Two",
    eventDate: "2027-10-24",
  });
  await db.insert(user).values({
    id: userId,
    name: "Legacy holder",
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await db.insert(receivingAccount).values({
    id: accountId,
    siteId,
    environment: "sandbox",
    provider: "PREVIOUS_PROVIDER",
    operatorUserId: userId,
    accountReference: `acc_${fixture}`,
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    isCurrent: true,
    credentialVersion: 1,
    credentialKeyId: "key-1",
    credentialNonce: "nonce",
    credentialCiphertext: "ciphertext",
    credentialTag: "tag",
    observedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(financialOperation).values({
    id: `${fixture}-account-create`,
    siteId,
    accountId,
    environment: "sandbox",
    kind: "ACCOUNT_CREATE",
    state: "SUCCEEDED",
    requestId: `${fixture}-request`,
    requestHash: "a".repeat(64),
    requestSnapshot: { legacy: true },
    attempts: 1,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(receivingDestination).values({
    id: `${fixture}-destination`,
    siteId,
    accountId,
    environment: "sandbox",
    version: 1,
    bankReference: `bank-${fixture}`,
    bankState: "VERIFIED",
    isCurrent: true,
  });
  await db.insert(withdrawalIntent).values({
    id: withdrawalId,
    siteId,
    accountId,
    environment: "sandbox",
    operatorUserId: userId,
    destinationVersion: 1,
    requestId: withdrawalId,
    requestHash: "b".repeat(64),
    authorizationReference: `auth-${withdrawalId}`,
    policyVersion: "legacy-policy",
    amountCents: 1000,
    feeCents: 0,
    netCents: 1000,
    reservedCents: 1000,
    createdAt: at,
  });
});

afterAll(async () => {
  await connection.close();
});

describe("receiving reads next to a previous provider's account", () => {
  it("reports the site as not set up on Pagar.me instead of failing", async () => {
    const repository = createReceivingSetupRepository(connection.db, {
      mode: "sandbox",
      applicationEnvironment: "test",
      policyVersion: "test-policy",
      maxAuthAgeMs: 300_000,
      now: () => new Date(),
    });
    await expect(repository.readAccount(siteId)).resolves.toBeNull();
  });

  it("finds no Pagar.me nomination scope, so a holder can be named", async () => {
    const repository = createReceivingNominationRepository(connection.db, {
      mode: "sandbox",
      applicationEnvironment: "test",
      maxAuthAgeMs: 300_000,
      now: () => new Date(),
    });
    await expect(
      repository.readNominationScope({
        siteId,
        operatorUserId: userId,
        environment: "sandbox",
      }),
    ).resolves.toBeNull();
  });

  it("keeps the previous provider's withdrawals in the history", async () => {
    const repository = createWithdrawalHistoryRepository(connection.db, {
      mode: "sandbox",
    });
    const withdrawals = await repository.listWithdrawals(siteId);
    expect(withdrawals.map(({ id }) => id)).toEqual([withdrawalId]);
  });
});
