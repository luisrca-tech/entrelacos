import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftCheckoutService,
  type GiftCheckoutRecord,
  type GiftCheckoutRepository,
  type GiftCheckoutReservation,
  giftCheckoutOrderBinding,
} from "./giftCheckouts";
import {
  approvedReceivingContext,
  pagarmeQuoteSnapshot,
} from "./giftPaymentTestFixtures";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import {
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";
import { readPagarmeOrder } from "./pagarmeOrderClient";
import type { PagarmeOrderRequest } from "./pagarmeOrderPayload";

const now = new Date("2026-11-18T12:00:00.000Z");
const recoveryToken = `${"a".repeat(42)}A`;
const buyer = {
  name: "Maria Convidada",
  email: "maria@example.com",
  cpf: "12345678909",
  phone: "11987654321",
};

function order(name: string, code: string) {
  const raw = JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  raw.code = code;
  for (const charge of raw.charges) charge.code = code;
  return readPagarmeOrder(raw);
}

function snapshotFor(
  method: "PIX" | "CREDIT_CARD",
  installments = 1,
  change: Partial<Parameters<typeof pagarmeQuoteSnapshot>[0]> = {},
): GiftQuoteSnapshot {
  return pagarmeQuoteSnapshot({
    siteId: "site-1",
    quoteId: "quote-1",
    giftId: "gift-1",
    method,
    installments,
    createdAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 240_000),
    recipientId: "rp_fixtureRecipient01",
    operatorReference: "operator-1",
    bankReference: "ba_fixtureBankAcct01",
    ...change,
  });
}

function harness(
  snapshot: GiftQuoteSnapshot,
  orders: {
    createOrder: (request: PagarmeOrderRequest) => Promise<unknown>;
  } = {
    createOrder: vi.fn(async (request: PagarmeOrderRequest) =>
      order(
        snapshot.quote.method === "PIX"
          ? "order-pix-pending"
          : "order-card-paid",
        request.body.code,
      ),
    ),
  },
) {
  const records = new Map<string, GiftCheckoutRecord>();
  let ids = 0;
  const repository = {
    findByRequest: vi.fn(async (_siteId: string, requestId: string) =>
      structuredClone(records.get(requestId) ?? null),
    ),
    findQuote: vi.fn(async () => structuredClone(snapshot)),
    reserve: vi.fn(
      async (
        reservation: GiftCheckoutReservation,
        assert: Parameters<GiftCheckoutRepository["reserve"]>[1],
      ) => {
        assert({
          quoteSnapshot: structuredClone(snapshot),
          receivingContext: approvedReceivingContext(snapshot, now),
          gift: {
            gift: snapshot.gift,
            publicationState: "PUBLISHED",
            siteActive: true,
          },
        });
        const record: GiftCheckoutRecord = {
          ...structuredClone(reservation),
          state: "CREATING",
          observedAt: null,
          closedReason: null,
          providerOrderId: null,
          pix: null,
        };
        records.set(reservation.requestId, record);
        return { created: true, record: structuredClone(record) };
      },
    ),
    saveOrder: vi.fn(async (identity, saved) => {
      const record = records.get(identity.requestId) as GiftCheckoutRecord;
      record.state = "AWAITING_PAYMENT";
      record.observedAt = now.toISOString();
      record.providerOrderId = saved.id;
      record.pix = saved.charges[0].pix;
      return structuredClone(record);
    }),
    markOutcomeUnknown: vi.fn(async (identity) => {
      (records.get(identity.requestId) as GiftCheckoutRecord).state =
        "OUTCOME_UNKNOWN";
    }),
    markProviderRejected: vi.fn(async (identity) => {
      const record = records.get(identity.requestId) as GiftCheckoutRecord;
      record.state = "CLOSED_UNPAID";
      record.closedReason = "FAILED";
      record.observedAt = now.toISOString();
    }),
    loadBinding: vi.fn(async ({ attemptId }) => {
      const record = [...records.values()].find(
        (value) => value.attemptId === attemptId,
      ) as GiftCheckoutRecord;
      return giftCheckoutOrderBinding({
        ...record,
        accountId: "account-1",
        pixExpiresAt: record.pix?.expiresAt ?? null,
      });
    }),
  } satisfies GiftCheckoutRepository;
  const applyOrder = vi.fn(async () => {});
  const context = vi.fn(async () => approvedReceivingContext(snapshot, now));
  const service = createGiftCheckoutService({
    repository,
    loadReceivingContext: context,
    findPublishedGift: async () => ({
      gift: snapshot.gift,
      publicationState: "PUBLISHED",
      siteActive: true,
    }),
    orders: orders as never,
    platformRecipientId: "rp_platformFixture01",
    applyOrder,
    now: () => now,
    generateId: (kind) => `${kind}-${++ids}`,
  });
  return { service, repository, orders, applyOrder, context, records };
}

function input(change: Record<string, unknown> = {}) {
  return {
    quoteId: "quote-1",
    requestId: "request-1",
    recoveryToken,
    method: "PIX",
    installments: 1,
    buyer,
    ...change,
  };
}

async function failure(promise: Promise<unknown>) {
  return (await promise.catch((error: unknown) => error)) as {
    status: number;
    code: string;
  };
}

describe("gift checkout service (Pagar.me orders)", () => {
  it("creates a Pix order and returns the checkout id with the QR data", async () => {
    const { service, orders, repository } = harness(snapshotFor("PIX"));
    const result = await service.createCheckout("site-1", input());
    expect(result).toEqual({
      checkoutId: "attempt-2",
      status: "AWAITING_PAYMENT",
      pix: {
        qrCode: "00020101021226820014br.gov.bcb.pix2560fixture",
        qrCodeUrl:
          "https://api.pagar.me/core/v5/transactions/tran_fixtureTx0001/qrcode?payment_method=pix",
        expiresAt: "2026-11-18T12:30:00.000Z",
      },
    });
    const request = vi.mocked(orders.createOrder).mock.calls[0][0];
    expect(request.idempotencyKey).toBe("attempt-2");
    expect(request.body.code).toBe("attempt-2");
    expect(request.body.payments[0].pix?.expires_in).toBe(240);
    expect(request.body.payments[0].split[1]).toMatchObject({
      recipient_id: "rp_fixtureRecipient01",
      amount: 10000,
    });
    expect(repository.saveOrder).toHaveBeenCalledOnce();
  });

  it("sends a 6x card order with the token and hands a decided order to the worker", async () => {
    const { service, orders, applyOrder } = harness(
      snapshotFor("CREDIT_CARD", 6),
    );
    const result = await service.createCheckout(
      "site-1",
      input({
        method: "CREDIT_CARD",
        installments: 6,
        cardToken: "token_abc123",
      }),
    );
    expect(result).toEqual({
      checkoutId: "attempt-2",
      status: "AWAITING_PAYMENT",
    });
    const request = vi.mocked(orders.createOrder).mock.calls[0][0];
    expect(request.body.payments[0].credit_card).toMatchObject({
      card_token: "token_abc123",
      installments: 6,
    });
    expect(applyOrder).toHaveBeenCalledOnce();
  });

  it("returns the same checkout for a retried request without a new order", async () => {
    const { service, orders } = harness(snapshotFor("PIX"));
    const first = await service.createCheckout("site-1", input());
    const second = await service.createCheckout("site-1", input());
    expect(second).toEqual(first);
    expect(orders.createOrder).toHaveBeenCalledOnce();
    const other = await failure(
      service.createCheckout(
        "site-1",
        input({ recoveryToken: `${"b".repeat(42)}A` }),
      ),
    );
    expect(other).toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
  });

  it("rejects an expired quote with 409 before calling Pagar.me", async () => {
    const snapshot = snapshotFor("PIX", 1, {
      createdAt: new Date(now.getTime() - 400_000),
      expiresAt: new Date(now.getTime() - 1),
    });
    const { service, orders } = harness(snapshot);
    expect(
      await failure(service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "QUOTE_EXPIRED" });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("rejects more than 6 installments with 422", async () => {
    const { service, orders } = harness(snapshotFor("CREDIT_CARD", 6));
    expect(
      await failure(
        service.createCheckout(
          "site-1",
          input({
            method: "CREDIT_CARD",
            installments: 7,
            cardToken: "token_a1",
          }),
        ),
      ),
    ).toMatchObject({ status: 422, code: "INSTALLMENTS_UNAVAILABLE" });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("rejects a quote from another provider with 409", async () => {
    const { service } = harness(
      snapshotFor("PIX", 1, { provider: "LEGACY_PROVIDER" }),
    );
    expect(
      await failure(service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects a method or installment count different from the quote with 422", async () => {
    const { service } = harness(snapshotFor("CREDIT_CARD", 3));
    expect(
      await failure(
        service.createCheckout(
          "site-1",
          input({
            method: "CREDIT_CARD",
            installments: 2,
            cardToken: "token_a1",
          }),
        ),
      ),
    ).toMatchObject({ status: 422, code: "QUOTE_MISMATCH" });
  });

  it("rejects a missing or inactive couple recipient with 409", async () => {
    const snapshot = snapshotFor("PIX");
    const missing = harness(snapshot);
    missing.context.mockResolvedValue(null as never);
    expect(
      await failure(missing.service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "RECEIVING_NOT_READY" });
    const inactive = harness(snapshot);
    const context = approvedReceivingContext(snapshot, now);
    if (context.evidence) context.evidence.accountState = "under_review";
    inactive.context.mockResolvedValue(context);
    expect(
      await failure(inactive.service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "RECEIVING_NOT_READY" });
    expect(inactive.orders.createOrder).not.toHaveBeenCalled();
  });

  it("refuses the platform recipient as the couple recipient", async () => {
    const { service, orders } = harness(
      snapshotFor("PIX", 1, { recipientId: "rp_platformFixture01" }),
    );
    expect(
      await failure(service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "RECEIVING_NOT_READY" });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it("closes the attempt on a Pagar.me 4xx and reports 422", async () => {
    const createOrder = vi.fn(async () => {
      throw new PagarmeRejectedError(422, "validation_error", "invalid");
    });
    const { service, repository } = harness(snapshotFor("PIX"), {
      createOrder,
    });
    expect(
      await failure(service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 422, code: "PIX_UNAVAILABLE" });
    expect(repository.markProviderRejected).toHaveBeenCalledOnce();
    expect(repository.markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("keeps an unknown outcome (5xx/timeout) for reconciliation", async () => {
    const createOrder = vi.fn(async () => {
      throw new PagarmeUnknownOutcomeError("timeout");
    });
    const { service, repository } = harness(snapshotFor("PIX"), {
      createOrder,
    });
    expect(
      await failure(service.createCheckout("site-1", input())),
    ).toMatchObject({ status: 409, code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(repository.markOutcomeUnknown).toHaveBeenCalledOnce();
  });

  it("projects status only for the holder of the recovery token", async () => {
    const { service } = harness(snapshotFor("PIX"));
    await service.createCheckout("site-1", input());
    const status = await service.getStatus("site-1", {
      quoteId: "quote-1",
      requestId: "request-1",
      recoveryToken,
    });
    expect(status).toMatchObject({
      checkoutId: "attempt-2",
      state: "AWAITING_PAYMENT",
      method: "PIX",
    });
    expect(status.pix?.qrCode).toContain("br.gov.bcb.pix");
    expect(
      await failure(
        service.getStatus("site-1", {
          quoteId: "quote-1",
          requestId: "request-1",
          recoveryToken: `${"c".repeat(42)}A`,
        }),
      ),
    ).toMatchObject({ code: "REQUEST_CONFLICT" });
  });

  it("stores only the hash of the recovery token", async () => {
    const { service, records } = harness(snapshotFor("PIX"));
    await service.createCheckout("site-1", input());
    const stored = records.get("request-1") as GiftCheckoutRecord;
    expect(stored.recoveryTokenHash).toBe(
      createHash("sha256").update(recoveryToken).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(recoveryToken);
    expect(JSON.stringify(stored)).not.toContain(buyer.cpf);
  });
});
