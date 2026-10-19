import { describe, expect, it, vi } from "vitest";
import type { AsaasPaymentObservation } from "./asaasHttpClient";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import type { StoredGiftPaymentCheckoutBinding } from "./giftPaymentReconciliation";
import {
  createGiftPaymentWorker,
  type GiftPaymentWorkerOptions,
  GiftPaymentWorkerServiceError,
} from "./giftPaymentWorker";

function fixture() {
  const claim: GiftPaymentInboxClaim = {
    eventId: "event-1",
    siteId: "site-1",
    accountId: "account-1",
    environment: "sandbox",
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    paymentReference: "pay_1",
    providerAccountReference: "remote-account-1",
    attempts: 1,
  };
  const checkout: StoredGiftPaymentCheckoutBinding = {
    siteId: "site-1",
    accountId: "account-1",
    environment: "sandbox",
    orderId: "order-1",
    attemptId: "attempt-1",
    providerCheckoutReference: "checkout-1",
    accountReference: "remote-account-1",
  };
  const observation: AsaasPaymentObservation = {
    source: "provider",
    provider: "ASAAS",
    siteId: "site-1",
    accountReference: "remote-account-1",
    environment: "sandbox",
    currency: "BRL",
    observedAt: new Date("2026-10-12T12:00:00.000Z"),
    payment: {
      id: "pay_1",
      checkoutSession: "checkout-1",
      externalReference: "attempt-1",
      status: "RECEIVED",
      billingType: "PIX",
      value: "103.55",
      netValue: "102.00",
      split: [
        {
          id: "split-1",
          walletId: "platform-wallet",
          status: "DONE",
          fixedValue: "2.00",
          totalValue: "2.00",
        },
      ],
    },
  };
  const claimNextReceivedPayment = vi
    .fn()
    .mockResolvedValue({ kind: "CLAIMED", claim });
  const deferClaim = vi.fn().mockResolvedValue({ kind: "RETRY" });
  const loadCheckout = vi.fn().mockResolvedValue(checkout);
  const getPayment = vi.fn().mockResolvedValue(observation);
  const postReceivedPayment = vi.fn().mockResolvedValue({
    outcome: "POSTED",
    paymentId: "payment-1",
    ledgerEntryId: "ledger-1",
  });
  const options: GiftPaymentWorkerOptions = {
    environment: "sandbox",
    inbox: { claimNextReceivedPayment, deferClaim },
    loadCheckout,
    reader: { getPayment },
    posting: { postReceivedPayment },
  };
  return {
    options,
    claim,
    checkout,
    observation,
    claimNextReceivedPayment,
    deferClaim,
    loadCheckout,
    getPayment,
    postReceivedPayment,
  };
}

describe("single-step received payment worker", () => {
  it("recovers a payment-only webhook from its authenticated provider checkout session", async () => {
    const values = fixture();
    values.loadCheckout.mockResolvedValueOnce(null);
    values.observation.payment.externalReference = null;
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "POSTED" });
    expect(values.loadCheckout).toHaveBeenNthCalledWith(1, values.claim);
    expect(values.loadCheckout).toHaveBeenNthCalledWith(
      2,
      values.claim,
      "checkout-1",
    );
    expect(values.getPayment).toHaveBeenCalledExactlyOnceWith(values.claim);
    expect(values.postReceivedPayment).toHaveBeenCalledOnce();
  });

  it.each([
    { siteId: "foreign" },
    { accountReference: "foreign" },
    { environment: "live" },
    { payment: { id: "pay_other", checkoutSession: "checkout-1" } },
  ])(
    "does not use an unbound provider observation for checkout recovery: %j",
    async (change) => {
      const values = fixture();
      values.loadCheckout.mockResolvedValueOnce(null);
      values.getPayment.mockResolvedValueOnce({
        ...values.observation,
        ...change,
      });
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "RETRY" });
      expect(values.loadCheckout).toHaveBeenCalledOnce();
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
      expect(values.deferClaim).toHaveBeenCalledWith(
        values.claim,
        "PROVIDER_READ_UNAVAILABLE",
      );
    },
  );

  it("keeps recovery unresolved when the authenticated session has no stored checkout", async () => {
    const values = fixture();
    values.loadCheckout.mockResolvedValue(null);
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "RETRY" });
    expect(values.loadCheckout).toHaveBeenCalledTimes(2);
    expect(values.postReceivedPayment).not.toHaveBeenCalled();
    expect(values.deferClaim).toHaveBeenCalledWith(
      values.claim,
      "CHECKOUT_BINDING_UNAVAILABLE",
    );
  });

  it("rejects contradictory native external reference after fallback binding", async () => {
    const values = fixture();
    values.loadCheckout.mockResolvedValueOnce(null);
    values.observation.payment.externalReference = "foreign-attempt";
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "RETRY" });
    expect(values.postReceivedPayment).not.toHaveBeenCalled();
  });

  it("posts exactly one claimed payment using the stored checkout and authenticated server observation", async () => {
    const values = fixture();
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "POSTED" });
    expect(values.claimNextReceivedPayment).toHaveBeenCalledTimes(1);
    expect(values.loadCheckout).toHaveBeenCalledExactlyOnceWith(values.claim);
    expect(values.getPayment).toHaveBeenCalledExactlyOnceWith(values.claim);
    expect(values.postReceivedPayment).toHaveBeenCalledExactlyOnceWith({
      claim: {
        eventId: "event-1",
        siteId: "site-1",
        accountId: "account-1",
        environment: "sandbox",
        leaseOwner: "worker-1",
        leaseToken: "lease-1",
      },
      checkout: values.checkout,
      observation: values.observation,
    });
    expect(values.deferClaim).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {
      kind: "DEAD_LETTER",
      eventId: "event-1",
      errorCode: "PAYMENT_CORRELATION_INVALID",
    },
    {
      kind: "DEAD_LETTER",
      eventId: "event-1",
      errorCode: "FINANCIAL_ATTEMPT_LIMIT",
    },
  ])(
    "returns a committed inbox outcome without continuing or claiming another row: %j",
    async (result) => {
      const values = fixture();
      values.claimNextReceivedPayment.mockResolvedValueOnce(result);
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: result === null ? "IDLE" : "DEAD_LETTER" });
      expect(values.claimNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(values.loadCheckout).not.toHaveBeenCalled();
      expect(values.getPayment).not.toHaveBeenCalled();
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
      expect(values.deferClaim).not.toHaveBeenCalled();
    },
  );

  it("sanitizes a claim failure without asserting IDLE or committed acknowledgment", async () => {
    const values = fixture();
    values.claimNextReceivedPayment.mockRejectedValueOnce(
      new Error("database password=private; access_token=secret"),
    );
    const error = await createGiftPaymentWorker(values.options)
      .processNextReceivedPayment()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GiftPaymentWorkerServiceError);
    expect(error).toMatchObject({
      status: 503,
      code: "PAYMENT_WORKER_UNAVAILABLE",
      message: "Payment worker is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toMatch(/password|private|secret/);
    expect(values.loadCheckout).not.toHaveBeenCalled();
    expect(values.deferClaim).not.toHaveBeenCalled();
  });

  it.each([
    { eventId: "" },
    { siteId: "site/foreign" },
    { accountId: null },
    { environment: "live" },
    { leaseOwner: null },
    { leaseToken: "" },
    { paymentReference: "pay/1" },
    { providerAccountReference: "https://foreign.example" },
    { attempts: 0 },
    { attempts: 1.5 },
    { attempts: Number.MAX_SAFE_INTEGER + 1 },
    { role: "SITE_ADMIN" },
  ])(
    "rejects unsafe claimed identity or scope before any downstream access: %j",
    async (overrides) => {
      const values = fixture();
      values.claimNextReceivedPayment.mockResolvedValueOnce({
        kind: "CLAIMED",
        claim: { ...values.claim, ...overrides },
      });
      await expect(
        createGiftPaymentWorker(values.options).processNextReceivedPayment(),
      ).rejects.toBeInstanceOf(GiftPaymentWorkerServiceError);
      expect(values.loadCheckout).not.toHaveBeenCalled();
      expect(values.getPayment).not.toHaveBeenCalled();
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
      expect(values.deferClaim).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "CLAIMED", claim: null },
    { kind: "CLAIMED" },
    { kind: "DONE" },
    {
      kind: "DEAD_LETTER",
      eventId: "event-1",
      errorCode: "provider-private-error",
    },
  ])(
    "rejects an invalid claim result without claiming success: %j",
    async (result) => {
      const values = fixture();
      values.claimNextReceivedPayment.mockResolvedValueOnce(result);
      await expect(
        createGiftPaymentWorker(values.options).processNextReceivedPayment(),
      ).rejects.toBeInstanceOf(GiftPaymentWorkerServiceError);
      expect(values.loadCheckout).not.toHaveBeenCalled();
      expect(values.deferClaim).not.toHaveBeenCalled();
    },
  );

  it.each([
    { siteId: "other-site" },
    { accountId: "other-account" },
    { environment: "live" },
    { accountReference: "other-remote" },
    { orderId: "" },
    { attemptId: "" },
    { providerCheckoutReference: "https://foreign.example" },
    { providerApproved: true },
  ])(
    "defers unavailable or foreign checkout binding without reading the provider: %j",
    async (overrides) => {
      const values = fixture();
      values.loadCheckout.mockResolvedValueOnce(
        overrides === null ? null : { ...values.checkout, ...overrides },
      );
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "RETRY" });
      expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
        values.claim,
        "CHECKOUT_BINDING_UNAVAILABLE",
      );
      expect(values.getPayment).not.toHaveBeenCalled();
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
    },
  );

  it("defers a checkout load error with a closed safe reason", async () => {
    const values = fixture();
    values.loadCheckout.mockRejectedValueOnce(
      new Error("bank=private; database=secret"),
    );
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "RETRY" });
    expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
      values.claim,
      "CHECKOUT_BINDING_UNAVAILABLE",
    );
    expect(values.getPayment).not.toHaveBeenCalled();
  });

  it.each([
    { source: "browser" },
    { provider: "OTHER" },
    { siteId: "foreign" },
    { environment: "live" },
    { accountReference: "foreign-remote" },
    { currency: "USD" },
    { observedAt: new Date("invalid") },
    { observedAt: "2026-10-12T12:00:00.000Z" },
    { approved: true },
    { payment: null },
  ])(
    "defers an unauthenticated or cross-scope provider observation before posting: %j",
    async (overrides) => {
      const values = fixture();
      values.getPayment.mockResolvedValueOnce({
        ...values.observation,
        ...overrides,
      });
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "RETRY" });
      expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
        values.claim,
        "PROVIDER_READ_UNAVAILABLE",
      );
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: "pay_other" },
    { id: null },
    { checkoutSession: "checkout-other" },
    { externalReference: "attempt-other" },
    { currency: "USD" },
  ])(
    "defers a payment correlated to a different event or checkout: %j",
    async (payment) => {
      const values = fixture();
      values.getPayment.mockResolvedValueOnce({
        ...values.observation,
        payment: { ...values.observation.payment, ...payment },
      });
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "RETRY" });
      expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
        values.claim,
        "PROVIDER_READ_UNAVAILABLE",
      );
      expect(values.postReceivedPayment).not.toHaveBeenCalled();
    },
  );

  it("defers a provider read failure without exporting credentials or provider error text", async () => {
    const values = fixture();
    values.getPayment.mockRejectedValueOnce(
      new Error("access_token=secret; payer=private; card=private"),
    );
    const result = await createGiftPaymentWorker(
      values.options,
    ).processNextReceivedPayment();
    expect(result).toEqual({ kind: "RETRY" });
    expect(JSON.stringify(result)).not.toMatch(/token|secret|payer|card/);
    expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
      values.claim,
      "PROVIDER_READ_UNAVAILABLE",
    );
    expect(values.postReceivedPayment).not.toHaveBeenCalled();
  });

  it.each(["POSTED", "OBSERVED", "DUPLICATE", "NO_REGRESSION"])(
    "returns only the committed posting outcome %s",
    async (outcome) => {
      const values = fixture();
      values.postReceivedPayment.mockResolvedValueOnce({
        outcome,
        paymentId: "payment-1",
        ledgerEntryId: outcome === "OBSERVED" ? null : "ledger-1",
      });
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: outcome });
      expect(values.deferClaim).not.toHaveBeenCalled();
    },
  );

  it.each(["CONFIRMED", "REFUNDED", "CHARGEBACK_DISPUTE"])(
    "passes authenticated %s observations to posting without converting the received event into a receipt",
    async (status) => {
      const values = fixture();
      values.observation.payment.status = status;
      values.observation.payment.netValue = null;
      values.observation.payment.split = null;
      values.postReceivedPayment.mockResolvedValueOnce({
        outcome: "OBSERVED",
        paymentId: "payment-1",
        ledgerEntryId: null,
      });
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "OBSERVED" });
      expect(
        values.postReceivedPayment.mock.calls[0][0].observation.payment,
      ).toMatchObject({ status, netValue: null, split: null });
      expect(values.deferClaim).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined])(
    "accepts absent optional externalReference while the checkout/session identity matches: %j",
    async (externalReference) => {
      const values = fixture();
      values.observation.payment.externalReference = externalReference;
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "POSTED" });
    },
  );

  it("defers a posting failure without asserting a commit or retrying the post", async () => {
    const values = fixture();
    values.postReceivedPayment.mockRejectedValueOnce(
      new Error("commit uncertain; password=private"),
    );
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "RETRY" });
    expect(values.postReceivedPayment).toHaveBeenCalledTimes(1);
    expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
      values.claim,
      "PAYMENT_POSTING_UNAVAILABLE",
    );
  });

  it.each([
    { outcome: "UNKNOWN", paymentId: null, ledgerEntryId: null },
    null,
    { outcome: "POSTED" },
  ])("defers a malformed posting acknowledgment: %j", async (result) => {
    const values = fixture();
    values.postReceivedPayment.mockResolvedValueOnce(result);
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "RETRY" });
    expect(values.deferClaim).toHaveBeenCalledExactlyOnceWith(
      values.claim,
      "PAYMENT_POSTING_UNAVAILABLE",
    );
  });

  it("returns DEAD_LETTER only after defer commits that outcome", async () => {
    const values = fixture();
    values.getPayment.mockRejectedValueOnce(new Error("private"));
    values.deferClaim.mockResolvedValueOnce({ kind: "DEAD_LETTER" });
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "DEAD_LETTER" });
    expect(values.postReceivedPayment).not.toHaveBeenCalled();
  });

  it.each(["binding", "provider", "posting"])(
    "returns sanitized UNRESOLVED when defer after %s failure cannot confirm its commit",
    async (stage) => {
      const values = fixture();
      if (stage === "binding")
        values.loadCheckout.mockRejectedValueOnce(new Error("private"));
      if (stage === "provider")
        values.getPayment.mockRejectedValueOnce(new Error("private"));
      if (stage === "posting")
        values.postReceivedPayment.mockRejectedValueOnce(
          new Error("lost commit acknowledgment"),
        );
      values.deferClaim.mockRejectedValueOnce(
        new Error("defer commit uncertain; credentials=secret"),
      );
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "UNRESOLVED" });
      expect(values.claimNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(values.deferClaim).toHaveBeenCalledTimes(1);
    },
  );

  it("does not claim success or requeue a payment when posting committed but its acknowledgment was lost and defer preserves the completed row", async () => {
    const values = fixture();
    let committed = false;
    values.postReceivedPayment.mockImplementationOnce(async () => {
      committed = true;
      throw new Error("lost ACK");
    });
    values.deferClaim.mockImplementationOnce(async () => {
      expect(committed).toBe(true);
      throw new Error("already completed row must not be requeued");
    });
    expect(
      await createGiftPaymentWorker(
        values.options,
      ).processNextReceivedPayment(),
    ).toEqual({ kind: "UNRESOLVED" });
    expect(values.postReceivedPayment).toHaveBeenCalledTimes(1);
  });

  it.each([null, { kind: "POSTED" }, { kind: "RETRY", error: "private" }])(
    "keeps an unproven defer outcome unresolved: %j",
    async (result) => {
      const values = fixture();
      values.getPayment.mockRejectedValueOnce(new Error("private"));
      values.deferClaim.mockResolvedValueOnce(result);
      expect(
        await createGiftPaymentWorker(
          values.options,
        ).processNextReceivedPayment(),
      ).toEqual({ kind: "UNRESOLVED" });
    },
  );

  it.each([
    [
      "environment",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o, { environment: "disabled" });
      },
    ],
    [
      "inbox",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o, { inbox: undefined });
      },
    ],
    [
      "defer",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o.inbox, { deferClaim: undefined });
      },
    ],
    [
      "loader",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o, { loadCheckout: undefined });
      },
    ],
    [
      "reader",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o.reader, { getPayment: undefined });
      },
    ],
    [
      "posting",
      (o: GiftPaymentWorkerOptions) => {
        Object.assign(o.posting, { postReceivedPayment: undefined });
      },
    ],
  ])(
    "rejects incomplete server configuration before claiming: %s",
    (_name, change) => {
      const values = fixture();
      change(values.options);
      expect(() => createGiftPaymentWorker(values.options)).toThrow(
        GiftPaymentWorkerServiceError,
      );
      expect(values.claimNextReceivedPayment).not.toHaveBeenCalled();
    },
  );

  it("pins server environment and copies claim/binding across waits", async () => {
    const values = fixture();
    const worker = createGiftPaymentWorker(values.options);
    values.options.environment = "live";
    values.loadCheckout.mockImplementationOnce(async () => {
      values.claim.providerAccountReference = "other-account";
      return values.checkout;
    });
    values.getPayment.mockImplementationOnce(async () => {
      values.checkout.accountReference = "other-account";
      return values.observation;
    });
    expect(await worker.processNextReceivedPayment()).toEqual({
      kind: "POSTED",
    });
    expect(
      values.postReceivedPayment.mock.calls[0][0].checkout.accountReference,
    ).toBe("remote-account-1");
  });
});
