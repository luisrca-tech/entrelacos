import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  receivingAccount,
  receivingDestination,
  site,
  user,
  withdrawalIntent,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";

const fixture = `withdrawal-page-${randomUUID()}`;
const siteId = `${fixture}-site`;
const userId = `${fixture}-holder`;
const accountId = `${fixture}-account`;
const connection = createDatabaseConnection({ target: "test" });
const sameMillisecond = new Date("2026-10-24T19:20:00.123Z");
const rows = [
  { id: `${fixture}-b`, createdAt: sameMillisecond },
  { id: `${fixture}-a`, createdAt: new Date("2026-10-24T19:20:00.123456Z") },
  { id: `${fixture}-c`, createdAt: new Date("2026-10-20T10:00:00.000Z") },
];

beforeAll(async () => {
  await verifyDatabaseConnection(connection);
  await connection.db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: siteId,
    displayName: "Withdrawal page fixture",
    partnerOneName: "One",
    partnerTwoName: "Two",
    eventDate: "2027-10-24",
  });
  await connection.db.insert(user).values({
    id: userId,
    name: "Fixture holder",
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
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
  await connection.db.insert(receivingDestination).values({
    id: `${fixture}-destination`,
    siteId,
    accountId,
    environment: "sandbox",
    version: 1,
    bankReference: `bank-${fixture}`,
    bankState: "VERIFIED",
    isCurrent: true,
  });
  await connection.db.insert(withdrawalIntent).values(
    rows.map(({ id, createdAt }) => ({
      id,
      siteId,
      accountId,
      environment: "sandbox" as const,
      operatorUserId: userId,
      destinationVersion: 1,
      requestId: id,
      requestHash: "a".repeat(64),
      authorizationReference: `auth-${id}`,
      policyVersion: "fixture-policy",
      amountCents: 300,
      feeCents: 0,
      netCents: 300,
      reservedCents: 300,
      createdAt,
    })),
  );
});

afterAll(async () => {
  await connection.db
    .delete(withdrawalIntent)
    .where(eq(withdrawalIntent.siteId, siteId));
  await connection.db
    .delete(receivingDestination)
    .where(eq(receivingDestination.siteId, siteId));
  await connection.db
    .delete(receivingAccount)
    .where(eq(receivingAccount.siteId, siteId));
  await connection.db.delete(site).where(eq(site.id, siteId));
  await connection.db.delete(user).where(eq(user.id, userId));
  await connection.close();
});

it("walks same-millisecond withdrawals one page at a time without gaps or repeats", async () => {
  const repository = createWithdrawalHistoryRepository(connection.db, {
    mode: "sandbox",
  });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await repository.listWithdrawalPage(siteId, {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...result.withdrawals.map(({ id }) => id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  // Same millisecond (microseconds are truncated): id breaks the tie ascending.
  expect(seen).toEqual([`${fixture}-a`, `${fixture}-b`, `${fixture}-c`]);

  const lastPage = await repository.listWithdrawalPage(siteId, { limit: 3 });
  expect(lastPage.withdrawals).toHaveLength(3);
  expect(lastPage.nextCursor).toBeNull();
});
