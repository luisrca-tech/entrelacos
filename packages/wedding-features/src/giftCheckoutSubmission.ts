import type {
  GiftCheckoutBillingAddress,
  GiftCheckoutBuyer,
  GiftCheckoutCreateInput,
  GiftQuote,
} from "@entrelacos/contracts";
import {
  type GiftCheckoutEvent,
  pricesUpdatedMessage,
} from "./giftCheckoutState";
import {
  clearPendingGiftCheckout,
  type PendingGiftCheckout,
} from "./giftCheckoutStorage";
import {
  getGiftErrorMessage,
  type WeddingGiftsApi,
  WeddingGiftsApiError,
  WeddingGiftsPaymentRejectedError,
} from "./gifts";

export const cardDeclinedMessage =
  "O cartão não foi aprovado. Confira os dados ou use outro cartão.";

const knownCheckoutRefusals = new Set([
  "QUOTE_INVALID",
  "QUOTE_EXPIRED",
  "QUOTE_MISMATCH",
  "INSTALLMENTS_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "RECEIVING_NOT_READY",
  "PROVIDER_MODE_UNAVAILABLE",
  "POLICY_UNAVAILABLE",
  "VALIDATION_ERROR",
  "SITE_INACTIVE",
  "SITE_EXPIRED",
]);

/** What the guest typed besides the card; the card itself is only a token. */
export type GiftCheckoutPayment = {
  buyer: GiftCheckoutBuyer;
  cardToken?: string;
  billingAddress?: GiftCheckoutBillingAddress;
};

export function giftCheckoutRequest(
  quote: Pick<GiftQuote, "method" | "installmentCount">,
  pending: Pick<PendingGiftCheckout, "quoteId" | "requestId" | "recoveryToken">,
  payment: GiftCheckoutPayment,
): GiftCheckoutCreateInput {
  return {
    quoteId: pending.quoteId,
    requestId: pending.requestId,
    recoveryToken: pending.recoveryToken,
    method: quote.method,
    installments: quote.installmentCount ?? 1,
    ...(payment.cardToken ? { cardToken: payment.cardToken } : {}),
    ...(payment.billingAddress
      ? { billingAddress: payment.billingAddress }
      : {}),
    buyer: payment.buyer,
  };
}

export async function submitGiftCheckout(
  api: Pick<WeddingGiftsApi, "createCheckout">,
  quote: GiftQuote,
  pending: PendingGiftCheckout,
  getStorage: () => Pick<Storage, "getItem" | "removeItem">,
  isCurrent: () => boolean,
  payment: GiftCheckoutPayment,
): Promise<GiftCheckoutEvent | null> {
  if (!isCurrent()) return null;
  try {
    const checkout = await api.createCheckout(
      giftCheckoutRequest(quote, pending, payment),
      quote,
    );
    if (!isCurrent()) return null;
    // A declined card closes the attempt and consumes the quote: start over
    // with a fresh quote and a new request.
    if (checkout.status === "CLOSED_UNPAID") {
      try {
        clearPendingGiftCheckout(getStorage, quote.siteId, pending);
      } catch {
        return { type: "CHECKOUT_RESOLVED", checkout };
      }
      return {
        type: "CHECKOUT_FAILED",
        unknown: false,
        invalidateQuote: true,
        requote: true,
        message: cardDeclinedMessage,
      };
    }
    return { type: "CHECKOUT_RESOLVED", checkout };
  } catch (error) {
    if (!isCurrent()) return null;
    const rejected = error instanceof WeddingGiftsPaymentRejectedError;
    let known =
      rejected ||
      (error instanceof WeddingGiftsApiError &&
        knownCheckoutRefusals.has(error.code));
    if (known) {
      try {
        clearPendingGiftCheckout(getStorage, quote.siteId, pending);
      } catch {
        known = false;
      }
    }
    // A reservation issued before the V2 cut-over is refused on revalidation:
    // quote again instead of showing an error screen.
    const requote =
      known &&
      !quote.settlementVersion &&
      error instanceof WeddingGiftsApiError &&
      (error.code === "QUOTE_INVALID" || error.code === "QUOTE_EXPIRED");
    if (known && rejected)
      return {
        type: "CHECKOUT_FAILED",
        unknown: false,
        rejected: true,
        invalidateQuote: true,
        message: getGiftErrorMessage(error),
      };
    return {
      type: "CHECKOUT_FAILED",
      unknown: !known,
      invalidateQuote: known,
      ...(requote ? { requote: true } : {}),
      message: requote
        ? pricesUpdatedMessage
        : known
          ? getGiftErrorMessage(error)
          : "Não foi possível confirmar o resultado. Aguarde antes de iniciar outro pagamento.",
    };
  }
}
