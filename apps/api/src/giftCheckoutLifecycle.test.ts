import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import { createGiftCheckoutLifecycleWorker } from "./giftCheckoutLifecycle";

function fixture(
  eventType = "CHECKOUT_CANCELED",
  overrides: Partial<
    Parameters<typeof createGiftCheckoutLifecycleWorker>[0]
  > = {},
) {
  const now = new Date("2026-10-16T16:00:00.000Z");
  const payload = {
    checkoutId: "checkout-one",
    externalReference: "attempt-one",
  };
  const row = {
    eventId: "event-one",
    siteId: "site-one",
    accountId: "account-one",
    environment: overrides.environment ?? "sandbox",
    provider: "ASAAS",
    accountReference: "remote-one",
    isDemo: true,
    orderId: "order-one",
    attemptId: "attempt-one",
    checkoutReference: "checkout-one",
    operationState: "SUCCEEDED",
    operationReference: "checkout-one",
    quoteAccountReference: "remote-one",
    eventType,
    payload,
    providerEventReference: "evt_one",
    payloadHash: hashAsaasEventIdentity(
      "evt_one",
      eventType,
      "remote-one",
      payload,
    ),
    receivedAt: now,
    authenticatedAt: now,
    attempts: 0,
    state: "RECEIVED",
    nextAttemptAt: now,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    processedAt: null,
  };
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let present = true;
  let lostFence = false;
  let outstanding = false;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      statements.push({ sql, params });
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      if (/^SELECT o.id/i.test(sql)) return { rows: [{ id: row.orderId }] };
      if (/^SELECT 1 FROM "gift_payment_record"/i.test(sql))
        return { rows: outstanding ? [{ found: 1 }] : [] };
      if (/^SELECT/i.test(sql)) return { rows: present ? [row] : [] };
      if (/^UPDATE "gift_checkout_attempt"/i.test(sql))
        return { rows: [{ id: row.attemptId }] };
      if (/^UPDATE "financial_operation"/i.test(sql))
        return {
          rows: [{ id: row.attemptId, retryAt: "2026-10-16T16:05:00.000Z" }],
        };
      if (/^UPDATE/i.test(sql))
        return { rows: lostFence ? [] : [{ id: row.eventId }] };
      throw new Error("Unexpected lifecycle SQL");
    },
  );
  const read = vi.fn().mockResolvedValue({
    source: "provider",
    provider: "ASAAS",
    siteId: row.siteId,
    accountBindingId: row.accountId,
    accountReference: row.accountReference,
    environment: row.environment,
    checkoutReference: row.checkoutReference,
    observedAt: now,
    payments: [],
  });
  const worker = createGiftCheckoutLifecycleWorker({
    db: drizzle({ query } as unknown as NodePgClient),
    environment: overrides.environment ?? "sandbox",
    instanceId: "worker-one",
    reader: {
      listCheckoutPayments: read,
      getInstallmentRemoval: vi.fn(),
      listInstallmentPayments: vi.fn(),
      removeInstallment: vi.fn(),
    },
    now: () => now,
    ...overrides,
  });
  return {
    worker,
    row,
    read,
    statements,
    empty: () => {
      present = false;
    },
    setOutstanding: () => {
      outstanding = true;
    },
    loseFence: () => {
      lostFence = true;
    },
  };
}

describe("durable checkout lifecycle", () => {
  it.each(["CHECKOUT_CREATED", "CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"])(
    "consumes %s after a scoped complete provider read without financial writes",
    async (eventType) => {
      const values = fixture(eventType);
      expect(await values.worker.processNextReceivedPayment()).toEqual({
        kind: "OBSERVED",
      });
      expect(values.read).toHaveBeenCalledWith(
        {
          provider: "ASAAS",
          siteId: "site-one",
          accountBindingId: "account-one",
          accountReference: "remote-one",
          environment: "sandbox",
        },
        "checkout-one",
      );
      expect(
        values.statements.some(({ sql }) =>
          /financial_ledger_entry|INSERT/i.test(sql),
        ),
      ).toBe(false);
      expect(
        values.statements.find(({ sql }) => /state='PROCESSED'/.test(sql))
          ?.params,
      ).toContain(
        eventType === "CHECKOUT_CREATED"
          ? "CHECKOUT_CREATED_OBSERVED"
          : `${eventType}_EMPTY`,
      );
    },
  );
  it("never closes canceled checkout with an outstanding provider payment", async () => {
    const values = fixture();
    values.read.mockResolvedValueOnce({
      ...(await values.read()),
      payments: [
        { id: "pay_one", checkoutSession: "checkout-one", status: "PENDING" },
      ],
    });
    values.read.mockClear();
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "RETRY",
    });
    expect(
      values.statements.some(({ sql }) => /state='PROCESSED'/.test(sql)),
    ).toBe(false);
  });
  it("consumes paid checkout only when the provider lists its original payment, without granting settlement", async () => {
    const values = fixture("CHECKOUT_PAID");
    values.read.mockResolvedValueOnce({
      ...(await values.read()),
      payments: [
        {
          id: "pay_one",
          checkoutSession: "checkout-one",
          externalReference: "attempt-one",
          status: "CONFIRMED",
        },
      ],
    });
    values.read.mockClear();
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "OBSERVED",
    });
    expect(
      values.statements.some(({ sql }) =>
        /gift_payment_record|financial_ledger_entry|INSERT/i.test(sql),
      ),
    ).toBe(false);
  });
  it("retries a paid event whose payment has not become visible", async () => {
    const values = fixture("CHECKOUT_PAID");
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "RETRY",
    });
  });
  it("does not read the provider when the immutable event hash is inconsistent", async () => {
    const values = fixture();
    values.row.payloadHash = "0".repeat(64);
    await expect(values.worker.processNextReceivedPayment()).rejects.toThrow();
    expect(values.read).not.toHaveBeenCalled();
  });
  it("does not acknowledge a lifecycle observation after its lease fence is lost", async () => {
    const values = fixture();
    values.read.mockImplementationOnce(async () => {
      values.loseFence();
      return {
        source: "provider",
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "account-one",
        accountReference: "remote-one",
        environment: "sandbox",
        checkoutReference: "checkout-one",
        observedAt: new Date("2026-10-16T16:00:00.000Z"),
        payments: [],
      };
    });
    await expect(values.worker.processNextReceivedPayment()).rejects.toThrow();
  });
  it("is idle when no due original checkout event exists", async () => {
    const values = fixture();
    values.empty();
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "IDLE",
    });
    expect(values.read).not.toHaveBeenCalled();
  });
});

it.each([undefined, "foreign-site", "site-one"])(
  "processes only the designated live showcase event (%s)",
  async (liveDemoSiteId) => {
    const v = fixture("CHECKOUT_CANCELED", {
      environment: "live",
      applicationEnvironment: "production",
      liveDemoSiteId,
    });
    if (liveDemoSiteId === "site-one") {
      expect(await v.worker.processNextReceivedPayment()).toMatchObject({
        kind: "OBSERVED",
      });
      expect(v.read).toHaveBeenCalled();
    } else {
      await expect(v.worker.processNextReceivedPayment()).rejects.toThrow();
      expect(v.read).not.toHaveBeenCalled();
    }
  },
);

it.each([
  {
    removed: true,
    outstanding: false,
    kind: "OBSERVED",
    code: "PAYMENT_DELETED_INSTALLMENT_EMPTY",
  },
  {
    removed: false,
    outstanding: false,
    kind: "RETRY",
    code: "CHECKOUT_PAYMENT_OUTSTANDING",
  },
  {
    removed: true,
    outstanding: true,
    kind: "RETRY",
    code: "CHECKOUT_PAYMENT_OUTSTANDING",
  },
])(
  "uses both provider and durable payment evidence before closing direct installments ($removed, $outstanding)",
  async ({ removed, outstanding, kind, code }) => {
    const getInstallmentRemoval = vi.fn().mockResolvedValue({
      source: "provider",
      provider: "ASAAS",
      siteId: "site-one",
      accountBindingId: "account-one",
      accountReference: "remote-one",
      environment: "sandbox",
      installmentReference: "checkout-one",
      observedAt: new Date("2026-10-16T16:00:00.000Z"),
      removed,
    });
    const f = fixture("PAYMENT_DELETED", {
      reader: {
        listCheckoutPayments: vi.fn(),
        getInstallmentRemoval,
        listInstallmentPayments: vi.fn(),
        removeInstallment: vi.fn(),
      },
    });
    const payload = {
      paymentId: "pay_one",
      externalReference: "attempt-one",
      installmentId: "checkout-one",
    };
    Object.assign(f.row, {
      installmentCount: 2,
      payload,
      payloadHash: hashAsaasEventIdentity(
        "evt_one",
        "PAYMENT_DELETED",
        "remote-one",
        payload,
      ),
    });
    if (outstanding) f.setOutstanding();
    await expect(f.worker.processNextReceivedPayment()).resolves.toEqual({
      kind,
    });
    expect(getInstallmentRemoval).toHaveBeenCalledOnce();
    expect(
      f.statements.find(({ sql }) => /SET state='(PROCESSED|RETRY)'/.test(sql))
        ?.params,
    ).toContain(code);
  },
);

it.each([
  "unpaid",
  "recovered",
  "already-paid",
  "late-receipt",
  "confirmed-parcel",
  "incomplete-plan",
  "wrong-amount",
])(
  "requires complete provider and local evidence to expire a sixty-minute installment (%s)",
  async (scenario) => {
    const removeInstallment = vi.fn().mockResolvedValue(undefined);
    const getInstallmentRemoval = vi.fn().mockResolvedValue({
      source: "provider",
      provider: "ASAAS",
      siteId: "site-one",
      accountBindingId: "account-one",
      accountReference: "remote-one",
      environment: "sandbox",
      installmentReference: "checkout-one",
      observedAt: new Date("2026-10-16T16:00:00.000Z"),
      removed: true,
    });
    const listInstallmentPayments = vi.fn();
    const values = fixture("CHECKOUT_CREATED", {
      reader: {
        listCheckoutPayments: vi.fn(),
        getInstallmentRemoval,
        listInstallmentPayments,
        removeInstallment,
      },
    });
    const one = {
      installmentCount: 1,
      totalCents: 10239,
      installmentSurchargeCents: 0,
      installmentCents: [10239],
    };
    const two = {
      installmentCount: 2,
      totalCents: 10239,
      installmentSurchargeCents: 0,
      installmentCents: [5119, 5120],
    };
    Object.assign(values.row, {
      createdAt: new Date("2026-10-16T15:00:00.000Z"),
      expiryPaymentReferences:
        scenario === "recovered" ? ["pay_1", "pay_2"] : null,
      lastErrorCode:
        scenario === "recovered" ? "INSTALLMENT_EXPIRY_DISPATCHED" : null,
      quote: {
        ...two,
        installmentOptions: [one, two],
        id: "quote-one",
        giftId: "gift-one",
        siteId: "site-one",
        title: "A contribution",
        mode: "sandbox",
        method: "CREDIT_CARD",
        currency: "BRL",
        nominalCents: 10000,
        commissionBasisPoints: 200,
        commissionCents: 200,
        processingCents: 39,
        policyVersion: "policy-one",
        feeAllocation: "BUYER_GROSS_UP",
        settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
        expiresAt: "2026-10-16T15:05:00.000Z",
      },
    });
    if (scenario === "already-paid") values.setOutstanding();
    listInstallmentPayments.mockImplementation(async () => {
      if (scenario === "late-receipt") values.setOutstanding();
      return {
        source: "provider",
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "account-one",
        accountReference: "remote-one",
        environment: "sandbox",
        installmentReference: "checkout-one",
        observedAt: new Date("2026-10-16T16:00:00.000Z"),
        payments: [1, 2]
          .slice(0, scenario === "incomplete-plan" ? 1 : 2)
          .map((installmentNumber) => ({
            id: `pay_${installmentNumber}`,
            installment: "checkout-one",
            externalReference: "attempt-one",
            installmentNumber,
            billingType: "CREDIT_CARD",
            status:
              scenario === "confirmed-parcel" && installmentNumber === 2
                ? "CONFIRMED"
                : "PENDING",
            value:
              installmentNumber === 1
                ? "51.19"
                : scenario === "wrong-amount"
                  ? "51.21"
                  : "51.20",
          })),
      };
    });
    const expected =
      scenario === "unpaid" || scenario === "recovered"
        ? "OBSERVED"
        : scenario === "already-paid"
          ? "IDLE"
          : "RETRY";
    await expect(values.worker.expireNextUnpaidInstallment()).resolves.toEqual({
      kind: expected,
    });
    if (scenario === "unpaid") {
      expect(getInstallmentRemoval).toHaveBeenCalledOnce();
      expect(
        values.statements.some(({ params }) =>
          params.includes("INSTALLMENT_EXPIRY_DISPATCHED"),
        ),
      ).toBe(true);
      expect(
        values.statements.some(({ params }) =>
          params.includes("INSTALLMENT_EXPIRY_CONFIRMED"),
        ),
      ).toBe(true);
      expect(removeInstallment).toHaveBeenCalledExactlyOnceWith(
        {
          provider: "ASAAS",
          siteId: "site-one",
          accountBindingId: "account-one",
          accountReference: "remote-one",
          environment: "sandbox",
        },
        "checkout-one",
      );
      expect(
        values.statements.filter(({ sql }) => /FOR UPDATE OF o/.test(sql)),
      ).toHaveLength(3);
      expect(
        values.statements.some(({ sql }) =>
          /UPDATE "financial_event_inbox"/.test(sql),
        ),
      ).toBe(false);
    } else {
      expect(removeInstallment).not.toHaveBeenCalled();
      if (scenario === "recovered") {
        expect(getInstallmentRemoval).toHaveBeenCalledOnce();
        expect(listInstallmentPayments).not.toHaveBeenCalled();
        expect(
          values.statements.some(({ params }) =>
            params.includes("INSTALLMENT_EXPIRY_CONFIRMED"),
          ),
        ).toBe(true);
      }
    }
  },
);

it("does not query the provider when no installment attempt is due", async () => {
  const listInstallmentPayments = vi.fn();
  const removeInstallment = vi.fn();
  const values = fixture("CHECKOUT_CREATED", {
    reader: {
      listCheckoutPayments: vi.fn(),
      getInstallmentRemoval: vi.fn(),
      listInstallmentPayments,
      removeInstallment,
    },
  });
  values.empty();
  await expect(values.worker.expireNextUnpaidInstallment()).resolves.toEqual({
    kind: "IDLE",
  });
  expect(listInstallmentPayments).not.toHaveBeenCalled();
  expect(removeInstallment).not.toHaveBeenCalled();
});
