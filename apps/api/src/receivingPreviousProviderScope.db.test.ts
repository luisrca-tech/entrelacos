import { createHash, randomUUID } from "node:crypto";
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
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";

// A site that moved to Pagar.me keeps its previous provider's account and
// operations. The locked provisioning scope must read them as history only.
const connection = createDatabaseConnection({ target: "test" });
const fixture = `previous-${randomUUID()}`;
const siteId = `${fixture}-site`;
const userId = `${fixture}-holder`;
const previousAccountId = `${fixture}-a-previous`;
const accountId = `${fixture}-pagarme`;
const createdAt = new Date("2026-10-13T00:00:00.000Z");
const leaseExpiresAt = new Date("2026-10-13T00:01:00.000Z");
const requestId = `${fixture}-request`;
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
    sessionId: "session-one",
    proofKind: "PASSWORD_REAUTHENTICATION",
    authenticatedAt: "2026-10-12T23:59:30.000Z",
    expiresAt: "2026-10-13T00:04:30.000Z",
  },
});
const claim = readReceivingProvisioningRecord({
  version: "receiving.account-provisioning.v1",
  nomination,
  provision: {
    ...deriveReceivingProvisioningContext(
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
          type: "checking",
        },
      },
      new Map([["fp-v1", new Uint8Array(32).fill(8)]]),
    ),
    dispatch: {
      leaseOwner: "owner-one",
      leaseToken: "token-one",
      leaseExpiresAtMicroseconds: (
        BigInt(leaseExpiresAt.getTime()) * 1000n
      ).toString(),
      possibleDispatch: false,
    },
  },
  sealedResult: null,
});

beforeAll(async () => {
  await verifyDatabaseConnection(connection);
  const db = connection.db;
  const at = new Date("2026-03-01T12:00:00.000Z");
  await db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: siteId,
    displayName: "Previous provider fixture",
    partnerOneName: "One",
    partnerTwoName: "Two",
    eventDate: "2027-10-24",
  });
  await db.insert(user).values({
    id: userId,
    name: "Previous provider holder",
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await db.insert(receivingAccount).values({
    id: previousAccountId,
    siteId,
    environment: "sandbox",
    provider: "ASAAS",
    operatorUserId: userId,
    accountReference: `acc_${fixture}`,
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    isCurrent: false,
    observedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(financialOperation).values({
    id: `${fixture}-a-previous-create`,
    siteId,
    accountId: previousAccountId,
    environment: "sandbox",
    kind: "ACCOUNT_CREATE",
    state: "SUCCEEDED",
    requestId: `${fixture}-previous-request`,
    requestHash: "a".repeat(64),
    requestSnapshot: { legacy: true },
    attempts: 1,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(receivingDestination).values({
    id: `${fixture}-destination`,
    siteId,
    accountId: previousAccountId,
    environment: "sandbox",
    version: 1,
    bankReference: `bank-${fixture}`,
    bankState: "VERIFIED",
    isCurrent: true,
  });
  await db.insert(withdrawalIntent).values({
    id: `${fixture}-withdrawal`,
    siteId,
    accountId: previousAccountId,
    environment: "sandbox",
    operatorUserId: userId,
    destinationVersion: 1,
    requestId: `${fixture}-withdrawal`,
    requestHash: "b".repeat(64),
    authorizationReference: `auth-${fixture}`,
    policyVersion: "legacy-policy",
    amountCents: 1000,
    feeCents: 0,
    netCents: 1000,
    reservedCents: 1000,
    createdAt: at,
  });
  await db.insert(financialOperation).values({
    id: `${fixture}-a-previous-withdrawal`,
    siteId,
    accountId: previousAccountId,
    environment: "sandbox",
    kind: "WITHDRAWAL",
    withdrawalIntentId: `${fixture}-withdrawal`,
    state: "SUCCEEDED",
    requestId: `${fixture}-withdrawal-request`,
    requestHash: "d".repeat(64),
    requestSnapshot: { legacy: true },
    attempts: 1,
    createdAt: at,
    updatedAt: at,
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
    state: "CLAIMED",
    requestId,
    requestHash: nomination.requestHash,
    requestSnapshot: claim as unknown as Record<string, unknown>,
    leaseOwner: "owner-one",
    leaseToken: "token-one",
    leaseExpiresAt,
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
});

afterAll(async () => {
  await connection.close();
});

describe("account provisioning next to a previous provider's history", () => {
  it("reads only the Pagar.me account and its account creation", async () => {
    const repository = createReceivingAccountProvisioningRepository(
      connection.db,
      {
        mode: "sandbox",
        applicationEnvironment: "test",
        maxAuthAgeMs: 300_000,
        now: () => new Date(),
        observe: () => {},
      },
    );
    const observed = await repository.consultOriginal(claim, null);
    expect(observed?.state).toBe("CLAIMED");
    expect(observed?.record).toEqual(claim);
    expect(observed?.result).toBeNull();
  });
});
