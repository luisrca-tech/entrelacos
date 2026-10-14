import {
  type GiftCheckoutEvent,
  type GiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  clearPendingGiftCheckout,
  retainPendingGiftCheckout,
} from "./giftCheckoutStorage";
import type { WeddingGiftsApi } from "./gifts";

export async function recoverGiftCheckout(
  api: Pick<WeddingGiftsApi, "getCheckoutStatus">,
  state: GiftCheckoutState,
  getStorage: () => Pick<Storage, "getItem" | "removeItem" | "setItem">,
  isCurrent: () => boolean = () => true,
): Promise<GiftCheckoutEvent | null> {
  const pending = state.pending;
  if (
    state.phase !== "UNKNOWN" ||
    !pending ||
    !state.pendingSiteId ||
    !isCurrent()
  )
    return null;
  const known =
    state.checkout ?? state.checkoutStatus ?? pending.terminalStatus;
  const status = await api.getCheckoutStatus(
    {
      quoteId: pending.quoteId,
      requestId: pending.requestId,
      recoveryToken: pending.recoveryToken,
    },
    {
      method: pending.method,
      mode: pending.mode,
      ...(known ? { orderId: known.orderId, attemptId: known.attemptId } : {}),
    },
  );
  if (!isCurrent()) return null;
  const event = { type: "STATUS_RESOLVED", status } as const;
  const next = giftCheckoutReducer(state, event);
  if (next === state) return null;
  if (next.phase === "IDLE")
    clearPendingGiftCheckout(getStorage, state.pendingSiteId, pending);
  else if (
    next.pending &&
    next.pending !== pending &&
    next.pending.terminalStatus
  )
    retainPendingGiftCheckout(
      getStorage,
      state.pendingSiteId,
      pending,
      next.pending,
    );
  return event;
}
