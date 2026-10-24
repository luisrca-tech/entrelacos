import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialOperation,
  giftCheckoutAttempt,
  giftItem,
  giftOrder,
  giftQuoteRecord,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  site,
  siteTerm,
  user,
} from "@entrelacos/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createGiftCheckoutRepository,
  type GiftCheckoutDatabase,
} from "./giftCheckoutRepository";
import {
  createGiftCheckoutService,
  type GiftCheckoutReservation,
} from "./giftCheckouts";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
} from "./receivingRepository";

// Source preparation only. Execute under a separately approved test-database lease
// after the reviewed financial migration has been applied. No provider is called.
const applicationName = `gift-checkout-db-${randomUUID()}`;
interface CheckoutDatabaseFixture {
  siteId: string;
  operatorUserId: string;
  accountId: string;
  destinationId: string;
  evidenceId: string;
  giftId: string;
  quoteId: string;
  termId: string;
  body: { quoteId: string; requestId: string; recoveryToken: string };
  snapshot: GiftQuoteSnapshot;
  reservation: GiftCheckoutReservation;
  orderIds: string[];
  attemptIds: string[];
}
const fixtures: CheckoutDatabaseFixture[] = [];
let connection: DatabaseConnection | undefined;
function database() {
  if (!connection) throw new Error("Test database unavailable");
  return connection.db;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function observeTask<T>(
  task: Promise<T>,
  pending: Promise<PromiseSettledResult<unknown>>[],
): Promise<PromiseSettledResult<T>> {
  const observation: Promise<PromiseSettledResult<T>> = task.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  pending.push(observation);
  return observation;
}
function taskValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
function options(instanceId = randomUUID()) {
  return {
    instanceId,
    leaseMs: 60_000,
    now: () => new Date(),
    loadStoredReceivingContext: (
      tx: Parameters<typeof loadReceivingContextInTransaction>[0],
      scope: { siteId: string },
    ) =>
      loadReceivingContextInTransaction(tx, scope.siteId, receivingOptions()),
  };
}
function receivingOptions() {
  return {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    freshnessMs: 300_000,
    now: () => new Date(),
  };
}
function beforeCommitDatabase(
  started: ReturnType<typeof gate>,
  release: ReturnType<typeof gate>,
): GiftCheckoutDatabase {
  const db = database();
  return {
    execute: db.execute.bind(db),
    transaction: async (callback, config) =>
      db.transaction(async (tx) => {
        const result = await callback(tx);
        started.release();
        await release.promise;
        return result;
      }, config),
  };
}
function lostCommitAcknowledgementDatabase(): GiftCheckoutDatabase {
  const db = database();
  let first = true;
  return {
    execute: db.execute.bind(db),
    transaction: async (callback, config) => {
      const result = await db.transaction(callback, config);
      if (first) {
        first = false;
        throw new Error("Simulated lost commit acknowledgement");
      }
      return result;
    },
  };
}
async function waitForOwnAdvisoryWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result =
      await database().execute(sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND wait_event_type = 'Lock' AND wait_event = 'advisory') AS waiting`);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Expected owned checkout transaction to wait on the shared advisory lock",
  );
}

async function fixture(): Promise<CheckoutDatabaseFixture> {
  const siteId = randomUUID(),
    operatorUserId = randomUUID(),
    accountId = randomUUID(),
    destinationId = randomUUID(),
    evidenceId = randomUUID(),
    giftId = randomUUID(),
    quoteId = randomUUID(),
    termId = randomUUID();
  const createdAt = new Date();
  const observedAt = new Date(createdAt.getTime() - 1_000);
  const expiresAt = new Date(createdAt.getTime() + 300_000).toISOString();
  const binding = {
    siteId,
    provider: "ASAAS",
    operatorReference: randomUUID(),
    accountReference: randomUUID(),
    recipientReference: randomUUID(),
    bankReference: randomUUID(),
    destinationVersion: 1,
    environment: "sandbox" as const,
  };
  const snapshot: GiftQuoteSnapshot = {
    quote: {
      id: quoteId,
      siteId,
      giftId,
      title: "Concurrency fixture",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10_000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 0,
      totalCents: 10_200,
      policyVersion: "local-fixture-v1",
      expiresAt,
      mode: "sandbox",
    },
    gift: {
      id: giftId,
      siteId,
      title: "Concurrency fixture",
      description: "",
      nominalCents: 10_000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving: binding,
    pricing: {
      ...binding,
      verification: "verified",
      provenance: "local-test",
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 600_000).toISOString(),
      policy: {
        version: "local-fixture-v1",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt: createdAt.toISOString(),
    expiresAt,
  };
  const token = randomBytes(32).toString("base64url");
  const body = { quoteId, requestId: randomUUID(), recoveryToken: token };
  const orderId = randomUUID(),
    attemptId = randomUUID();
  const reservation: GiftCheckoutReservation = {
    siteId,
    quoteId,
    requestId: body.requestId,
    orderId,
    attemptId,
    recoveryTokenHash: createHash("sha256").update(token).digest("hex"),
    quoteSnapshot: snapshot,
    createdAt: new Date().toISOString(),
  };
  const value = {
    siteId,
    operatorUserId,
    accountId,
    destinationId,
    evidenceId,
    giftId,
    quoteId,
    termId,
    body,
    snapshot,
    reservation,
    orderIds: [orderId],
    attemptIds: [attemptId],
  };
  fixtures.push(value);
  await database()
    .insert(user)
    .values({
      id: operatorUserId,
      name: "Synthetic checkout recipient",
      email: `${operatorUserId}@example.test`,
      role: "SITE_ADMIN",
      state: "ACTIVE",
    });
  await database()
    .insert(site)
    .values({
      id: siteId,
      repositorySlug: `${applicationName}-${siteId}`,
      provisioningKey: `${applicationName}:${siteId}`,
      displayName: "Checkout database fixture",
      partnerOneName: "Fixture One",
      partnerTwoName: "Fixture Two",
      eventDate: "2027-05-22",
      lifecycle: "ACTIVE",
      publicationState: "PUBLISHED",
      isDemo: true,
    });
  await database().insert(siteTerm).values({
    id: termId,
    siteId,
    startsOn: "2020-01-01",
    endsOn: "2099-12-31",
    approvedAt: createdAt,
  });
  await database().insert(receivingAccount).values({
    id: accountId,
    siteId,
    provider: "ASAAS",
    environment: "sandbox",
    operatorUserId,
    operatorReference: binding.operatorReference,
    accountReference: binding.accountReference,
    recipientReference: binding.recipientReference,
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    isCurrent: true,
    observedAt,
    createdAt,
    updatedAt: createdAt,
  });
  await database().insert(receivingDestination).values({
    id: destinationId,
    siteId,
    accountId,
    environment: "sandbox",
    version: 1,
    bankReference: binding.bankReference,
    bankState: "VERIFIED",
    isCurrent: true,
    createdAt,
  });
  await database()
    .insert(receivingVerificationEvidence)
    .values({
      id: evidenceId,
      siteId,
      accountId,
      environment: "sandbox",
      destinationVersion: 1,
      accountReference: binding.accountReference,
      operatorReference: binding.operatorReference,
      recipientReference: binding.recipientReference,
      bankReference: binding.bankReference,
      verificationStatus: "VERIFIED",
      provenance: "SIMULATION",
      verificationReference: `${applicationName}:${evidenceId}`,
      providerAccountState: "APPROVED",
      bankState: "VERIFIED",
      receivingCapability: true,
      withdrawalCapability: true,
      commercialEnabled: true,
      observedAt,
      bankObservedAt: observedAt,
      createdAt,
    });
  await database().insert(giftItem).values({
    id: giftId,
    siteId,
    title: snapshot.gift.title,
    description: "",
    nominalCents: 10_000,
    currency: "BRL",
    publicationState: "PUBLISHED",
    sortOrder: 0,
  });
  await createGiftQuoteRepository(database(), { now: () => new Date() }).append(
    snapshot,
  );
  return value;
}
function service(
  value: Awaited<ReturnType<typeof fixture>>,
  repository = createGiftCheckoutRepository(database(), options()),
) {
  const provider = vi.fn(
    async (command: {
      orderId: string;
      attemptId: string;
      quoteSnapshot: GiftQuoteSnapshot;
    }) => ({
      providerReference: `checkout_${randomUUID()}`,
      checkout: {
        orderId: command.orderId,
        attemptId: command.attemptId,
        quoteId: value.quoteId,
        method: "PIX" as const,
        mode: "sandbox" as const,
        hostedUrl: "https://sandbox.example.test/local-fixture",
      },
    }),
  );
  const checkout = createGiftCheckoutService({
    repository,
    loadReceivingContext: (siteId) =>
      loadReceivingContext(database(), siteId, receivingOptions()),
    findPublishedGift: async () => ({
      gift: value.snapshot.gift,
      publicationState: "PUBLISHED",
      siteActive: true,
    }),
    createHostedCheckout: provider,
    now: () => new Date(),
    generateId: (kind) => {
      const id = randomUUID();
      (kind === "order" ? value.orderIds : value.attemptIds).push(id);
      return id;
    },
  });
  return { checkout, provider };
}

describe("checkout reserve and pre-dispatch seal PostgreSQL acceptance", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({
      target: "test",
      poolConfig: {
        max: 6,
        application_name: applicationName,
        statement_timeout: 10_000,
      },
    });
    await verifyDatabaseConnection(connection);
    const result = await database().execute(
      sql`SELECT to_regclass('public.gift_quote_record') AS quote_table, to_regclass('public.financial_operation') AS operation_table`,
    );
    if (!result.rows[0]?.quote_table || !result.rows[0]?.operation_table)
      throw new Error(
        "Reviewed financial migration must be applied before checkout database acceptance",
      );
  });
  afterAll(async () => {
    if (!connection) return;
    try {
      for (const value of fixtures) {
        await database().transaction(async (tx) => {
          await tx
            .delete(giftCheckoutAttempt)
            .where(
              and(
                eq(giftCheckoutAttempt.siteId, value.siteId),
                inArray(giftCheckoutAttempt.id, value.attemptIds),
              ),
            );
          await tx
            .delete(financialOperation)
            .where(
              and(
                eq(financialOperation.siteId, value.siteId),
                inArray(financialOperation.id, value.attemptIds),
              ),
            );
          await tx
            .delete(giftOrder)
            .where(
              and(
                eq(giftOrder.siteId, value.siteId),
                inArray(giftOrder.id, value.orderIds),
              ),
            );
          await tx
            .delete(giftQuoteRecord)
            .where(
              and(
                eq(giftQuoteRecord.siteId, value.siteId),
                eq(giftQuoteRecord.id, value.quoteId),
              ),
            );
          await tx
            .delete(giftItem)
            .where(
              and(
                eq(giftItem.siteId, value.siteId),
                eq(giftItem.id, value.giftId),
              ),
            );
          await tx
            .delete(receivingVerificationEvidence)
            .where(
              and(
                eq(receivingVerificationEvidence.siteId, value.siteId),
                eq(receivingVerificationEvidence.id, value.evidenceId),
              ),
            );
          await tx
            .delete(receivingDestination)
            .where(
              and(
                eq(receivingDestination.siteId, value.siteId),
                eq(receivingDestination.id, value.destinationId),
              ),
            );
          await tx
            .delete(receivingAccount)
            .where(
              and(
                eq(receivingAccount.siteId, value.siteId),
                eq(receivingAccount.id, value.accountId),
              ),
            );
          await tx
            .delete(siteTerm)
            .where(
              and(
                eq(siteTerm.siteId, value.siteId),
                eq(siteTerm.id, value.termId),
              ),
            );
          await tx.delete(site).where(eq(site.id, value.siteId));
          await tx.delete(user).where(eq(user.id, value.operatorUserId));
        });
      }
    } finally {
      await connection.close();
    }
  });

  it("a committed seal wins the overlapping reserve and prevents delayed POST dispatch", async () => {
    const value = await fixture();
    const started = gate(),
      release = gate();
    const winner = createGiftCheckoutRepository(
      beforeCommitDatabase(started, release),
      options(),
    );
    const loser = createGiftCheckoutRepository(database(), options());
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    try {
      const sealed = observeTask(
        winner.sealUncreatedRequest(value.reservation),
        pending,
      );
      await Promise.race([
        started.promise,
        sealed.then((result) => {
          taskValue(result);
          throw new Error("Seal completed before the controlled commit gate");
        }),
      ]);
      const reserve = observeTask(
        loser.reserve(value.reservation, () => {}),
        pending,
      );
      await waitForOwnAdvisoryWait();
      release.release();
      expect(taskValue(await sealed).state).toBe("CLOSED_UNPAID");
      expect(taskValue(await reserve)).toMatchObject({
        created: false,
        record: { state: "CLOSED_UNPAID" },
      });
      const { checkout, provider } = service(value, loser);
      expect(await checkout.getStatus(value.siteId, value.body)).toMatchObject({
        state: "CLOSED_UNPAID",
        mayStartNewAttempt: true,
      });
      await expect(
        checkout.createCheckout(value.siteId, value.body),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      expect(provider).not.toHaveBeenCalled();
    } finally {
      release.release();
      await Promise.all(pending);
    }
  });

  it("an overlapping committed reservation wins and cannot be sealed into unpaid", async () => {
    const value = await fixture();
    const started = gate(),
      release = gate();
    const winner = createGiftCheckoutRepository(
      beforeCommitDatabase(started, release),
      options(),
    );
    const loser = createGiftCheckoutRepository(database(), options());
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    try {
      const reserve = observeTask(
        winner.reserve(value.reservation, () => {}),
        pending,
      );
      await Promise.race([
        started.promise,
        reserve.then((result) => {
          taskValue(result);
          throw new Error(
            "Reservation completed before the controlled commit gate",
          );
        }),
      ]);
      const seal = observeTask(
        loser.sealUncreatedRequest(value.reservation),
        pending,
      );
      await waitForOwnAdvisoryWait();
      release.release();
      expect(taskValue(await reserve)).toMatchObject({
        created: true,
        record: { state: "CREATING" },
      });
      expect(taskValue(await seal)).toMatchObject({
        state: "CREATING",
        evidence: null,
      });
      const { checkout, provider } = service(value, loser);
      expect(await checkout.getStatus(value.siteId, value.body)).toMatchObject({
        state: "CREATING",
        mayStartNewAttempt: false,
      });
      await expect(
        checkout.createCheckout(value.siteId, value.body),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(provider).not.toHaveBeenCalled();
    } finally {
      release.release();
      await Promise.all(pending);
    }
  });

  it("retains an ambiguous committed reservation without retrying the provider", async () => {
    const value = await fixture();
    const repository = createGiftCheckoutRepository(database(), options());
    await repository.reserve(value.reservation, () => {});
    await repository.markOutcomeUnknown(
      value.reservation,
      new Date().toISOString(),
    );
    const { checkout, provider } = service(value, repository);
    expect(await checkout.getStatus(value.siteId, value.body)).toMatchObject({
      state: "OUTCOME_UNKNOWN",
      mayStartNewAttempt: false,
    });
    await expect(
      checkout.createCheckout(value.siteId, value.body),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("recovers a seal after its commit acknowledgement is lost", async () => {
    const value = await fixture();
    const repository = createGiftCheckoutRepository(
      lostCommitAcknowledgementDatabase(),
      options(),
    );
    await expect(
      repository.sealUncreatedRequest(value.reservation),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    const { checkout, provider } = service(value);
    expect(await checkout.getStatus(value.siteId, value.body)).toMatchObject({
      state: "CLOSED_UNPAID",
      mayStartNewAttempt: true,
    });
    await expect(
      checkout.createCheckout(value.siteId, value.body),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("recovers a reservation after commit acknowledgement loss without dispatch or new IDs", async () => {
    const value = await fixture();
    const repository = createGiftCheckoutRepository(
      lostCommitAcknowledgementDatabase(),
      options(),
    );
    await expect(
      repository.reserve(value.reservation, () => {}),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    const { checkout, provider } = service(value);
    expect(await checkout.getStatus(value.siteId, value.body)).toMatchObject({
      state: "CREATING",
      orderId: value.reservation.orderId,
      attemptId: value.reservation.attemptId,
      mayStartNewAttempt: false,
    });
    await expect(
      checkout.createCheckout(value.siteId, value.body),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(provider).not.toHaveBeenCalled();
    const rows = await database()
      .select({ id: giftOrder.id })
      .from(giftOrder)
      .where(eq(giftOrder.siteId, value.siteId));
    expect(rows).toEqual([{ id: value.reservation.orderId }]);
  });
});
