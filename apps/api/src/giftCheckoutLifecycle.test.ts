import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import { createGiftCheckoutLifecycleWorker } from "./giftCheckoutLifecycle";

function fixture(eventType = "CHECKOUT_CANCELED") {
  const now = new Date("2026-10-16T16:00:00.000Z");
  const payload = {
    checkoutId: "checkout-one",
    externalReference: "attempt-one",
  };
  const row = {
    eventId: "event-one",
    siteId: "site-one",
    accountId: "account-one",
    environment: "sandbox",
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
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      statements.push({ sql, params });
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) return { rows: present ? [row] : [] };
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
    environment: "sandbox",
    instanceId: "worker-one",
    reader: { listCheckoutPayments: read },
    now: () => now,
  });
  return {
    worker,
    row,
    read,
    statements,
    empty: () => {
      present = false;
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
