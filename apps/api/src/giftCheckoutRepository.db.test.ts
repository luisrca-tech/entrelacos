import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftCheckoutAttempt,
  giftItem,
  giftOrder,
  giftPaymentRecord,
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
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  createGiftCheckoutRepository,
  type GiftCheckoutDatabase,
} from "./giftCheckoutRepository";
import {
  createGiftCheckoutService,
  type GiftCheckoutReservation,
} from "./giftCheckouts";
import { beforeWriteCommitDatabase } from "./giftCheckoutTestBarrier";
import { createGiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import {
  readGiftPricingSettings,
  updateGiftPricingSettings,
} from "./giftPricingSettings";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import { createGiftQuoteService } from "./giftQuotes";
import { readPublicGifts } from "./gifts";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
  readReceivingReadiness,
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
  return beforeWriteCommitDatabase(database(), started, release);
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

async function waitForOwnSiteWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await database().execute(sql`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE application_name = ${applicationName}
      AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0
      AND query LIKE '%site%'
    ) AS waiting`);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Expected an owned transaction to wait on the shared site lock",
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
    pricingSettings: { feeAllocation: "BUYER_GROSS_UP", revision: 0 },
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
      feeAllocation: "BUYER_GROSS_UP",
      settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
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
        feeAllocation: "BUYER_GROSS_UP",
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
  it("appends another quote for the same gift while a checkout locks its site and account", async () => {
    const value = await fixture();
    const snapshot = structuredClone(value.snapshot);
    snapshot.quote.id = randomUUID();
    const started = gate(),
      release = gate(),
      pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const reserving = observeTask(
      database().transaction(async (tx) => {
        await tx
          .select({ id: site.id })
          .from(site)
          .where(eq(site.id, value.siteId))
          .for("update");
        started.release();
        await release.promise;
        await tx
          .select({ id: receivingAccount.id })
          .from(receivingAccount)
          .where(eq(receivingAccount.id, value.accountId))
          .for("update");
      }),
      pending,
    );
    let quoting: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await Promise.race([
        started.promise,
        reserving.then((result) => {
          taskValue(result);
          throw new Error(
            "Reservation locks completed before the controlled gate",
          );
        }),
      ]);
      quoting = observeTask(
        createGiftQuoteRepository(database(), { now: () => new Date() }).append(
          snapshot,
        ),
        pending,
      );
      await waitForOwnSiteWait();
    } finally {
      release.release();
      await Promise.all(pending);
      await database()
        .delete(giftQuoteRecord)
        .where(eq(giftQuoteRecord.id, snapshot.quote.id));
    }
    expect(await reserving).toMatchObject({ status: "fulfilled" });
    expect(await quoting).toMatchObject({ status: "fulfilled" });
  });
  it("keeps a paid gift published and allows more independent guest purchases", async () => {
    const value = await fixture();
    const db = database();
    const repository = createGiftCheckoutRepository(db, options());
    const { checkout } = service(value, repository);
    const first = await checkout.createCheckout(value.siteId, value.body);
    const receivePayment = async (body: CheckoutDatabaseFixture["body"]) => {
      const existing = await repository.findByRequest(
        value.siteId,
        body.requestId,
      );
      const providerCheckoutReference =
        existing?.evidence?.providerCheckoutReference;
      if (!existing || !providerCheckoutReference)
        throw new Error("Missing provider checkout");
      const scope = {
        siteId: value.siteId,
        accountId: value.accountId,
        environment: "sandbox" as const,
      };
      const { accountReference } = value.snapshot.receiving;
      const eventId = randomUUID(),
        eventReference = randomUUID(),
        paymentId = randomUUID();
      const leaseOwner = randomUUID(),
        leaseToken = randomUUID();
      const payload = {
        checkoutId: providerCheckoutReference,
        paymentId,
        externalReference: existing.attemptId,
      };
      const eventType = "PAYMENT_RECEIVED";
      const authenticatedAt = new Date();
      await db.insert(financialEventInbox).values({
        ...scope,
        id: eventId,
        deliveryId: eventId,
        providerEventReference: eventReference,
        eventType,
        payload,
        payloadHash: hashAsaasEventIdentity(
          eventReference,
          eventType,
          accountReference,
          payload,
        ),
        receivedAt: authenticatedAt,
        authenticatedAt,
        state: "CLAIMED",
        attempts: 1,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      });
      const posting = createGiftPaymentPostingRepository(db, {
        environment: "sandbox",
        platformWalletId: "platform-wallet",
        retryDelayMs: 5000,
        now: () => new Date(),
        generateId: () => randomUUID(),
      });
      await expect(
        posting.postReceivedPayment({
          claim: { ...scope, eventId, leaseOwner, leaseToken },
          checkout: {
            ...scope,
            orderId: existing.orderId,
            attemptId: existing.attemptId,
            accountReference,
            providerCheckoutReference,
          },
          observation: {
            source: "provider",
            provider: "ASAAS",
            siteId: value.siteId,
            environment: "sandbox",
            accountReference,
            currency: "BRL",
            observedAt: new Date(),
            payment: {
              id: paymentId,
              checkoutSession: providerCheckoutReference,
              externalReference: existing.attemptId,
              billingType: "PIX",
              status: "RECEIVED",
              value: "102.00",
              netValue: "102.00",
              split: [
                {
                  id: randomUUID(),
                  walletId: "platform-wallet",
                  fixedValue: "2.00",
                  totalValue: "2.00",
                  status: "DONE",
                },
              ],
            },
          },
        }),
      ).resolves.toMatchObject({ outcome: "POSTED" });
      await expect(
        checkout.getStatus(value.siteId, body),
      ).resolves.toMatchObject({ state: "RECEIVED" });
    };
    await receivePayment(value.body);
    const readReadiness = (siteId: string) =>
      readReceivingReadiness(db, siteId, receivingOptions());
    await expect(
      readPublicGifts(db, value.siteId, {
        readReadiness,
        applicationEnvironment: "test",
      }),
    ).resolves.toMatchObject({ gifts: [{ id: value.giftId }] });
    const quoteService = createGiftQuoteService({
      findPublishedGift: (siteId, giftId) =>
        findPublishedGiftForQuote(db, siteId, giftId, {
          readReadiness,
          applicationEnvironment: "test",
        }),
      loadReceivingContext: (siteId) =>
        loadReceivingContext(db, siteId, receivingOptions()),
      loadPricingPolicy: async (scope) => ({
        ...scope,
        verification: "verified",
        provenance: "local-test",
        policy: value.snapshot.pricing.policy,
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      }),
      repository: createGiftQuoteRepository(db, { now: () => new Date() }),
      now: () => new Date(),
      generateId: () => randomUUID(),
      quoteTtlMs: 30000,
      pricingFreshnessMs: 30000,
    });
    const purchaseAgain = async () => {
      const quote = await quoteService.createQuote(value.siteId, {
        giftId: value.giftId,
        method: "PIX",
      });
      expect(quote.giftId).toBe(value.giftId);
      const body = {
        quoteId: quote.id,
        requestId: randomUUID(),
        recoveryToken: randomBytes(32).toString("base64url"),
      };
      const result = await service(
        { ...value, quoteId: quote.id },
        repository,
      ).checkout.createCheckout(value.siteId, body);
      return { result, body };
    };
    const later = (
      await Promise.allSettled([purchaseAgain(), purchaseAgain()])
    ).map(taskValue);
    for (const guest of later) await receivePayment(guest.body);
    await expect(
      checkout.getStatus(value.siteId, value.body),
    ).resolves.toMatchObject({ state: "RECEIVED" });
    expect(
      new Set([first.orderId, ...later.map(({ result }) => result.orderId)])
        .size,
    ).toBe(3);
    const orderRows = await db
      .select()
      .from(giftOrder)
      .where(eq(giftOrder.siteId, value.siteId));
    expect(orderRows).toHaveLength(3);
    const receipts = await db
      .select()
      .from(financialLedgerEntry)
      .where(eq(financialLedgerEntry.siteId, value.siteId));
    expect(receipts).toHaveLength(3);
    const gifts = await db
      .select()
      .from(giftItem)
      .where(eq(giftItem.id, value.giftId));
    expect(gifts).toMatchObject([
      { publicationState: "PUBLISHED", nominalCents: 10000 },
    ]);
  });
  it("rejects checkout after an overlapping settings transaction commits first", async () => {
    const value = await fixture();
    await database()
      .update(user)
      .set({ role: "OWNER" })
      .where(eq(user.id, value.operatorUserId));
    const started = gate(),
      release = gate(),
      pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const changing = observeTask(
      updateGiftPricingSettings(
        beforeCommitDatabase(started, release),
        { userId: value.operatorUserId, role: "OWNER" },
        value.siteId,
        { feeAllocation: "BUYER_GROSS_UP", revision: 0 },
      ),
      pending,
    );
    const { checkout, provider } = service(value);
    let issuing: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await started.promise;
      issuing = observeTask(
        checkout.createCheckout(value.siteId, value.body),
        pending,
      );
      await waitForOwnSiteWait();
    } finally {
      release.release();
      await Promise.all(pending);
    }
    expect((await changing).status).toBe("fulfilled");
    expect(await issuing).toMatchObject({
      status: "rejected",
      reason: { code: "QUOTE_EXPIRED" },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(
      (await readGiftPricingSettings(database(), value.siteId)).revision,
    ).toBe(1);
    expect(
      await database()
        .select()
        .from(giftOrder)
        .where(eq(giftOrder.siteId, value.siteId)),
    ).toEqual([]);
  });
  it("preserves an issued commitment when an overlapping settings update waits for reserve", async () => {
    const value = await fixture();
    await database()
      .update(user)
      .set({ role: "OWNER" })
      .where(eq(user.id, value.operatorUserId));
    const started = gate(),
      release = gate(),
      pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const repository = createGiftCheckoutRepository(
      beforeCommitDatabase(started, release),
      options(),
    );
    const { checkout, provider } = service(value, repository);
    const issuing = observeTask(
      checkout.createCheckout(value.siteId, value.body),
      pending,
    );
    let changing: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await Promise.race([
        started.promise,
        issuing.then((result) => {
          taskValue(result);
          throw new Error(
            "Reservation completed before the controlled commit gate",
          );
        }),
      ]);
      changing = observeTask(
        updateGiftPricingSettings(
          database(),
          { userId: value.operatorUserId, role: "OWNER" },
          value.siteId,
          { feeAllocation: "BUYER_GROSS_UP", revision: 0 },
        ),
        pending,
      );
      await waitForOwnSiteWait();
    } finally {
      release.release();
      await Promise.all(pending);
    }
    expect(await changing).toMatchObject({ status: "fulfilled" });
    const original = taskValue(await issuing);
    expect(await checkout.createCheckout(value.siteId, value.body)).toEqual(
      original,
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });
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
            .delete(financialLedgerEntry)
            .where(eq(financialLedgerEntry.siteId, value.siteId));
          await tx
            .delete(financialEventInbox)
            .where(eq(financialEventInbox.siteId, value.siteId));
          await tx
            .delete(giftPaymentRecord)
            .where(eq(giftPaymentRecord.siteId, value.siteId));
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
            .where(eq(giftQuoteRecord.siteId, value.siteId));
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
