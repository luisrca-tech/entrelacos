import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperatorAlert,
  giftItem,
  giftPaymentRecord,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  site,
  siteTerm,
  user,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveFinancialOperatorAlert } from "./financialOperatorAlertRepository";
import { createFinancialOverviewRepository } from "./financialOverviewRepository";
import { createGiftPaymentComposition } from "./giftPaymentComposition";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { unresolvedGiftPaymentSql } from "./giftPaymentRestrictions";
import type { GiftPaymentWorker } from "./giftPaymentWorker";

// End to end against the test PostgreSQL with Pagar.me answered by v5
// fixtures: checkout → webhook → worker (re-read) → ledger; duplicates,
// refunds, chargebacks and the reconciliation sweep. No network is used.
let connection: DatabaseConnection | undefined;
function database() {
  if (!connection) throw new Error("Test database unavailable");
  return connection.db;
}
beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  await connection?.close();
});

const webhookUser = "entrelacos-webhook";
const webhookPassword = "w".repeat(40);
const authorization = `Basic ${Buffer.from(`${webhookUser}:${webhookPassword}`).toString("base64")}`;
const config: GiftPaymentConfig = {
  mode: "sandbox",
  providerMode: "test",
  applicationEnvironment: "test",
  secretKey: "sk_test_fixtureSecretKey",
  platformRecipientId: "rp_platformFixture01",
  webhookBasicUser: webhookUser,
  webhookCredentialsHash: createHash("sha256")
    .update(`${webhookUser}:${webhookPassword}`)
    .digest("hex"),
};
const buyer = {
  name: "Maria Convidada",
  email: "maria@example.com",
  cpf: "12345678909",
  phone: "11987654321",
};

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

type Order = Record<string, unknown> & {
  charges: Record<string, unknown>[];
};

/** A tiny in-memory Pagar.me answering POST/GET /orders from the fixtures. */
function fakePagarme() {
  const orders = new Map<string, Order>();
  const calls: string[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "POST" && url.pathname === "/core/v5/orders") {
        const body = JSON.parse(String(init?.body));
        const payment = body.payments[0];
        const template = fixtureJson(
          payment.payment_method === "pix"
            ? "order-pix-pending"
            : payment.credit_card?.card_token === "token_declined"
              ? "order-card-failed"
              : "order-card-paid",
        ) as Order;
        const id = `or_${randomUUID().replaceAll("-", "")}`;
        const charge = template.charges[0];
        const transaction = charge.last_transaction as Record<string, unknown>;
        const order: Order = {
          ...template,
          id,
          code: body.code,
          amount: payment.amount,
          charges: [
            {
              ...charge,
              id: `ch_${randomUUID().replaceAll("-", "")}`,
              code: body.code,
              amount: payment.amount,
              ...(charge.paid_amount ? { paid_amount: payment.amount } : {}),
              last_transaction: {
                ...transaction,
                amount: payment.amount,
                ...(payment.pix
                  ? {
                      expires_at: new Date(
                        Date.now() + payment.pix.expires_in * 1000,
                      ).toISOString(),
                    }
                  : {}),
                split: payment.split.map((rule: Record<string, unknown>) => ({
                  type: rule.type,
                  amount: rule.amount,
                  recipient: { id: rule.recipient_id },
                  options: rule.options,
                })),
              },
            },
          ],
        };
        orders.set(id, order);
        return reply(200, order);
      }
      const match = /^\/core\/v5\/orders\/(or_[A-Za-z0-9]+)$/.exec(
        url.pathname,
      );
      if (method === "GET" && match) {
        const order = orders.get(match[1]);
        return order ? reply(200, order) : reply(404, { message: "Not found" });
      }
      if (method === "GET" && url.pathname === "/core/v5/orders") {
        const code = url.searchParams.get("code");
        return reply(200, {
          data: [...orders.values()].filter((order) => order.code === code),
        });
      }
      return reply(404, { message: "Not found" });
    },
  );
  function setStatus(
    orderId: string,
    orderStatus: string,
    chargeStatus: string,
  ) {
    const order = orders.get(orderId) as Order;
    order.status = orderStatus;
    order.charges[0].status = chargeStatus;
    if (chargeStatus === "paid") order.charges[0].paid_amount = order.amount;
  }
  return { fetch, orders, calls, setStatus };
}

async function receivingFixture() {
  const siteId = randomUUID();
  const operatorUserId = randomUUID();
  const accountId = randomUUID();
  const recipientId = `rp_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const operatorReference = randomUUID();
  const bankReference = `ba_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const giftId = randomUUID();
  const observedAt = new Date(Date.now() - 1_000);
  const db = database();
  await db.insert(user).values({
    id: operatorUserId,
    name: "Synthetic couple recipient",
    email: `${operatorUserId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await db.insert(site).values({
    id: siteId,
    repositorySlug: `pagarme-orders-${siteId}`,
    provisioningKey: `pagarme-orders:${siteId}`,
    displayName: "Pagar.me orders fixture",
    partnerOneName: "Fixture One",
    partnerTwoName: "Fixture Two",
    eventDate: "2027-05-22",
    lifecycle: "ACTIVE",
    publicationState: "PUBLISHED",
    isDemo: true,
  });
  await db.insert(siteTerm).values({
    id: randomUUID(),
    siteId,
    startsOn: "2020-01-01",
    endsOn: "2099-12-31",
    approvedAt: observedAt,
  });
  await db.insert(receivingAccount).values({
    id: accountId,
    siteId,
    provider: "PAGARME",
    environment: "sandbox",
    operatorUserId,
    operatorReference,
    accountReference: recipientId,
    recipientReference: recipientId,
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    isCurrent: true,
    observedAt,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  await db.insert(receivingDestination).values({
    id: randomUUID(),
    siteId,
    accountId,
    environment: "sandbox",
    version: 1,
    bankReference,
    bankState: "VERIFIED",
    isCurrent: true,
    createdAt: observedAt,
  });
  const evidenceId = randomUUID();
  await db.insert(receivingVerificationEvidence).values({
    id: evidenceId,
    siteId,
    accountId,
    environment: "sandbox",
    destinationVersion: 1,
    accountReference: recipientId,
    operatorReference,
    recipientReference: recipientId,
    bankReference,
    verificationStatus: "VERIFIED",
    provenance: "SIMULATION",
    verificationReference: `pagarme-orders:${evidenceId}`,
    providerAccountState: "APPROVED",
    bankState: "VERIFIED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    observedAt,
    bankObservedAt: observedAt,
    createdAt: observedAt,
  });
  await db.insert(giftItem).values({
    id: giftId,
    siteId,
    title: "Jantar no Porto",
    description: "",
    nominalCents: 10_000,
    currency: "BRL",
    publicationState: "PUBLISHED",
    sortOrder: 0,
  });
  return { siteId, accountId, recipientId, giftId };
}

function compose(options: { now?: () => Date } = {}) {
  const pagarme = fakePagarme();
  let worker: GiftPaymentWorker | undefined;
  const refreshReceiving = vi.fn(async () => {});
  const composition = createGiftPaymentComposition(config, {
    db: database(),
    fetch: pagarme.fetch as typeof globalThis.fetch,
    refreshReceiving,
    ...(options.now ? { now: options.now } : {}),
    createWorkerLoop: (loop) => {
      worker = loop.worker;
      return { start: async () => {}, wake() {}, stop: async () => {} };
    },
  });
  const ports = composition.ports;
  if (!ports.giftPayments || !ports.pagarmeWebhook || !worker)
    throw new Error("Composition unavailable");
  return {
    pagarme,
    refreshReceiving,
    payments: ports.giftPayments,
    webhook: ports.pagarmeWebhook,
    worker,
    close: () => composition.close(),
  };
}

async function checkout(
  app: ReturnType<typeof compose>,
  siteId: string,
  giftId: string,
  method: "PIX" | "CREDIT_CARD" = "PIX",
  cardToken = "token_fixture123",
) {
  const installments = method === "PIX" ? 1 : 6;
  const quote = await app.payments.createQuote(siteId, {
    giftId,
    method,
    ...(method === "CREDIT_CARD" ? { installmentCount: installments } : {}),
  });
  const recovery = {
    quoteId: quote.id,
    requestId: randomUUID(),
    recoveryToken: `${randomUUID().replaceAll("-", "").padEnd(42, "x")}A`,
  };
  const created = await app.payments.createCheckout(siteId, {
    ...recovery,
    method,
    installments,
    ...(method === "CREDIT_CARD"
      ? {
          cardToken,
          billingAddress: {
            zipCode: "01310100",
            street: "Avenida Paulista",
            streetNumber: "1000",
            neighborhood: "Bela Vista",
            city: "São Paulo",
            state: "SP",
          },
        }
      : {}),
    buyer,
  });
  const providerOrderId = [...app.pagarme.orders.values()].find(
    (order) => order.code === created.checkoutId,
  )?.id as string;
  return { quote, recovery, created, providerOrderId };
}

function event(
  type: string,
  orderId: string,
  code: string,
  chargeId?: string,
  id = `hook_${randomUUID().replaceAll("-", "")}`,
) {
  const data = type.startsWith("order.")
    ? { id: orderId, code, charges: chargeId ? [{ id: chargeId }] : [] }
    : { id: chargeId, order: { id: orderId, code } };
  return JSON.stringify({ id, type, data });
}

async function drain(worker: GiftPaymentWorker) {
  const kinds: string[] = [];
  for (let index = 0; index < 50; index++) {
    const { kind } = await worker.processNextReceivedPayment();
    kinds.push(kind);
    if (kind === "IDLE") break;
  }
  return kinds;
}

async function ledger(siteId: string) {
  return database()
    .select({
      kind: financialLedgerEntry.kind,
      direction: financialLedgerEntry.direction,
      amountCents: financialLedgerEntry.amountCents,
      eventId: financialLedgerEntry.eventId,
      compensatesEntryId: financialLedgerEntry.compensatesEntryId,
    })
    .from(financialLedgerEntry)
    .where(eq(financialLedgerEntry.siteId, siteId))
    .orderBy(financialLedgerEntry.createdAt);
}

describe("Pagar.me checkout, webhook and ledger on PostgreSQL", () => {
  it("credits the couple once after order.paid, re-reading the order first", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { created, recovery, providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
    );
    expect(created.status).toBe("AWAITING_PAYMENT");
    expect(created.pix?.qrCode).toContain("br.gov.bcb.pix");
    const order = app.pagarme.orders.get(providerOrderId) as Order;
    expect(order.amount).toBe(10369);
    app.pagarme.setStatus(providerOrderId, "paid", "paid");
    const body = event(
      "order.paid",
      providerOrderId,
      created.checkoutId,
      String(order.charges[0].id),
    );
    await expect(app.webhook.receive(authorization, body)).resolves.toEqual({
      accepted: true,
    });
    // Duplicate delivery: 200, stored once.
    await expect(app.webhook.receive(authorization, body)).resolves.toEqual({
      accepted: true,
    });
    const inbox = await database()
      .select({
        id: financialEventInbox.id,
        type: financialEventInbox.eventType,
      })
      .from(financialEventInbox)
      .where(eq(financialEventInbox.siteId, fixture.siteId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("ORDER_PAID");
    app.pagarme.calls.length = 0;
    expect(await drain(app.worker)).toContain("POSTED");
    expect(app.pagarme.calls).toContain(
      `GET /core/v5/orders/${providerOrderId}`,
    );
    expect(await ledger(fixture.siteId)).toEqual([
      {
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        amountCents: 10_000,
        eventId: inbox[0].id,
        compensatesEntryId: null,
      },
    ]);
    const [payment] = await database()
      .select()
      .from(giftPaymentRecord)
      .where(eq(giftPaymentRecord.siteId, fixture.siteId));
    expect(payment).toMatchObject({
      providerPaymentReference: order.charges[0].id,
      providerStatus: "RECEIVED",
      verificationStatus: "VERIFIED",
      grossCents: 10369,
      commissionCents: 200,
      recipientNetCents: 10_000,
      processingCents: 169,
      splitFixedCents: 10_000,
      splitProviderReference: fixture.recipientId,
      platformNetCents: 369,
    });
    expect(
      await app.payments.getStatus(fixture.siteId, recovery),
    ).toMatchObject({ state: "RECEIVED", pix: null });
    // The couple's stored totals read the Pagar.me receipt.
    const totals = await createFinancialOverviewRepository(database(), {
      environment: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
    }).loadStoredTotals({
      provider: "PAGARME",
      siteId: fixture.siteId,
      accountBindingId: fixture.accountId,
      accountReference: fixture.recipientId,
      environment: "sandbox",
    });
    expect(totals?.totals).toMatchObject({
      nominalReceivedCents: 10_000,
      netReceivedCents: 10_000,
      commissionCents: 200,
      processingCents: 169,
    });
    // A replayed webhook after processing never posts again.
    await app.webhook.receive(
      authorization,
      event(
        "charge.paid",
        providerOrderId,
        created.checkoutId,
        String(order.charges[0].id),
      ),
    );
    await drain(app.worker);
    expect(await ledger(fixture.siteId)).toHaveLength(1);
    await app.close();
  });

  it("refuses unauthenticated webhooks with 401 and stores nothing", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { created, providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
    );
    const body = event("order.paid", providerOrderId, created.checkoutId);
    for (const header of [
      undefined,
      `Basic ${Buffer.from(`${webhookUser}:wrong-password`).toString("base64")}`,
    ]) {
      await expect(app.webhook.receive(header, body)).rejects.toMatchObject({
        status: 401,
      });
    }
    expect(
      await database()
        .select()
        .from(financialEventInbox)
        .where(eq(financialEventInbox.siteId, fixture.siteId)),
    ).toHaveLength(0);
    await app.close();
  });

  it("debits a refund once and opens a refund alert", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { created, recovery, providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
    );
    // The card was decided in the creating call: the worker re-reads and posts.
    await drain(app.worker);
    expect(await ledger(fixture.siteId)).toHaveLength(1);
    const order = app.pagarme.orders.get(providerOrderId) as Order;
    const chargeId = String(order.charges[0].id);
    // Documented v5 shape: the charge reads `canceled`, its last
    // transaction `refunded` (there is no `refunded` charge status).
    app.pagarme.setStatus(providerOrderId, "canceled", "canceled");
    order.charges[0].canceled_amount = order.amount;
    (order.charges[0].last_transaction as Record<string, unknown>).status =
      "refunded";
    await app.webhook.receive(
      authorization,
      event("charge.refunded", providerOrderId, created.checkoutId, chargeId),
    );
    await drain(app.worker);
    await app.webhook.receive(
      authorization,
      event("order.canceled", providerOrderId, created.checkoutId),
    );
    await drain(app.worker);
    const entries = await ledger(fixture.siteId);
    expect(
      entries.map((entry) => [entry.kind, entry.direction, entry.amountCents]),
    ).toEqual([
      ["GIFT_RECEIVED", "CREDIT", 10_000],
      ["GIFT_REFUNDED", "DEBIT", 10_000],
    ]);
    expect(entries[1].compensatesEntryId).not.toBeNull();
    const alerts = await database()
      .select({
        kind: financialOperatorAlert.kind,
        severity: financialOperatorAlert.severity,
      })
      .from(financialOperatorAlert)
      .where(
        and(
          eq(financialOperatorAlert.siteId, fixture.siteId),
          eq(financialOperatorAlert.paymentReference, chargeId),
        ),
      );
    expect(alerts).toEqual([{ kind: "GIFT_REFUNDED", severity: "warning" }]);
    expect(
      await app.payments.getStatus(fixture.siteId, recovery),
    ).toMatchObject({ state: "REFUNDED" });

    // The compensated refund no longer blocks withdrawals or the overview.
    const blocking = async () =>
      Number(
        (
          await database().execute(sql`SELECT COUNT(*)::int AS n
            FROM ${giftPaymentRecord} p WHERE p.site_id = ${fixture.siteId}
              AND ${unresolvedGiftPaymentSql}`)
        ).rows[0].n,
      );
    expect(await blocking()).toBe(0);
    const overview = createFinancialOverviewRepository(database(), {
      environment: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
    });
    const totals = await overview.loadStoredTotals({
      provider: "PAGARME",
      siteId: fixture.siteId,
      accountBindingId: fixture.accountId,
      accountReference: fixture.recipientId,
      environment: "sandbox",
    });
    expect(totals?.unresolvedFinancialEventCount).toBe(0);
    expect(totals?.totals).toMatchObject({
      netReceivedCents: 10_000,
      refundedCents: 10_000,
    });

    // The couple had already spent the money: the account ledger is negative
    // and the refund blocks again until the balance is covered.
    const [payment] = await database()
      .select({ id: giftPaymentRecord.id })
      .from(giftPaymentRecord)
      .where(eq(giftPaymentRecord.siteId, fixture.siteId));
    const shortfall = randomUUID();
    await database()
      .insert(financialLedgerEntry)
      .values({
        id: shortfall,
        siteId: fixture.siteId,
        accountId: fixture.accountId,
        environment: "sandbox",
        effectKey: `TEST_SHORTFALL:${shortfall}`,
        kind: "TEST_SHORTFALL",
        direction: "DEBIT",
        currency: "BRL",
        amountCents: 5_000,
        paymentId: payment.id,
      });
    expect(await blocking()).toBe(1);
    // A later gift covers the shortfall: the block clears by itself.
    await checkout(app, fixture.siteId, fixture.giftId, "CREDIT_CARD");
    await drain(app.worker);
    expect(await blocking()).toBe(0);
    // Uncovered again: only an explicit operator decision clears it.
    await database()
      .update(financialLedgerEntry)
      .set({ amountCents: 50_000 })
      .where(eq(financialLedgerEntry.id, shortfall));
    expect(await blocking()).toBe(1);
    await resolveFinancialOperatorAlert(database(), {
      environment: "sandbox",
      kind: "GIFT_REFUNDED",
      paymentReference: chargeId,
      note: "Refund absorbed by the platform",
    });
    expect(await blocking()).toBe(0);
    await app.close();
  });

  it("debits a chargeback (charge.chargeback spelling) and opens a critical alert", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { created, providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
    );
    await drain(app.worker);
    const order = app.pagarme.orders.get(providerOrderId) as Order;
    const chargeId = String(order.charges[0].id);
    app.pagarme.setStatus(providerOrderId, "paid", "chargedback");
    await app.webhook.receive(
      authorization,
      event("charge.chargeback", providerOrderId, created.checkoutId, chargeId),
    );
    await drain(app.worker);
    expect(
      (await ledger(fixture.siteId)).map((entry) => [
        entry.kind,
        entry.direction,
      ]),
    ).toEqual([
      ["GIFT_RECEIVED", "CREDIT"],
      ["GIFT_CHARGEBACK", "DEBIT"],
    ]);
    const alerts = await database()
      .select({
        kind: financialOperatorAlert.kind,
        severity: financialOperatorAlert.severity,
      })
      .from(financialOperatorAlert)
      .where(eq(financialOperatorAlert.paymentReference, chargeId));
    expect(alerts).toEqual([{ kind: "GIFT_CHARGEBACK", severity: "critical" }]);
    await app.close();
  });

  it("answers the create call with the card decision, not AWAITING_PAYMENT", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const paid = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
    );
    expect(paid.created.status).toBe("RECEIVED");
    const declined = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
      "token_declined",
    );
    expect(declined.created.status).toBe("CLOSED_UNPAID");
    await app.close();
  });

  it("debits a chargeback.received event that only names the charge", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
    );
    await drain(app.worker);
    const order = app.pagarme.orders.get(providerOrderId) as Order;
    const chargeId = String(order.charges[0].id);
    app.pagarme.setStatus(providerOrderId, "paid", "chargedback");
    await app.webhook.receive(
      authorization,
      JSON.stringify({
        id: `hook_${randomUUID().replaceAll("-", "")}`,
        type: "chargeback.received",
        data: { disputeId: "12345", chargeId, status: "OPEN" },
      }),
    );
    await drain(app.worker);
    expect((await ledger(fixture.siteId)).map((entry) => entry.kind)).toEqual([
      "GIFT_RECEIVED",
      "GIFT_CHARGEBACK",
    ]);
    const alerts = await database()
      .select({ kind: financialOperatorAlert.kind })
      .from(financialOperatorAlert)
      .where(eq(financialOperatorAlert.paymentReference, chargeId));
    expect(alerts).toEqual([{ kind: "GIFT_CHARGEBACK" }]);
    await app.close();
  });

  it("finds a chargeback on a paid order whose webhook never arrived", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    const { created, providerOrderId } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
      "CREDIT_CARD",
    );
    await drain(app.worker);
    expect(await ledger(fixture.siteId)).toHaveLength(1);
    const order = app.pagarme.orders.get(providerOrderId) as Order;
    const chargeId = String(order.charges[0].id);
    app.pagarme.setStatus(providerOrderId, "paid", "chargedback");
    // Paid two days ago; put this operation first in the sweep order.
    await database().execute(sql`UPDATE ${giftPaymentRecord}
      SET created_at = now() - interval '2 days', observed_at = now() - interval '2 days'
      WHERE site_id = ${fixture.siteId}`);
    await database().execute(sql`UPDATE financial_operation
      SET next_attempt_at = '2000-01-01T00:00:00Z'
      WHERE id = ${created.checkoutId} AND site_id = ${fixture.siteId}`);
    const mine = () =>
      app.pagarme.calls.filter((call) => call.includes(providerOrderId));
    app.pagarme.calls.length = 0;
    await drain(app.worker);
    expect(mine()).toContain(`GET /core/v5/orders/${providerOrderId}`);
    expect(
      (await ledger(fixture.siteId)).map((entry) => [
        entry.kind,
        entry.direction,
      ]),
    ).toEqual([
      ["GIFT_RECEIVED", "CREDIT"],
      ["GIFT_CHARGEBACK", "DEBIT"],
    ]);
    const alerts = await database()
      .select({ kind: financialOperatorAlert.kind })
      .from(financialOperatorAlert)
      .where(eq(financialOperatorAlert.paymentReference, chargeId));
    expect(alerts).toEqual([{ kind: "GIFT_CHARGEBACK" }]);
    // Reversed: the daily sweep stops re-reading it.
    await database().execute(sql`UPDATE financial_operation
      SET next_attempt_at = '2000-01-01T00:00:00Z'
      WHERE id = ${created.checkoutId} AND site_id = ${fixture.siteId}`);
    app.pagarme.calls.length = 0;
    await drain(app.worker);
    expect(mine()).toEqual([]);
    await app.close();
  });

  it("reconciles a checkout pending for more than 10 minutes through GET /orders/{id}", async () => {
    const fixture = await receivingFixture();
    let clock = new Date();
    const app = compose({ now: () => clock });
    const { created, providerOrderId, recovery } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
    );
    // Paid at Pagar.me, but the webhook was lost.
    app.pagarme.setStatus(providerOrderId, "paid", "paid");
    // Other suites share this database: assert only on this fixture.
    const mine = () =>
      app.pagarme.calls.filter((call) => call.includes(providerOrderId));
    await drain(app.worker);
    expect(mine()).toEqual([]);
    expect(await ledger(fixture.siteId)).toHaveLength(0);
    clock = new Date(clock.getTime() + 9 * 60_000);
    await drain(app.worker);
    expect(await ledger(fixture.siteId)).toHaveLength(0);
    clock = new Date(clock.getTime() + 2 * 60_000);
    app.pagarme.calls.length = 0;
    expect(await drain(app.worker)).toContain("POSTED");
    expect(mine()).toEqual([`GET /core/v5/orders/${providerOrderId}`]);
    expect(await ledger(fixture.siteId)).toMatchObject([
      { kind: "GIFT_RECEIVED", amountCents: 10_000 },
    ]);
    const status = await app.payments.getStatus(fixture.siteId, recovery);
    expect(status).toMatchObject({
      checkoutId: created.checkoutId,
      state: "RECEIVED",
    });
    // Once paid, the sweep leaves it alone.
    clock = new Date(clock.getTime() + 20 * 60_000);
    app.pagarme.calls.length = 0;
    await drain(app.worker);
    expect(mine()).toEqual([]);
    await app.close();
  });

  it("closes an expired Pix order canceled by Pagar.me", async () => {
    const fixture = await receivingFixture();
    let clock = new Date();
    const app = compose({ now: () => clock });
    const { created, providerOrderId, recovery } = await checkout(
      app,
      fixture.siteId,
      fixture.giftId,
    );
    app.pagarme.setStatus(providerOrderId, "canceled", "canceled");
    clock = new Date(clock.getTime() + 31 * 60_000);
    await app.webhook.receive(
      authorization,
      event("order.canceled", providerOrderId, created.checkoutId),
    );
    await drain(app.worker);
    expect(
      await app.payments.getStatus(fixture.siteId, recovery),
    ).toMatchObject({
      state: "CLOSED_UNPAID",
      closedReason: "EXPIRED",
      mayStartNewAttempt: true,
    });
    expect(await ledger(fixture.siteId)).toHaveLength(0);
    await app.close();
  });

  it("refreshes the recipient on recipient.updated and alerts on unroutable events", async () => {
    const fixture = await receivingFixture();
    const app = compose();
    await app.webhook.receive(
      authorization,
      JSON.stringify({
        id: `hook_${randomUUID().replaceAll("-", "")}`,
        type: "recipient.updated",
        data: { id: fixture.recipientId, status: "active" },
      }),
    );
    await drain(app.worker);
    expect(app.refreshReceiving).toHaveBeenCalledWith(fixture.siteId);
    const unroutable = `hook_${randomUUID().replaceAll("-", "")}`;
    const foreignOrder = `or_${randomUUID().replaceAll("-", "")}`;
    await expect(
      app.webhook.receive(
        authorization,
        JSON.stringify({
          id: unroutable,
          type: "order.paid",
          data: {
            id: foreignOrder,
            code: "unknown-checkout",
            charges: [],
          },
        }),
      ),
    ).resolves.toEqual({ accepted: true });
    // A second event for the same foreign order does not open another alert.
    await app.webhook.receive(
      authorization,
      JSON.stringify({
        id: `hook_${randomUUID().replaceAll("-", "")}`,
        type: "order.canceled",
        data: { id: foreignOrder, code: "unknown-checkout", charges: [] },
      }),
    );
    const alerts = await database()
      .select({
        kind: financialOperatorAlert.kind,
        details: financialOperatorAlert.details,
      })
      .from(financialOperatorAlert)
      .where(
        and(
          eq(financialOperatorAlert.paymentReference, foreignOrder),
          sql`${financialOperatorAlert.resolvedAt} IS NULL`,
        ),
      );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("UNROUTABLE_PLATFORM_EVENT");
    // The platform's own recipient is not a site event: no alert.
    const platformEvent = `hook_${randomUUID().replaceAll("-", "")}`;
    await app.webhook.receive(
      authorization,
      JSON.stringify({
        id: platformEvent,
        type: "recipient.updated",
        data: { id: config.platformRecipientId, status: "active" },
      }),
    );
    expect(
      await database()
        .select({ id: financialOperatorAlert.id })
        .from(financialOperatorAlert)
        .where(
          sql`${financialOperatorAlert.details}->>'eventId' = ${platformEvent}`,
        ),
    ).toEqual([]);
    expect(unroutable).toMatch(/^hook_/);
    await app.close();
  });
});

// Keep the shared database tidy enough for repeated local runs.
afterAll(async () => {
  await connection?.db.execute(sql`SELECT 1`);
});
