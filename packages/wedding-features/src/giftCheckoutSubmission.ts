import type { CheckoutCreateInput, GiftQuote } from "@entrelacos/contracts";
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
} from "./gifts";

const knownCheckoutRefusals = new Set([
  "QUOTE_INVALID",
  "QUOTE_EXPIRED",
  "RECEIVING_NOT_READY",
  "DESTINATION_UNVERIFIED",
  "PROVIDER_MODE_UNAVAILABLE",
  "POLICY_UNAVAILABLE",
  "VALIDATION_ERROR",
  "SITE_INACTIVE",
  "SITE_EXPIRED",
]);

export async function submitGiftCheckout(
  api: Pick<WeddingGiftsApi, "createCheckout">,
  quote: GiftQuote,
  pending: PendingGiftCheckout,
  getStorage: () => Pick<Storage, "getItem" | "removeItem">,
  isCurrent: () => boolean = () => true,
  payer?: CheckoutCreateInput["payer"],
): Promise<GiftCheckoutEvent | null> {
  if (!isCurrent()) return null;
  try {
    const checkout = await api.createCheckout(
      {
        quoteId: pending.quoteId,
        requestId: pending.requestId,
        recoveryToken: pending.recoveryToken,
        ...(payer && { payer }),
      },
      quote,
    );
    return isCurrent() ? { type: "CHECKOUT_RESOLVED", checkout } : null;
  } catch (error) {
    if (!isCurrent()) return null;
    let known =
      error instanceof WeddingGiftsApiError &&
      knownCheckoutRefusals.has(error.code);
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
