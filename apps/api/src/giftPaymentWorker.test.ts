import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GiftCheckoutOrderBinding } from "./giftCheckoutLifecycle";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import { createGiftPaymentWorker } from "./giftPaymentWorker";
import { PagarmeUnknownOutcomeError } from "./pagarmeHttpClient";
import { readPagarmeOrder } from "./pagarmeOrderClient";

function order(name: string) {
  return readPagarmeOrder(
    JSON.parse(
      readFileSync(
        new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
}

const binding: GiftCheckoutOrderBinding = {
  siteId: "site-1",
  accountId: "account-1",
  environment: "sandbox",
  orderId: "order-1",
  attemptId: "checkout-fixture-1",
  quoteId: "quote-1",
  providerOrderId: "or_fixtureOrder0001",
  method: "PIX",
  installments: 1,
  totalCents: 10369,
  nominalCents: 10000,
  commissionCents: 200,
  coupleSplitCents: 10000,
  coupleRecipientId: "rp_fixtureRecipient01",
  quoteExpiresAt: "2026-11-18T12:05:00.000Z",
  pixExpiresAt: "2026-11-18T12:30:00.000Z",
};

function claim(
  change: Partial<GiftPaymentInboxClaim> = {},
): GiftPaymentInboxClaim {
  return {
    eventId: "event-1",
    siteId: "site-1",
    accountId: "account-1",
    environment: "sandbox",
    eventType: "ORDER_PAID",
    payload: {
      checkoutId: "or_fixtureOrder0001",
      paymentId: "ch_fixtureCharge001",
      externalReference: "checkout-fixture-1",
    },
    leaseToken: "lease-1",
    attempts: 1,
    ...change,
  };
}

function harness(next: GiftPaymentInboxClaim | null = claim()) {
  const inbox = {
    claimNext: vi.fn(async () => next),
    complete: vi.fn(async () => {}),
    defer: vi.fn(async () => "RETRY" as const),
  };
  const orders = {
    getOrder: vi.fn(async () => order("order-pix-paid")),
    findOrderByCode: vi.fn(async () => order("order-pix-paid")),
  };
  const posting = {
    applyOrderTransition: vi.fn(async () => ({
      outcome: "POSTED" as const,
      paymentId: "payment-1",
      ledgerEntryId: "ledger-1",
    })),
  };
  const checkouts = {
    loadBinding: vi.fn(async () => binding),
    bindRecoveredOrder: vi.fn(async () => {}),
    closeMissingOrder: vi.fn(async () => {}),
  };
  const refreshReceiving = vi.fn(async () => {});
  const worker = createGiftPaymentWorker({
    inbox,
    checkouts,
    orders,
    posting,
    refreshReceiving,
    now: () => new Date("2026-11-18T12:04:00.000Z"),
  });
  return { worker, inbox, orders, posting, checkouts, refreshReceiving };
}

describe("gift payment worker", () => {
  it("re-reads GET /orders/{id} before posting and posts the re-read order", async () => {
    const { worker, orders, posting, inbox } = harness();
    expect(await worker.processNextReceivedPayment()).toEqual({
      kind: "POSTED",
    });
    expect(orders.getOrder).toHaveBeenCalledWith("or_fixtureOrder0001");
    expect(orders.getOrder.mock.invocationCallOrder[0]).toBeLessThan(
      posting.applyOrderTransition.mock.invocationCallOrder[0],
    );
    expect(posting.applyOrderTransition).toHaveBeenCalledWith({
      binding,
      providerOrderId: "or_fixtureOrder0001",
      transition: {
        kind: "PAID",
        chargeId: "ch_fixtureCharge001",
        paidCents: 10369,
        coupleSplitCents: 10000,
      },
      eventId: "event-1",
      observedAt: new Date("2026-11-18T12:04:00.000Z"),
    });
    expect(inbox.complete).toHaveBeenCalledWith(expect.anything(), "payment-1");
  });

  it("does not credit when the re-read order is still pending, whatever the webhook said", async () => {
    const values = harness();
    values.orders.getOrder.mockResolvedValue(order("order-pix-pending"));
    await values.worker.processNextReceivedPayment();
    expect(values.posting.applyOrderTransition).toHaveBeenCalledWith(
      expect.objectContaining({ transition: { kind: "PENDING" } }),
    );
  });

  it("defers (retries) when Pagar.me cannot be read, posting nothing", async () => {
    const values = harness();
    values.orders.getOrder.mockRejectedValue(
      new PagarmeUnknownOutcomeError("server", 502),
    );
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "RETRY",
    });
    expect(values.inbox.defer).toHaveBeenCalledWith(
      expect.anything(),
      "PROVIDER_READ_UNAVAILABLE",
    );
    expect(values.posting.applyOrderTransition).not.toHaveBeenCalled();
    expect(values.inbox.complete).not.toHaveBeenCalled();
  });

  it("recovers an order by code when the creating call's outcome was unknown", async () => {
    const values = harness(
      claim({
        eventType: "ORDER_RECONCILE",
        payload: { externalReference: "checkout-fixture-1" },
      }),
    );
    values.checkouts.loadBinding.mockResolvedValue({
      ...binding,
      providerOrderId: null,
    });
    await values.worker.processNextReceivedPayment();
    expect(values.orders.findOrderByCode).toHaveBeenCalledWith(
      "checkout-fixture-1",
    );
    expect(values.orders.getOrder).not.toHaveBeenCalled();
    expect(values.checkouts.bindRecoveredOrder).toHaveBeenCalledOnce();
    expect(values.posting.applyOrderTransition).toHaveBeenCalledOnce();
  });

  it("closes an attempt Pagar.me never created once the quote is long expired", async () => {
    const values = harness(
      claim({
        eventType: "ORDER_RECONCILE",
        payload: { externalReference: "checkout-fixture-1" },
      }),
    );
    values.checkouts.loadBinding.mockResolvedValue({
      ...binding,
      providerOrderId: null,
      quoteExpiresAt: "2026-11-18T11:00:00.000Z",
    });
    values.orders.findOrderByCode.mockResolvedValue(null as never);
    await values.worker.processNextReceivedPayment();
    expect(values.checkouts.closeMissingOrder).toHaveBeenCalledOnce();
    expect(values.inbox.complete).toHaveBeenCalledOnce();
  });

  it("refreshes the recipient on recipient.updated", async () => {
    const values = harness(
      claim({
        eventType: "RECIPIENT_UPDATED",
        payload: { accountId: "rp_fixtureRecipient01" },
      }),
    );
    expect(await values.worker.processNextReceivedPayment()).toEqual({
      kind: "OBSERVED",
    });
    expect(values.refreshReceiving).toHaveBeenCalledWith("site-1");
    expect(values.orders.getOrder).not.toHaveBeenCalled();
  });

  it("is idle without events", async () => {
    expect(await harness(null).worker.processNextReceivedPayment()).toEqual({
      kind: "IDLE",
    });
  });
});
