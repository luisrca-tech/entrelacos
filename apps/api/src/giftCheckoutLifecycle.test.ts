import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decideGiftOrderTransition,
  type GiftCheckoutOrderBinding,
} from "./giftCheckoutLifecycle";
import { readPagarmeOrder } from "./pagarmeOrderClient";

function order(
  name: string,
  change: (raw: Record<string, unknown>) => void = () => {},
) {
  const raw = JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  change(raw);
  return readPagarmeOrder(raw);
}

const card: GiftCheckoutOrderBinding = {
  siteId: "site-1",
  accountId: "account-1",
  environment: "sandbox",
  orderId: "order-1",
  attemptId: "checkout-fixture-2",
  quoteId: "quote-1",
  providerOrderId: "or_fixtureOrder0002",
  method: "CREDIT_CARD",
  installments: 6,
  totalCents: 11890,
  nominalCents: 10000,
  commissionCents: 200,
  coupleSplitCents: 11031,
  coupleRecipientId: "rp_fixtureRecipient01",
  quoteExpiresAt: "2026-11-18T12:05:00.000Z",
  pixExpiresAt: null,
};
const pix: GiftCheckoutOrderBinding = {
  ...card,
  attemptId: "checkout-fixture-1",
  providerOrderId: "or_fixtureOrder0001",
  method: "PIX",
  installments: 1,
  totalCents: 10369,
  coupleSplitCents: 10000,
  pixExpiresAt: "2026-11-18T12:30:00.000Z",
};
const now = new Date("2026-11-18T12:10:00.000Z");
type ChargeJson = Record<string, unknown> & {
  last_transaction: Record<string, unknown>;
};

describe("gift order lifecycle", () => {
  it("keeps a waiting Pix order pending", () => {
    expect(
      decideGiftOrderTransition(pix, order("order-pix-pending"), now),
    ).toEqual({
      kind: "PENDING",
    });
  });

  it("marks a paid order with the expected amount and split as paid", () => {
    expect(
      decideGiftOrderTransition(card, order("order-card-paid"), now),
    ).toEqual({
      kind: "PAID",
      chargeId: "ch_fixtureCharge002",
      paidCents: 11890,
      coupleSplitCents: 11031,
    });
    expect(
      decideGiftOrderTransition(pix, order("order-pix-paid"), now),
    ).toMatchObject({
      kind: "PAID",
      paidCents: 10369,
      coupleSplitCents: 10000,
    });
  });

  it("closes failed and canceled orders, telling an expired Pix apart", () => {
    expect(
      decideGiftOrderTransition(
        {
          ...card,
          attemptId: "checkout-fixture-3",
          providerOrderId: "or_fixtureOrder0003",
        },
        order("order-card-failed"),
        now,
      ),
    ).toEqual({ kind: "CLOSED", reason: "FAILED" });
    expect(
      decideGiftOrderTransition(pix, order("order-pix-canceled"), now),
    ).toEqual({ kind: "CLOSED", reason: "CANCELED" });
    expect(
      decideGiftOrderTransition(
        pix,
        order("order-pix-canceled"),
        new Date("2026-11-18T12:31:00.000Z"),
      ),
    ).toEqual({ kind: "CLOSED", reason: "EXPIRED" });
  });

  it("reports refunds and chargebacks as reversals", () => {
    expect(
      decideGiftOrderTransition(card, order("order-card-refunded"), now),
    ).toMatchObject({
      kind: "REVERSED",
      reversal: "REFUND",
      chargeId: "ch_fixtureCharge002",
      paidCents: 11890,
    });
    expect(
      decideGiftOrderTransition(card, order("order-card-chargedback"), now),
    ).toMatchObject({ kind: "REVERSED", reversal: "CHARGEBACK" });
  });

  it("reads a paid card charge canceled by DELETE /charges as a refund", () => {
    // Pagar.me v5 charge statuses have no `refunded`: a captured card charge
    // that is cancelled comes back as `canceled` with a refunded transaction.
    const canceled = order("order-card-refunded", (raw) => {
      const charge = (raw.charges as ChargeJson[])[0];
      charge.status = "canceled";
    });
    expect(decideGiftOrderTransition(card, canceled, now)).toMatchObject({
      kind: "REVERSED",
      reversal: "REFUND",
      chargeId: "ch_fixtureCharge002",
    });
    const onlyCanceledAmount = order("order-card-refunded", (raw) => {
      const charge = (raw.charges as ChargeJson[])[0];
      charge.status = "canceled";
      charge.last_transaction.status = "voided";
    });
    expect(decideGiftOrderTransition(card, onlyCanceledAmount, now).kind).toBe(
      "REVERSED",
    );
  });

  it("never auto-debits a partial refund or cancellation", () => {
    for (const change of [
      (charge: ChargeJson) => {
        charge.status = "partial_refunded";
      },
      (charge: ChargeJson) => {
        charge.status = "canceled";
        charge.canceled_amount = 5000;
      },
      (charge: ChargeJson) => {
        charge.status = "paid";
        charge.last_transaction.status = "partial_refunded";
        charge.canceled_amount = 100;
      },
    ]) {
      const partial = order("order-card-refunded", (raw) => {
        change((raw.charges as ChargeJson[])[0]);
      });
      expect(decideGiftOrderTransition(card, partial, now)).toEqual({
        kind: "MISMATCH",
        reason: "PARTIAL_REVERSAL",
      });
    }
  });

  it("keeps an unpaid canceled card charge closed, not reversed", () => {
    const unpaid = order("order-card-refunded", (raw) => {
      const charge = (raw.charges as ChargeJson[])[0];
      charge.status = "canceled";
      delete charge.paid_amount;
      delete charge.paid_at;
      delete charge.canceled_amount;
      charge.last_transaction.status = "voided";
    });
    expect(decideGiftOrderTransition(card, unpaid, now)).toEqual({
      kind: "CLOSED",
      reason: "CANCELED",
    });
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    [
      "another checkout code",
      (raw) => {
        raw.code = "checkout-other";
      },
    ],
    [
      "a different total",
      (raw) => {
        raw.amount = 11000;
      },
    ],
    [
      "an underpaid charge",
      (raw) => {
        (raw.charges as Record<string, unknown>[])[0].paid_amount = 100;
      },
    ],
    [
      "a couple split other than the frozen amount",
      (raw) => {
        const charge = (
          raw.charges as Record<string, Record<string, unknown>>[]
        )[0];
        const split = charge.last_transaction.split as Record<
          string,
          unknown
        >[];
        split[1].amount = 10000;
      },
    ],
    [
      "a split without the couple recipient",
      (raw) => {
        const charge = (
          raw.charges as Record<string, Record<string, unknown>>[]
        )[0];
        const split = charge.last_transaction.split as Record<
          string,
          unknown
        >[];
        split[1].recipient = { id: "rp_someoneElse01" };
      },
    ],
  ])("flags %s as a mismatch and never as paid", (_label, change) => {
    expect(
      decideGiftOrderTransition(card, order("order-card-paid", change), now)
        .kind,
    ).toBe("MISMATCH");
  });

  it("flags an order that is not the stored provider order", () => {
    expect(
      decideGiftOrderTransition(
        { ...card, providerOrderId: "or_fixtureOrder9999" },
        order("order-card-paid"),
        now,
      ).kind,
    ).toBe("MISMATCH");
  });

  it("accepts the order found by code when the creation outcome was unknown", () => {
    expect(
      decideGiftOrderTransition(
        { ...card, providerOrderId: null },
        order("order-card-paid"),
        now,
      ).kind,
    ).toBe("PAID");
  });
});
