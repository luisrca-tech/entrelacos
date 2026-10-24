import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  createGiftPaymentRestrictionWorker,
  giftPaymentRestrictionEvents,
} from "./giftPaymentRestrictions";

function fixture(
  eventType = "PAYMENT_REFUNDED",
  overrides: Partial<
    Parameters<typeof createGiftPaymentRestrictionWorker>[0]
  > = {},
) {
  const now = new Date("2026-10-19T12:00:00.000Z");
  const payload = { paymentId: "pay_one", externalReference: "attempt-one" };
  const row = {
    eventId: "event-one",
    siteId: "site-one",
    accountId: "account-one",
    environment: overrides.environment ?? "sandbox",
    eventType,
    payload,
    payloadHash: hashAsaasEventIdentity(
      "evt_one",
      eventType,
      "remote-one",
      payload,
    ),
    providerEventReference: "evt_one",
    provider: "ASAAS",
    accountReference: "remote-one",
    isDemo: true,
    receivedAt: now,
    authenticatedAt: now,
    nextAttemptAt: now,
    state: "RECEIVED",
    attempts: 0,
    processedAt: null,
    leaseExpiresAt: null,
  };
  const binding = {
    attemptId: "attempt-one",
    checkoutReference: "checkout-one",
    accountReference: "remote-one",
  };
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let lostFence = false;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      statements.push({ sql, params });
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      if (/^SELECT e\./.test(sql)) return { rows: [row] };
      if (/^SELECT a\./.test(sql)) return { rows: [binding] };
      if (/^UPDATE/.test(sql))
        return { rows: lostFence ? [] : [{ id: row.eventId }] };
      throw new Error("Unexpected restriction SQL");
    },
  );
  const observation = {
    source: "provider",
    provider: "ASAAS",
    siteId: row.siteId,
    accountReference: row.accountReference,
    environment: overrides.environment ?? "sandbox",
    currency: "BRL",
    observedAt: now,
    payment: {
      id: "pay_one",
      checkoutSession: "checkout-one",
      externalReference: "attempt-one",
      status: "REFUNDED",
      billingType: "PIX",
      value: "10.00",
      refunds: [{ status: "DONE", value: "10.00" }],
    },
  };
  const read = vi.fn().mockResolvedValue(observation);
  const worker = createGiftPaymentRestrictionWorker({
    db: drizzle({ query } as unknown as NodePgClient),
    environment: overrides.environment ?? "sandbox",
    instanceId: "worker-one",
    reader: { getPayment: read },
    now: () => now,
    ...overrides,
  });
  return {
    worker,
    row,
    binding,
    observation,
    read,
    statements,
    loseFence: () => {
      lostFence = true;
    },
  };
}

describe("payment restriction safety observations", () => {
  it.each(giftPaymentRestrictionEvents)(
    "keeps %s blocked after an account-bound native read without rewriting receipts",
    async (eventType) => {
      const values = fixture(eventType);
      expect(await values.worker.processNextReceivedPayment()).toEqual({
        kind: "DEAD_LETTER",
      });
      expect(values.read).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-one",
          providerAccountReference: "remote-one",
          paymentReference: "pay_one",
          leaseOwner: "worker-one",
          attempts: 1,
        }),
      );
      const completion = values.statements.find(
        ({ sql }) =>
          /last_error_code=/.test(sql) && /state='DEAD_LETTER'/.test(sql),
      );
      expect(completion?.params).toContain(
        "PAYMENT_RESTRICTION_RECONCILIATION_REQUIRED",
      );
      expect(
        values.statements.every(
          ({ sql }) =>
            !/INSERT|UPDATE "gift_payment_record"|financial_ledger_entry|state='PROCESSED'/.test(
              sql,
            ),
        ),
      ).toBe(true);
    },
  );

  it.each(["CONFIRMED", "RECEIVED", "PENDING"])(
    "retries %s without native restriction facts and never clears the safety gate",
    async (status) => {
      const values = fixture();
      values.observation.payment.status = status;
      values.observation.payment.refunds = [];
      expect(await values.worker.processNextReceivedPayment()).toEqual({
        kind: "RETRY",
      });
      expect(
        values.statements.find(({ sql }) => /state='RETRY'/.test(sql))?.params,
      ).toContain("PAYMENT_RESTRICTION_NOT_OBSERVED");
    },
  );

  it("keeps provider outages retryable", async () => {
    const values = fixture();
    values.read.mockRejectedValue(new Error("private provider error"));
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "RETRY",
    });
    expect(
      values.statements.find(({ sql }) => /state='RETRY'/.test(sql))?.params,
    ).toContain("PAYMENT_RESTRICTION_PROVIDER_UNAVAILABLE");
  });

  it.each(["siteId", "accountReference", "environment", "currency"] as const)(
    "rejects conflicting native %s",
    async (field) => {
      const values = fixture();
      Object.assign(values.observation, { [field]: "other" });
      expect(await values.worker.processNextReceivedPayment()).toEqual({
        kind: "RETRY",
      });
    },
  );

  it.each(["id", "checkoutSession", "externalReference"] as const)(
    "rejects conflicting native payment %s",
    async (field) => {
      const values = fixture();
      values.observation.payment[field] = "other";
      expect(await values.worker.processNextReceivedPayment()).toEqual({
        kind: "RETRY",
      });
    },
  );

  it("rejects a corrupted authenticated event identity before reading the provider", async () => {
    const values = fixture();
    values.row.payloadHash = "0".repeat(64);
    await expect(values.worker.processNextReceivedPayment()).rejects.toThrow();
    expect(values.read).not.toHaveBeenCalled();
  });

  it("rejects stale native observations", async () => {
    const values = fixture();
    values.observation.observedAt = new Date("2026-10-18T12:00:00.000Z");
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "RETRY",
    });
  });

  it("never reports a durable observation when the lease fence was lost", async () => {
    const values = fixture();
    values.read.mockImplementation(async () => {
      values.loseFence();
      return values.observation;
    });
    await expect(values.worker.processNextReceivedPayment()).rejects.toThrow();
  });
});

it.each([undefined, "foreign-site", "site-one"])(
  "processes only the designated live showcase event (%s)",
  async (liveDemoSiteId) => {
    const v = fixture("PAYMENT_REFUNDED", {
      environment: "live",
      applicationEnvironment: "production",
      liveDemoSiteId,
    });
    if (liveDemoSiteId === "site-one") {
      expect(await v.worker.processNextReceivedPayment()).toMatchObject({
        kind: "DEAD_LETTER",
      });
      expect(v.read).toHaveBeenCalled();
    } else {
      await expect(v.worker.processNextReceivedPayment()).rejects.toThrow();
      expect(v.read).not.toHaveBeenCalled();
    }
  },
);
