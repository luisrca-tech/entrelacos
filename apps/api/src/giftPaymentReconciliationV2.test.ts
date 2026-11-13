import type { GiftQuote } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import {
  type GiftPaymentReconciliationV2Input,
  giftReceivedEffectKey,
  reconcileGiftPaymentObservation,
  reconcileGiftPaymentObservationV2,
} from "./giftPaymentReconciliation";
import { buildGiftV2Settlement } from "./giftQuotes";

const now = new Date("2026-11-13T12:00:00.000Z");
const observedAt = new Date("2026-11-13T11:59:59.000Z");

function v2Quote(
  nominalCents: number,
  method: GiftQuote["method"],
  installmentCount?: number,
): GiftQuote {
  return {
    id: "quote-v2",
    siteId: "site-1",
    giftId: "gift-1",
    title: "A contribution",
    method,
    currency: "BRL",
    commissionBasisPoints: 200,
    expiresAt: "2026-11-13T11:05:00.000Z",
    mode: "sandbox",
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
    ...quoteGiftPurchaseAmounts(
      { nominalCents, method, policy: platformTariffPolicy(method) },
      installmentCount,
    ),
  } as GiftQuote;
}

const brl = (value: number) => (value / 100).toFixed(2);

function fixture(
  quote = v2Quote(10_000, "PIX"),
  payment: Record<string, unknown> = {},
  eventType = "PAYMENT_SPLIT_DONE",
): GiftPaymentReconciliationV2Input & { splitCents: number } {
  const settlement = buildGiftV2Settlement(quote);
  const installment = (quote.installmentCount ?? 1) > 1;
  const splitCents = settlement.recipientSplitCents[0];
  const gross = installment
    ? (quote.installmentCents?.[0] as number)
    : quote.totalCents;
  const receiving = {
    siteId: "site-1",
    provider: "ASAAS",
    operatorReference: "operator-1",
    environment: "sandbox" as const,
    accountReference: "couple-account-1",
    recipientReference: "couple-wallet-1",
    destinationVersion: 1,
    bankReference: "bank-1",
  };
  return {
    splitCents,
    eventType,
    quoteSnapshot: {
      quote,
      settlement,
      gift: {
        id: "gift-1",
        siteId: "site-1",
        title: "A contribution",
        description: "",
        nominalCents: quote.nominalCents,
        currency: "BRL",
        image: null,
        sortOrder: 0,
      },
      receiving,
      pricing: {
        ...receiving,
        verification: "verified",
        provenance: "provider",
        observedAt: "2026-11-13T10:59:00.000Z",
        expiresAt: "2026-11-13T11:10:00.000Z",
        policy: platformTariffPolicy(quote.method),
      },
      createdAt: "2026-11-13T11:00:00.000Z",
      expiresAt: "2026-11-13T11:05:00.000Z",
    } as unknown as GiftPaymentReconciliationV2Input["quoteSnapshot"],
    checkout: {
      siteId: "site-1",
      accountId: "account-1",
      orderId: "order-1",
      attemptId: "attempt-1",
      providerCheckoutReference: installment ? "plan-1" : "checkout-1",
      accountReference: "couple-account-1",
      environment: "sandbox",
    },
    platformWalletId: "platform-wallet-1",
    observation: {
      source: "provider",
      provider: "ASAAS",
      siteId: "site-1",
      accountReference: "couple-account-1",
      environment: "sandbox",
      currency: "BRL",
      observedAt,
      payment: {
        id: "pay_1",
        ...(installment
          ? { installment: "plan-1", installmentNumber: 1 }
          : { checkoutSession: "checkout-1" }),
        externalReference: "attempt-1",
        billingType: quote.method,
        status: "RECEIVED",
        value: brl(gross),
        netValue: brl(gross - 100),
        split: [
          {
            id: "split-1",
            walletId: "couple-wallet-1",
            fixedValue: brl(splitCents),
            totalValue: brl(splitCents),
            status: "DONE",
          },
        ],
        ...payment,
      },
    },
    now,
  };
}

describe("V2 platform-account split reconciliation", () => {
  it("credits the couple split once, on PAYMENT_SPLIT_DONE, with the c.2 allocation", () => {
    const input = fixture();
    const gross = input.quoteSnapshot.quote.totalCents;
    const result = reconcileGiftPaymentObservationV2(input);
    expect(result).toMatchObject({
      outcome: "RECEIVED",
      alert: null,
      effect: {
        effectKey: giftReceivedEffectKey("pay_1"),
        kind: "GIFT_RECEIVED",
        amountCents: input.splitCents,
      },
      payment: {
        grossCents: gross,
        processingCents: 100,
        recipientNetCents: input.splitCents,
        platformNetCents: gross - 100 - input.splitCents,
        commissionCents: gross - 100 - input.splitCents,
        splitProviderReference: "split-1",
        splitDivergenceBlocked: false,
      },
    });
    expect(result).not.toHaveProperty("platformAdjustmentCents");
    // The same observation always yields the same effect key (ledger idempotency).
    expect(reconcileGiftPaymentObservationV2(fixture()).effect?.effectKey).toBe(
      result.effect?.effectKey,
    );
  });

  it("credits an installment split for a CONFIRMED anticipated charge", () => {
    const quote = v2Quote(10_000, "CREDIT_CARD", 3);
    const input = fixture(quote, {
      status: "CONFIRMED",
      anticipation: { id: "ant-1", status: "CREDITED", fee: "1.23" },
    });
    expect(reconcileGiftPaymentObservationV2(input)).toMatchObject({
      outcome: "RECEIVED",
      effect: { amountCents: input.splitCents },
      payment: {
        installmentNumber: 1,
        providerInstallmentReference: "plan-1",
        anticipationCents: 123,
        anticipationReference: "ant-1",
      },
    });
  });

  it.each([
    "PAYMENT_CONFIRMED",
    "PAYMENT_RECEIVED",
    "PAYMENT_ANTICIPATED",
  ])("only records %s", (eventType) => {
    const result = reconcileGiftPaymentObservationV2(
      fixture(undefined, {}, eventType),
    );
    expect(result).toMatchObject({
      outcome: "OBSERVED",
      effect: null,
      alert: null,
    });
  });

  it("retries SPLIT_DONE while the split or payment is not settled", () => {
    const pending = (payment: Record<string, unknown>) =>
      reconcileGiftPaymentObservationV2(fixture(undefined, payment));
    expect(pending({ status: "PENDING" })).toMatchObject({
      outcome: "PENDING",
      reason: "PAYMENT_NOT_RECEIVED",
      effect: null,
    });
    const split = fixture().observation.payment as { split: object[] };
    expect(
      pending({ split: [{ ...split.split[0], status: "AWAITING_CREDIT" }] }),
    ).toMatchObject({ outcome: "PENDING", reason: "SPLIT_NOT_SETTLED" });
    expect(
      pending({ split: [{ ...split.split[0], totalValue: "1.00" }] }),
    ).toMatchObject({ outcome: "PENDING", reason: "SPLIT_MISMATCH" });
    expect(
      pending({ split: [{ ...split.split[0], walletId: "other-wallet" }] }),
    ).toMatchObject({ outcome: "PENDING", reason: "SPLIT_MISMATCH" });
  });

  it("blocks on a split value divergence with a critical alert and no credit", () => {
    const input = fixture(
      undefined,
      {
        split: [
          {
            id: "split-1",
            walletId: "couple-wallet-1",
            fixedValue: "100.00",
            status: "BLOCKED_BY_VALUE_DIVERGENCE",
          },
        ],
      },
      "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
    );
    expect(reconcileGiftPaymentObservationV2(input)).toMatchObject({
      outcome: "OBSERVED",
      effect: null,
      payment: { splitDivergenceBlocked: true, recipientNetCents: null },
      alert: { kind: "SPLIT_DIVERGENCE_BLOCK", severity: "critical" },
    });
  });

  it.each([
    "PAYMENT_SPLIT_CANCELLED",
    "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
  ])("alerts a cancelled split on %s without credit", (eventType) => {
    const split = (fixture().observation.payment as { split: object[] })
      .split[0];
    expect(
      reconcileGiftPaymentObservationV2(
        fixture(
          undefined,
          { split: [{ ...split, status: "CANCELLED" }] },
          eventType,
        ),
      ),
    ).toMatchObject({
      outcome: "OBSERVED",
      effect: null,
      alert: { kind: "SPLIT_CANCELLED", severity: "critical" },
    });
  });

  it.each([
    "RECEIVABLE_ANTICIPATION_DENIED",
    "RECEIVABLE_ANTICIPATION_CANCELLED",
  ])("warns on %s without credit", (eventType) => {
    expect(
      reconcileGiftPaymentObservationV2(
        fixture(
          v2Quote(10_000, "CREDIT_CARD", 3),
          {
            status: "CONFIRMED",
            anticipation: { id: "ant-1", status: "DENIED" },
          },
          eventType,
        ),
      ),
    ).toMatchObject({
      outcome: "OBSERVED",
      effect: null,
      payment: { anticipationCents: null },
      alert: {
        kind: "ANTICIPATION_DENIED",
        severity: "warning",
        details: { anticipationStatus: "DENIED" },
      },
    });
  });

  it.each([
    { status: "REFUNDED" },
    { status: "CHARGEBACK_REQUESTED" },
    { refunds: [{ id: "refund-1" }] },
    { chargeback: { status: "REQUESTED" } },
  ])("stays fail-closed and alerts a restricted payment (%o)", (payment) => {
    expect(
      reconcileGiftPaymentObservationV2(fixture(undefined, payment)),
    ).toMatchObject({
      outcome: "PENDING",
      reason: "PAYMENT_RESTRICTED",
      effect: null,
      alert: { kind: "PAYMENT_RESTRICTION", severity: "critical" },
    });
  });

  it("expects the lowered couple split after a divergence top-up", () => {
    const base = fixture();
    const topUp = 250;
    const split = (base.observation.payment as { split: object[] }).split[0];
    const input = fixture(undefined, {
      split: [
        {
          ...split,
          fixedValue: brl(base.splitCents - topUp),
          totalValue: brl(base.splitCents - topUp),
        },
      ],
    });
    expect(reconcileGiftPaymentObservationV2(input)).toMatchObject({
      outcome: "PENDING",
      reason: "SPLIT_MISMATCH",
    });
    expect(
      reconcileGiftPaymentObservationV2({ ...input, splitTopUpCents: topUp }),
    ).toMatchObject({
      outcome: "RECEIVED",
      effect: { amountCents: base.splitCents - topUp },
    });
  });

  it("refuses V1 quotes and V2 quotes whose frozen settlement drifted", () => {
    const input = fixture();
    const v1 = {
      ...input,
      quoteSnapshot: {
        ...input.quoteSnapshot,
        quote: {
          ...input.quoteSnapshot.quote,
          settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
        },
      },
    } as GiftPaymentReconciliationV2Input;
    expect(() => reconcileGiftPaymentObservationV2(v1)).toThrow(
      expect.objectContaining({ code: "PAYMENT_QUOTE_INVALID" }),
    );
    const drifted = {
      ...input,
      quoteSnapshot: {
        ...input.quoteSnapshot,
        settlement: {
          ...input.quoteSnapshot.settlement,
          recipientSplitCents: [input.splitCents + 1],
        },
      },
    } as GiftPaymentReconciliationV2Input;
    expect(() => reconcileGiftPaymentObservationV2(drifted)).toThrow(
      expect.objectContaining({ code: "PAYMENT_QUOTE_INVALID" }),
    );
  });

  it("refuses a split paid to another binding", () => {
    const input = fixture();
    expect(() =>
      reconcileGiftPaymentObservationV2({
        ...input,
        observation: { ...input.observation, accountReference: "other" },
      }),
    ).toThrow(expect.objectContaining({ code: "PAYMENT_BINDING_MISMATCH" }));
  });

  it("leaves the V1 reconciler unaware of V2 split semantics", () => {
    // V1 expects the platform wallet split; the couple split is a mismatch there.
    const { eventType: _event, splitCents: _split, ...input } = fixture(
      v2Quote(10_000, "PIX"),
    );
    expect(reconcileGiftPaymentObservation(input)).toMatchObject({
      outcome: "DIVERGENT",
      reason: "SPLIT_MISMATCH",
    });
  });
});
