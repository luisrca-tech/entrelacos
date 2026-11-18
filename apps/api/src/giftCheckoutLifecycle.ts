import type { PagarmeOrderObservation } from "./pagarmeOrderClient";
import { pagarmeSplitAmounts } from "./pagarmeOrderPayload";

/**
 * Everything the backend froze for one checkout attempt; a re-read Pagar.me
 * order is only trusted when it matches these values.
 */
export interface GiftCheckoutOrderBinding {
  readonly siteId: string;
  readonly accountId: string;
  readonly environment: "sandbox" | "live";
  readonly orderId: string;
  /** Our checkout id: the Pagar.me order `code`. */
  readonly attemptId: string;
  readonly quoteId: string;
  /** Pagar.me `or_` id; null while the creation outcome is unknown. */
  readonly providerOrderId: string | null;
  readonly method: "PIX" | "CREDIT_CARD";
  readonly installments: number;
  readonly totalCents: number;
  readonly nominalCents: number;
  readonly commissionCents: number;
  /** C frozen with the quote settlement. */
  readonly coupleSplitCents: number;
  readonly coupleRecipientId: string;
  readonly quoteExpiresAt: string;
  readonly pixExpiresAt: string | null;
}

export type GiftOrderTransition =
  | { kind: "PENDING" }
  | {
      kind: "PAID";
      chargeId: string;
      paidCents: number;
      /** Amount actually sent on the couple split rule. */
      coupleSplitCents: number;
    }
  | { kind: "CLOSED"; reason: "FAILED" | "CANCELED" | "EXPIRED" }
  | {
      kind: "REVERSED";
      reversal: "REFUND" | "CHARGEBACK";
      chargeId: string;
      paidCents: number;
      coupleSplitCents: number;
    }
  | { kind: "MISMATCH"; reason: string };

/** Split rule amounts as built by pagarmeOrderPayload for this binding. */
function expectedSplit(
  binding: Pick<
    GiftCheckoutOrderBinding,
    "method" | "coupleSplitCents" | "installments" | "totalCents"
  >,
) {
  return pagarmeSplitAmounts({
    method: binding.method,
    totalCents: binding.totalCents,
    coupleSplitCents: binding.coupleSplitCents,
    installments: binding.installments,
  });
}

/** Couple amount on the order split, as built by pagarmeOrderPayload. */
export function expectedCoupleSplitCents(
  binding: Pick<
    GiftCheckoutOrderBinding,
    "method" | "coupleSplitCents" | "installments" | "totalCents"
  >,
): number {
  return expectedSplit(binding).coupleCents;
}

/**
 * Maps a re-read order onto the checkout lifecycle. Webhook bodies never get
 * here: callers pass the order returned by GET /orders/{id} (or by the
 * creating POST). Anything that does not match the frozen binding is a
 * mismatch for an operator, never a credit.
 */
export function decideGiftOrderTransition(
  binding: GiftCheckoutOrderBinding,
  order: PagarmeOrderObservation,
  now: Date,
): GiftOrderTransition {
  const mismatch = (reason: string): GiftOrderTransition => ({
    kind: "MISMATCH",
    reason,
  });
  if (order.code !== binding.attemptId) return mismatch("ORDER_CODE");
  if (binding.providerOrderId !== null && order.id !== binding.providerOrderId)
    return mismatch("ORDER_ID");
  if (order.currency !== "BRL" || order.amountCents !== binding.totalCents)
    return mismatch("ORDER_AMOUNT");
  if (order.charges.length !== 1) return mismatch("CHARGE_COUNT");
  const charge = order.charges[0];
  const method = binding.method === "PIX" ? "pix" : "credit_card";
  if (
    charge.amountCents !== binding.totalCents ||
    charge.paymentMethod !== method
  )
    return mismatch("CHARGE");
  const expected = expectedSplit(binding);
  const expectedCouple = expected.coupleCents;
  const settled = () => {
    const paid = charge.paidAmountCents ?? charge.amountCents;
    if (paid !== binding.totalCents) return "CHARGE_PAID_AMOUNT";
    if (charge.split !== null) {
      const couple = charge.split.filter(
        (rule) => rule.recipientId === binding.coupleRecipientId,
      );
      if (couple.length !== 1 || couple[0].amountCents !== expectedCouple)
        return "SPLIT";
      if (
        charge.split.reduce((sum, rule) => sum + rule.amountCents, 0) !==
        expected.ruleTotalCents
      )
        return "SPLIT_TOTAL";
    }
    if (
      binding.method === "CREDIT_CARD" &&
      charge.installments !== null &&
      charge.installments !== binding.installments
    )
      return "INSTALLMENTS";
    return null;
  };
  // Pagar.me v5 charge statuses have no `refunded`: a captured charge that is
  // cancelled (DELETE /charges/{id}) reads `canceled` with a refunded last
  // transaction. Once money was paid, a cancel is a refund, never a close.
  const wasPaid = (charge.paidAmountCents ?? 0) > 0;
  const canceledCents = charge.canceledAmountCents ?? 0;
  const partial =
    ["partial_refunded", "partial_canceled"].includes(charge.status) ||
    charge.transactionStatus === "partial_refunded" ||
    (wasPaid && canceledCents > 0 && canceledCents < binding.totalCents);
  if (charge.status !== "chargedback" && partial)
    // D11 only allows total refunds: an operator decides the couple debit.
    return mismatch("PARTIAL_REVERSAL");
  const refunded =
    charge.status === "refunded" ||
    (charge.status === "canceled" &&
      (wasPaid ||
        ["refunded", "partial_refunded"].includes(
          charge.transactionStatus ?? "",
        )));
  if (charge.status === "chargedback" || refunded) {
    const problem = settled();
    if (problem) return mismatch(problem);
    return {
      kind: "REVERSED",
      reversal: charge.status === "chargedback" ? "CHARGEBACK" : "REFUND",
      chargeId: charge.id,
      paidCents: binding.totalCents,
      coupleSplitCents: expectedCouple,
    };
  }
  if (charge.status === "paid") {
    const problem = settled();
    if (problem) return mismatch(problem);
    return {
      kind: "PAID",
      chargeId: charge.id,
      paidCents: binding.totalCents,
      coupleSplitCents: expectedCouple,
    };
  }
  if (order.status === "failed" || charge.status === "failed")
    return { kind: "CLOSED", reason: "FAILED" };
  if (order.status === "canceled" || charge.status === "canceled") {
    const expiry = binding.pixExpiresAt ?? binding.quoteExpiresAt;
    return {
      kind: "CLOSED",
      reason:
        binding.method === "PIX" && now.getTime() >= Date.parse(expiry)
          ? "EXPIRED"
          : "CANCELED",
    };
  }
  return { kind: "PENDING" };
}
