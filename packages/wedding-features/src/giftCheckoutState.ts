import {
  type CheckoutResult,
  type CheckoutStatus,
  checkoutCreateInputSchema,
  checkoutResultSchema,
  checkoutStatusSchema,
  type GiftQuote,
  giftPaymentMethodSchema,
  giftQuoteSchema,
  type PublicGiftItem,
  publicGiftItemSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import {
  type PendingGiftCheckout,
  pendingGiftCheckoutSchema,
} from "./giftCheckoutStorage";

const quoteExpiredMessage =
  "O valor precisa ser atualizado. Escolha novamente a forma de pagamento.";
const unknownCheckoutMessage =
  "O pagamento ainda está sendo verificado. Aguarde antes de tentar novamente.";
const failedCheckoutMessage =
  "Não foi possível concluir agora. Tente novamente.";

export type GiftCheckoutState = {
  gift: PublicGiftItem | null;
  method: GiftQuote["method"] | null;
  quote: GiftQuote | null;
  checkout: CheckoutResult | null;
  phase:
    | "IDLE"
    | "SELECTED"
    | "QUOTING"
    | "READY"
    | "CREATING"
    | "REDIRECTING"
    | "UNKNOWN";
  revision: number;
  requestId: string | null;
  recoveryToken: string | null;
  pending: PendingGiftCheckout | null;
  pendingSiteId: string | null;
  checkoutStatus: CheckoutStatus | null;
  error: string | null;
};

export type GiftCheckoutEvent =
  | { type: "SELECT_GIFT"; gift: PublicGiftItem }
  | { type: "SELECT_METHOD"; method: GiftQuote["method"] }
  | { type: "QUOTE_RESOLVED"; quote: GiftQuote; revision: number }
  | { type: "QUOTE_FAILED"; message: string; revision: number }
  | {
      type: "CHECKOUT_STARTED";
      requestId: string;
      recoveryToken: string;
      now: string;
    }
  | { type: "CHECKOUT_RESOLVED"; checkout: CheckoutResult }
  | {
      type: "CHECKOUT_FAILED";
      message: string;
      unknown: boolean;
      invalidateQuote?: boolean;
    }
  | { type: "CLOSE" }
  | { type: "RESTORE_UNKNOWN"; siteId?: string; pending?: PendingGiftCheckout }
  | { type: "STATUS_RESOLVED"; status: CheckoutStatus };

export function createGiftCheckoutState(): GiftCheckoutState {
  return {
    gift: null,
    method: null,
    quote: null,
    checkout: null,
    phase: "IDLE",
    revision: 0,
    requestId: null,
    recoveryToken: null,
    pending: null,
    pendingSiteId: null,
    checkoutStatus: null,
    error: null,
  };
}

export function giftCheckoutReducer(
  state: GiftCheckoutState,
  event: GiftCheckoutEvent,
): GiftCheckoutState {
  const locked =
    state.phase === "CREATING" ||
    state.phase === "REDIRECTING" ||
    state.phase === "UNKNOWN";

  switch (event.type) {
    case "SELECT_GIFT": {
      if (locked) return state;
      const parsed = publicGiftItemSchema.safeParse(event.gift);
      if (!parsed.success) return state;
      return {
        ...createGiftCheckoutState(),
        gift: parsed.data,
        phase: "SELECTED",
        revision: state.revision + 1,
      };
    }
    case "SELECT_METHOD": {
      if (locked || !state.gift) return state;
      const parsed = giftPaymentMethodSchema.safeParse(event.method);
      if (!parsed.success) return state;
      return {
        ...state,
        method: parsed.data,
        quote: null,
        checkout: null,
        phase: "QUOTING",
        revision: state.revision + 1,
        requestId: null,
        recoveryToken: null,
        pending: null,
        pendingSiteId: null,
        checkoutStatus: null,
        error: null,
      };
    }
    case "QUOTE_RESOLVED": {
      if (state.phase !== "QUOTING" || event.revision !== state.revision)
        return state;
      const parsed = giftQuoteSchema.safeParse(event.quote);
      if (!parsed.success || !quoteMatchesSelection(state, parsed.data))
        return state;
      return { ...state, quote: parsed.data, phase: "READY", error: null };
    }
    case "QUOTE_FAILED": {
      if (state.phase !== "QUOTING" || event.revision !== state.revision)
        return state;
      return {
        ...state,
        phase: "SELECTED",
        quote: null,
        requestId: null,
        recoveryToken: null,
        pending: null,
        pendingSiteId: null,
        checkoutStatus: null,
        error: event.message || failedCheckoutMessage,
      };
    }
    case "CHECKOUT_STARTED": {
      if (state.phase !== "READY") return state;
      const parsed = giftQuoteSchema.safeParse(state.quote);
      const now = Date.parse(event.now);
      if (
        !parsed.success ||
        !quoteMatchesSelection(state, parsed.data) ||
        !Number.isFinite(now)
      )
        return state;
      if (now >= Date.parse(parsed.data.expiresAt)) {
        return {
          ...state,
          phase: "SELECTED",
          quote: null,
          checkout: null,
          requestId: null,
          recoveryToken: null,
          pending: null,
          pendingSiteId: null,
          checkoutStatus: null,
          error: quoteExpiredMessage,
        };
      }
      if ((state.requestId === null) !== (state.recoveryToken === null))
        return state;
      const request = checkoutCreateInputSchema.safeParse({
        quoteId: parsed.data.id,
        requestId: state.requestId ?? event.requestId,
        recoveryToken: state.recoveryToken ?? event.recoveryToken,
      });
      if (!request.success) return state;
      return {
        ...state,
        phase: "CREATING",
        quote: parsed.data,
        checkout: null,
        requestId: request.data.requestId,
        recoveryToken: request.data.recoveryToken,
        pending: {
          ...request.data,
          method: parsed.data.method,
          mode: parsed.data.mode,
        },
        pendingSiteId: parsed.data.siteId,
        checkoutStatus: null,
        error: null,
      };
    }
    case "CHECKOUT_RESOLVED": {
      if (state.phase !== "CREATING") return state;
      const parsed = checkoutResultSchema.safeParse(event.checkout);
      if (
        !parsed.success ||
        parsed.data.quoteId !== state.quote?.id ||
        parsed.data.method !== state.quote.method ||
        parsed.data.mode !== state.quote.mode
      ) {
        return {
          ...state,
          phase: "UNKNOWN",
          checkout: null,
          error: unknownCheckoutMessage,
        };
      }
      return {
        ...state,
        phase: "REDIRECTING",
        checkout: parsed.data,
        error: null,
      };
    }
    case "CHECKOUT_FAILED": {
      if (state.phase !== "CREATING") return state;
      if (event.unknown) {
        return {
          ...state,
          phase: "UNKNOWN",
          checkout: null,
          error: event.message || unknownCheckoutMessage,
        };
      }
      return {
        ...state,
        phase: event.invalidateQuote ? "SELECTED" : "READY",
        quote: event.invalidateQuote ? null : state.quote,
        requestId: event.invalidateQuote ? null : state.requestId,
        recoveryToken: event.invalidateQuote ? null : state.recoveryToken,
        pending: event.invalidateQuote ? null : state.pending,
        pendingSiteId: event.invalidateQuote ? null : state.pendingSiteId,
        checkoutStatus: null,
        checkout: null,
        error: event.message || failedCheckoutMessage,
      };
    }
    case "CLOSE":
      return locked
        ? state
        : { ...createGiftCheckoutState(), revision: state.revision + 1 };
    case "RESTORE_UNKNOWN": {
      if (locked && (state.phase !== "UNKNOWN" || state.pending !== null))
        return state;
      const site = siteIdSchema.safeParse(event.siteId);
      const pending = pendingGiftCheckoutSchema.safeParse(event.pending);
      if (
        locked &&
        (!site.success ||
          !pending.success ||
          (state.pendingSiteId !== null && state.pendingSiteId !== site.data))
      )
        return state;
      const identity =
        site.success &&
        pending.success &&
        (!pending.data.terminalStatus ||
          pending.data.terminalStatus.siteId === site.data)
          ? pending.data
          : null;
      return {
        ...createGiftCheckoutState(),
        phase: "UNKNOWN",
        revision: state.revision + 1,
        pending: identity,
        pendingSiteId: site.success ? site.data : null,
        method: identity?.method ?? null,
        requestId: identity?.requestId ?? null,
        recoveryToken: identity?.recoveryToken ?? null,
        error: unknownCheckoutMessage,
      };
    }
    case "STATUS_RESOLVED": {
      if (state.phase !== "UNKNOWN" || !state.pending) return state;
      const pending = state.pending;
      const parsed = checkoutStatusSchema.safeParse(event.status);
      if (!parsed.success || !statusMatchesOperation(state, parsed.data))
        return state;
      const status = parsed.data;
      const previous =
        state.checkoutStatus ?? state.pending?.lastStatus ?? null;
      const terminal = state.pending?.terminalStatus;
      if (
        (previous?.observedAt !== undefined &&
          previous.observedAt !== null &&
          (status.observedAt === null ||
            Date.parse(status.observedAt) < Date.parse(previous.observedAt))) ||
        (terminal &&
          !["RECEIVED", "REFUNDED", "OUTCOME_UNKNOWN"].includes(
            status.state,
          )) ||
        (terminal?.state === "REFUNDED" && status.state === "RECEIVED") ||
        (terminal &&
          previous?.state === "OUTCOME_UNKNOWN" &&
          status.state !== "OUTCOME_UNKNOWN" &&
          status.observedAt !== null &&
          previous.observedAt !== null &&
          Date.parse(status.observedAt) === Date.parse(previous.observedAt))
      )
        return state;
      if (status.state === "CLOSED_UNPAID" && status.mayStartNewAttempt) {
        return {
          ...createGiftCheckoutState(),
          revision: state.revision + 1,
          checkoutStatus: status,
        };
      }
      return {
        ...state,
        pending:
          status.state === "RECEIVED" || status.state === "REFUNDED"
            ? { ...pending, terminalStatus: status, lastStatus: status }
            : terminal
              ? { ...pending, lastStatus: status }
              : state.pending,
        checkout: status.checkout,
        checkoutStatus: status,
        error:
          status.state === "RECEIVED" || status.state === "REFUNDED"
            ? null
            : unknownCheckoutMessage,
      };
    }
  }
  return state;
}

function statusMatchesOperation(
  state: GiftCheckoutState,
  status: CheckoutStatus,
): boolean {
  const pending = pendingGiftCheckoutSchema.safeParse(state.pending);
  const site = siteIdSchema.safeParse(state.pendingSiteId);
  if (!pending.success || !site.success) return false;
  if (
    status.siteId !== site.data ||
    status.quoteId !== pending.data.quoteId ||
    status.requestId !== pending.data.requestId ||
    status.method !== pending.data.method ||
    status.mode !== pending.data.mode ||
    state.requestId !== pending.data.requestId ||
    state.recoveryToken !== pending.data.recoveryToken ||
    state.method !== pending.data.method ||
    (state.quote !== null &&
      (state.quote.siteId !== status.siteId ||
        state.quote.id !== status.quoteId ||
        state.quote.method !== status.method ||
        state.quote.mode !== status.mode))
  )
    return false;
  return [
    state.checkout,
    state.checkoutStatus,
    pending.data.terminalStatus ?? null,
    pending.data.lastStatus ?? null,
  ].every(
    (known) =>
      known === null ||
      (known.orderId === status.orderId &&
        known.attemptId === status.attemptId),
  );
}

function quoteMatchesSelection(
  state: GiftCheckoutState,
  quote: GiftQuote,
): boolean {
  return (
    quote.siteId === state.gift?.siteId &&
    quote.giftId === state.gift.id &&
    quote.method === state.method &&
    quote.mode !== "disabled"
  );
}
