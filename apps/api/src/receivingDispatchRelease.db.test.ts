import { createHash, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialOperation,
  receivingAccount,
  session,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveReceivingProvisioningContext,
  ReceivingAccountProvisioningError,
} from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  type ReceivingProvisioningRecord,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";

// An armed account creation that Pagar.me refused, or never received, goes
// back to REQUESTED so the holder can resubmit; the next dispatch is counted.
const connection = createDatabaseConnection({ target: "test" });
const fixture = `release-${randomUUID()}`;
const siteId = `${fixture}-site`;
const userId = `${fixture}-holder`;
const sessionId = `${fixture}-session`;
const accountId = `${fixture}-pagarme`;
const requestId = `${fixture}-request`;
const createdAt = new Date("2026-10-13T00:00:00.000Z");
const expiredLease = new Date("2026-10-13T00:01:00.000Z");
const sessionCreatedAt = new Date(Date.now() - 60_000);
const sessionExpiresAt = new Date(Date.now() + 3_600_000);
const nomination = readReceivingNominationSnapshot({
  state: "AWAITING_PROVIDER_VERIFICATION",
  siteId,
  operatorUserId: userId,
  environment: "sandbox",
  requestId,
  policyVersion: "policy-one",
  accountId,
  operationId: `${fixture}-operation`,
  createdAt: createdAt.toISOString(),
  requestHash: createHash("sha256")
    .update(
      JSON.stringify([
        "receiving.self-nomination.v1",
        siteId,
        requestId,
        userId,
        "sandbox",
        "policy-one",
        true,
      ]),
    )
    .digest("hex"),
  authentication: {
    userId,
    siteId,
    sessionId,
    proofKind: "PASSWORD_REAUTHENTICATION",
    authenticatedAt: "2026-10-12T23:59:30.000Z",
    expiresAt: "2026-10-13T00:04:30.000Z",
  },
});
const keys = new Map([["fp-v1", new Uint8Array(32).fill(8)]]);
const provision = deriveReceivingProvisioningContext(
  nomination,
  "rp_platformRecipient",
  "fp-v1",
  {
    name: "FIXTURE HOLDER",
    email: "holder@example.test",
    cpf: "12345678909",
    mobilePhone: "21994647568",
    birthDate: "1990-04-12",
    monthlyIncomeCents: 500000,
    professionalOccupation: "Professora",
    address: {
      street: "Rua Fixture",
      streetNumber: "1",
      neighborhood: "Centro",
      city: "Rio de Janeiro",
      state: "RJ",
      zipCode: "20021130",
    },
    bankAccount: {
      bank: "341",
      branchNumber: "1234",
      accountNumber: "12345",
      accountCheckDigit: "6",
      holderName: "MARIA DA SILVA",
      type: "checking",
    },
  },
  keys,
);
// The row production holds: armed once, no stored result, lease long expired.
const stuck = readReceivingProvisioningRecord({
  version: "receiving.account-provisioning.v1",
  nomination,
  provision: {
    ...provision,
    dispatch: {
      leaseOwner: "owner-one",
      leaseToken: "token-one",
      leaseExpiresAtMicroseconds: (
        BigInt(expiredLease.getTime()) * 1000n
      ).toString(),
      possibleDispatch: true,
    },
  },
  sealedResult: null,
});
const authorization = {
  actor: { userId, siteId, sessionId },
  recentAuth: {
    userId,
    siteId,
    sessionId,
    proofKind: "SESSION_AUTHENTICATION" as const,
    provenance: "backend" as const,
    verification: "verified" as const,
    authenticatedAt: sessionCreatedAt,
    expiresAt: sessionExpiresAt,
  },
};
const repository = createReceivingAccountProvisioningRepository(connection.db, {
  mode: "sandbox",
  applicationEnvironment: "test",
  maxAuthAgeMs: 300_000,
  now: () => new Date(),
  readCurrentPolicy: async () => true,
  observe: () => {},
});
async function operationRow() {
  const [row] = await connection.db
    .select()
    .from(financialOperation)
    .where(eq(financialOperation.id, nomination.operationId));
  return row;
}
async function claim(): Promise<ReceivingProvisioningRecord> {
  return repository.claimOriginal(
    {
      nomination,
      provision,
      leaseOwner: `owner-${randomUUID()}`,
      leaseToken: `token-${randomUUID()}`,
    },
    authorization,
  );
}
function armed(record: ReceivingProvisioningRecord) {
  return readReceivingProvisioningRecord({
    ...record,
    provision: {
      ...record.provision,
      dispatch: { ...record.provision.dispatch, possibleDispatch: true },
    },
  });
}

beforeAll(async () => {
  await verifyDatabaseConnection(connection);
  const db = connection.db;
  await db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: siteId,
    displayName: "Dispatch release fixture",
    partnerOneName: "One",
    partnerTwoName: "Two",
    eventDate: "2027-10-24",
  });
  await db.insert(user).values({
    id: userId,
    name: "Dispatch release holder",
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await db.insert(siteMembership).values({
    id: `${fixture}-membership`,
    siteId,
    userId,
    role: "SITE_ADMIN",
  });
  await db.insert(session).values({
    id: sessionId,
    userId,
    token: `${fixture}-token`,
    expiresAt: sessionExpiresAt,
    lastActiveAt: new Date(),
    createdAt: sessionCreatedAt,
    updatedAt: sessionCreatedAt,
  });
  await db.insert(receivingAccount).values({
    id: accountId,
    siteId,
    environment: "sandbox",
    provider: "PAGARME",
    operatorUserId: userId,
    isCurrent: true,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(financialOperation).values({
    id: nomination.operationId,
    siteId,
    accountId,
    environment: "sandbox",
    kind: "ACCOUNT_CREATE",
    state: "UNKNOWN",
    requestId,
    requestHash: nomination.requestHash,
    requestSnapshot: stuck as unknown as Record<string, unknown>,
    leaseOwner: "owner-one",
    leaseToken: "token-one",
    leaseExpiresAt: expiredLease,
    attempts: 1,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: expiredLease,
  });
});

afterAll(async () => {
  await connection.close();
});

describe("releasing an armed account creation for a new dispatch", () => {
  it("releases the stuck dispatch Pagar.me never received back to REQUESTED", async () => {
    await repository.releaseOriginal(stuck, "PROVIDER_ABSENT");
    const row = await operationRow();
    expect(row).toMatchObject({
      state: "REQUESTED",
      attempts: 1,
      lastErrorCode: "PROVIDER_ABSENT",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      providerOperationReference: null,
    });
    expect(readReceivingNominationSnapshot(row.requestSnapshot)).toEqual(
      nomination,
    );
    expect(row.requestSnapshot).toEqual(JSON.parse(JSON.stringify(nomination)));
    // A repeated release of the same dispatch is refused.
    await expect(
      repository.releaseOriginal(stuck, "PROVIDER_ABSENT"),
    ).rejects.toBeInstanceOf(ReceivingAccountProvisioningError);
  });

  it("claims the released creation again as its second dispatch", async () => {
    const second = await claim();
    expect(second.provision.dispatch.attempt).toBe(2);
    expect(second.provision.dispatch.possibleDispatch).toBe(false);
    expect(await operationRow()).toMatchObject({
      state: "CLAIMED",
      attempts: 1,
      lastErrorCode: "PROVIDER_ABSENT",
    });
    await repository.armOriginal(armed(second), authorization);
    expect(await operationRow()).toMatchObject({
      state: "UNKNOWN",
      attempts: 2,
    });
    const observed = await repository.consultOriginal(armed(second), null);
    expect(observed?.state).toBe("UNKNOWN");
    expect(observed?.record.provision.dispatch.attempt).toBe(2);
  });

  it("refuses to treat a live dispatch as absent, but releases a definitive rejection", async () => {
    const observed = await repository.consultOriginal(
      readReceivingProvisioningRecord(
        (await operationRow()).requestSnapshot as unknown,
      ),
      null,
    );
    if (!observed) throw new Error("missing armed dispatch");
    const live = observed.record;
    await expect(
      repository.releaseOriginal(live, "PROVIDER_ABSENT"),
    ).rejects.toBeInstanceOf(ReceivingAccountProvisioningError);
    expect((await operationRow()).state).toBe("UNKNOWN");
    await repository.releaseOriginal(live, "PROVIDER_REJECTED");
    expect(await operationRow()).toMatchObject({
      state: "REQUESTED",
      attempts: 2,
      lastErrorCode: "PROVIDER_REJECTED",
      leaseOwner: null,
    });
    const third = await claim();
    expect(third.provision.dispatch.attempt).toBe(3);
  });

  it("never releases a dispatch holding a stored result", async () => {
    const third = readReceivingProvisioningRecord(
      (await operationRow()).requestSnapshot as unknown,
    );
    const live = armed(third);
    await repository.armOriginal(live, authorization);
    await repository.quarantineOriginal(live, {
      accountReference: "rp_fixtureRecipient01",
      recipientReference: "rp_fixtureRecipient01",
    });
    await expect(
      repository.releaseOriginal(live, "PROVIDER_REJECTED"),
    ).rejects.toBeInstanceOf(ReceivingAccountProvisioningError);
    expect(await operationRow()).toMatchObject({
      state: "UNKNOWN",
      attempts: 3,
    });
  });
});
