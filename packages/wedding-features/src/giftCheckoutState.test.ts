import type {
  CheckoutResult,
  CheckoutStatus,
  GiftQuote,
  PublicGiftItem,
} from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  createGiftCheckoutState,
  type GiftCheckoutEvent,
  type GiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";

const gift: PublicGiftItem = {
  id: "gift-a",
  siteId: "wedding-a",
  title: "Lua de mel",
  description: "Uma contribuição simbólica",
  nominalCents: 10_000,
  currency: "BRL",
  image: null,
  sortOrder: 0,
};
const quote: GiftQuote = {
  id: "quote-a",
  giftId: gift.id,
  siteId: gift.siteId,
  title: gift.title,
  method: "PIX",
  currency: "BRL",
  nominalCents: 10_000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 300,
  totalCents: 10_500,
  policyVersion: "policy-a",
  expiresAt: "2026-10-12T18:05:00.000Z",
  mode: "sandbox",
};
const checkout: CheckoutResult = {
  orderId: "order-a",
  attemptId: "attempt-a",
  quoteId: quote.id,
  method: quote.method,
  hostedUrl: "https://sandbox.example.test/checkout/attempt-a",
  mode: quote.mode,
};
const now = "2026-10-12T18:00:00.000Z";
const recoveryToken = "A".repeat(43);
const otherRecoveryToken = `${"B".repeat(42)}E`;
const pending = {
  quoteId: quote.id,
  requestId: "request-a",
  recoveryToken,
  method: quote.method,
  mode: quote.mode,
};
const awaitingStatus: CheckoutStatus = {
  siteId: gift.siteId,
  quoteId: quote.id,
  requestId: pending.requestId,
  orderId: checkout.orderId,
  attemptId: checkout.attemptId,
  method: quote.method,
  mode: "sandbox",
  state: "AWAITING_PAYMENT",
  observedAt: now,
  closedReason: null,
  mayStartNewAttempt: false,
  checkout,
};

function selected(): GiftCheckoutState {
  return giftCheckoutReducer(createGiftCheckoutState(), {
    type: "SELECT_GIFT",
    gift,
  });
}

function quoting(): GiftCheckoutState {
  return giftCheckoutReducer(selected(), {
    type: "SELECT_METHOD",
    method: "PIX",
  });
}

function ready(): GiftCheckoutState {
  const state = quoting();
  return giftCheckoutReducer(state, {
    type: "QUOTE_RESOLVED",
    quote,
    revision: state.revision,
  });
}

function creating(): GiftCheckoutState {
  return giftCheckoutReducer(ready(), {
    type: "CHECKOUT_STARTED",
    recoveryToken,
    requestId: "request-a",
    now,
  });
}

describe("gift checkout selection and quotation", () => {
  it("starts without a fabricated gift, quote, request or checkout", () => {
    expect(createGiftCheckoutState()).toEqual({
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
    });
  });

  it("resets all previous payment choices when selecting another gift", () => {
    const state = giftCheckoutReducer(creating(), {
      type: "CHECKOUT_FAILED",
      message: "Tente novamente.",
      unknown: false,
    });
    const next = giftCheckoutReducer(state, {
      type: "SELECT_GIFT",
      gift: { ...gift, id: "gift-b" },
    });
    expect(next).toEqual({
      ...createGiftCheckoutState(),
      gift: { ...gift, id: "gift-b" },
      phase: "SELECTED",
      revision: state.revision + 1,
    });
  });

  it("requires a gift before choosing a payment method", () => {
    const state = createGiftCheckoutState();
    expect(
      giftCheckoutReducer(state, { type: "SELECT_METHOD", method: "PIX" }),
    ).toBe(state);
  });

  it("invalidates the old quote and request when the method changes", () => {
    const state = giftCheckoutReducer(creating(), {
      type: "CHECKOUT_FAILED",
      message: "Tente novamente.",
      unknown: false,
    });
    const next = giftCheckoutReducer(state, {
      type: "SELECT_METHOD",
      method: "CREDIT_CARD",
    });
    expect(next).toMatchObject({
      gift,
      method: "CREDIT_CARD",
      phase: "QUOTING",
      revision: state.revision + 1,
      quote: null,
      requestId: null,
      checkout: null,
      error: null,
    });
    expect(
      giftCheckoutReducer(next, {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: otherRecoveryToken,
        now,
      }),
    ).toBe(next);
  });

  it.each([
    { gift: { ...gift, accountId: "private-account" } },
    { gift: { ...gift, nominalCents: -1 } },
    { gift: { ...gift, image: { url: "javascript:alert(1)", alt: "Imagem" } } },
  ])("refuses a gift outside the strict public contract", (payload) => {
    const state = selected();
    expect(
      giftCheckoutReducer(state, { type: "SELECT_GIFT", ...payload } as never),
    ).toBe(state);
  });

  it("refuses an unsupported payment method", () => {
    const state = selected();
    expect(
      giftCheckoutReducer(state, {
        type: "SELECT_METHOD",
        method: "BOLETO",
      } as never),
    ).toBe(state);
  });

  it.each([
    ["old generation", { revision: 1 }],
    ["another wedding", { quote: { ...quote, siteId: "wedding-b" } }],
    ["another gift", { quote: { ...quote, giftId: "gift-b" } }],
    ["another method", { quote: { ...quote, method: "CREDIT_CARD" } }],
    ["disabled provider", { quote: { ...quote, mode: "disabled" } }],
    ["private fields", { quote: { ...quote, walletId: "private-wallet" } }],
    ["invalid allocation", { quote: { ...quote, totalCents: 1 } }],
    ["invalid expiry", { quote: { ...quote, expiresAt: "not-a-date" } }],
  ])("ignores a quote callback with %s", (_label, changes) => {
    const state = quoting();
    expect(
      giftCheckoutReducer(state, {
        type: "QUOTE_RESOLVED",
        quote,
        revision: state.revision,
        ...changes,
      } as never),
    ).toBe(state);
  });

  it("accepts the server quote after a legitimate catalog price edit", () => {
    const state = quoting();
    const updatedQuote = {
      ...quote,
      title: "Lua de mel atualizada",
      nominalCents: 12_500,
      commissionCents: 250,
      processingCents: 350,
      totalCents: 13_100,
      mode: "live" as const,
    };
    const next = giftCheckoutReducer(state, {
      type: "QUOTE_RESOLVED",
      quote: updatedQuote,
      revision: state.revision,
    });
    expect(next).toMatchObject({ phase: "READY", quote: updatedQuote });
    expect(next.gift?.nominalCents).toBe(10_000);
  });

  it("ignores a quote failure from a previous generation", () => {
    const state = quoting();
    expect(
      giftCheckoutReducer(state, {
        type: "QUOTE_FAILED",
        message: "Erro anterior.",
        revision: state.revision - 1,
      }),
    ).toBe(state);
    expect(
      giftCheckoutReducer(state, {
        type: "QUOTE_FAILED",
        message: "Não foi possível atualizar o valor.",
        revision: state.revision,
      }),
    ).toMatchObject({
      phase: "SELECTED",
      quote: null,
      requestId: null,
      error: "Não foi possível atualizar o valor.",
    });
  });

  it("ignores completed quote callbacks outside the quoting phase", () => {
    const state = ready();
    expect(
      giftCheckoutReducer(state, {
        type: "QUOTE_RESOLVED",
        quote: { ...quote, id: "quote-b" },
        revision: state.revision,
      }),
    ).toBe(state);
    expect(
      giftCheckoutReducer(state, {
        type: "QUOTE_FAILED",
        message: "Erro tardio.",
        revision: state.revision,
      }),
    ).toBe(state);
  });
});

describe("gift checkout attempt", () => {
  it("starts only with a valid unexpired quote and request", () => {
    expect(creating()).toMatchObject({
      phase: "CREATING",
      requestId: "request-a",
      recoveryToken,
      pending,
      pendingSiteId: gift.siteId,
      quote,
      checkout: null,
      error: null,
    });
  });

  it.each(["", "invalid date", "2026-13-01T00:00:00.000Z"])(
    "refuses an invalid attempt time %s",
    (time) => {
      const state = ready();
      expect(
        giftCheckoutReducer(state, {
          type: "CHECKOUT_STARTED",
          recoveryToken,
          requestId: "request-a",
          now: time,
        }),
      ).toBe(state);
    },
  );

  it.each([quote.expiresAt, "2026-10-12T18:05:00.001Z"])(
    "requires a new quote at or after expiry %s",
    (time) => {
      const next = giftCheckoutReducer(ready(), {
        type: "CHECKOUT_STARTED",
        recoveryToken,
        requestId: "request-a",
        now: time,
      });
      expect(next).toMatchObject({
        phase: "SELECTED",
        quote: null,
        requestId: null,
        checkout: null,
        error:
          "O valor precisa ser atualizado. Escolha novamente a forma de pagamento.",
      });
    },
  );

  it.each(["", "request with spaces", "../request"])(
    "refuses invalid request identity %s",
    (requestId) => {
      const state = ready();
      expect(
        giftCheckoutReducer(state, {
          type: "CHECKOUT_STARTED",
          recoveryToken,
          requestId,
          now,
        }),
      ).toBe(state);
    },
  );

  it.each([
    { quote: { ...quote, mode: "disabled" } },
    { quote: { ...quote, totalCents: -1 } },
    { quote: { ...quote, giftId: "gift-b" } },
    { quote: { ...quote, siteId: "wedding-b" } },
    { method: "CREDIT_CARD" },
  ])("revalidates quote authority when starting an attempt", (changes) => {
    const state = { ...ready(), ...changes } as GiftCheckoutState;
    expect(
      giftCheckoutReducer(state, {
        type: "CHECKOUT_STARTED",
        recoveryToken,
        requestId: "request-a",
        now,
      }),
    ).toBe(state);
  });

  it("preserves the request and recovery token across duplicate clicks and a known failure retry", () => {
    const active = creating();
    expect(
      giftCheckoutReducer(active, {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: otherRecoveryToken,
        now,
      }),
    ).toBe(active);
    const retryable = giftCheckoutReducer(active, {
      type: "CHECKOUT_FAILED",
      message: "Tente novamente.",
      unknown: false,
    });
    expect(retryable).toMatchObject({
      phase: "READY",
      requestId: "request-a",
      recoveryToken,
      pending,
      quote,
      error: "Tente novamente.",
    });
    expect(
      giftCheckoutReducer(retryable, {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: otherRecoveryToken,
        now,
      }),
    ).toMatchObject({
      phase: "CREATING",
      requestId: "request-a",
      recoveryToken,
      pending,
      error: null,
    });
  });

  it("drops invalidated quotes and attempt identity after a known rejection", () => {
    expect(
      giftCheckoutReducer(creating(), {
        type: "CHECKOUT_FAILED",
        message: "Escolha novamente a forma de pagamento.",
        unknown: false,
        invalidateQuote: true,
      }),
    ).toMatchObject({
      phase: "SELECTED",
      quote: null,
      requestId: null,
      recoveryToken: null,
      pending: null,
      pendingSiteId: null,
      checkout: null,
    });
  });

  it("keeps accepted hosted checkout as a redirect without marking a payment successful", () => {
    const next = giftCheckoutReducer(creating(), {
      type: "CHECKOUT_RESOLVED",
      checkout,
    });
    expect(next).toMatchObject({ phase: "REDIRECTING", checkout, quote });
    expect(next).not.toHaveProperty("paid");
    expect(next).not.toHaveProperty("receipt");
  });

  it.each([
    ["another quote", { quoteId: "quote-b" }],
    ["another method", { method: "CREDIT_CARD" }],
    ["another provider mode", { mode: "live" }],
    ["disabled mode", { mode: "disabled" }],
    ["script URL", { hostedUrl: "javascript:alert(1)" }],
    ["insecure URL", { hostedUrl: "http://checkout.example.test" }],
    ["credential URL", { hostedUrl: "https://secret@checkout.example.test" }],
    ["private fields", { walletId: "private-wallet" }],
  ])(
    "locks an uncertain attempt for %s without redirecting",
    (_label, extra) => {
      const next = giftCheckoutReducer(creating(), {
        type: "CHECKOUT_RESOLVED",
        checkout: { ...checkout, ...extra },
      } as never);
      expect(next).toMatchObject({
        phase: "UNKNOWN",
        requestId: "request-a",
        quote,
        checkout: null,
        error:
          "O pagamento ainda está sendo verificado. Aguarde antes de tentar novamente.",
      });
    },
  );

  it("ignores checkout callbacks outside an active creation", () => {
    const state = ready();
    expect(
      giftCheckoutReducer(state, { type: "CHECKOUT_RESOLVED", checkout }),
    ).toBe(state);
    expect(
      giftCheckoutReducer(state, {
        type: "CHECKOUT_FAILED",
        unknown: false,
        message: "Erro tardio.",
      }),
    ).toBe(state);
  });
});

describe("checkout recovery identity and authoritative status", () => {
  function restored(): GiftCheckoutState {
    return giftCheckoutReducer(createGiftCheckoutState(), {
      type: "RESTORE_UNKNOWN",
      siteId: gift.siteId,
      pending,
    });
  }

  it.each([undefined, "", "A".repeat(42), "_".repeat(43), `${recoveryToken}=`])(
    "requires a canonical 32-byte recovery capability before creation (%s)",
    (token) => {
      const state = ready();
      expect(
        giftCheckoutReducer(state, {
          type: "CHECKOUT_STARTED",
          requestId: "request-a",
          recoveryToken: token,
          now,
        } as never),
      ).toBe(state);
    },
  );

  it("does not repair a partially missing retained request identity with a new token", () => {
    const state = { ...ready(), requestId: "request-a", recoveryToken: null };
    expect(
      giftCheckoutReducer(state, {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: otherRecoveryToken,
        now,
      }),
    ).toBe(state);
  });

  it("restores the exact operation without fabricating a gift, price or hosted checkout", () => {
    expect(restored()).toMatchObject({
      phase: "UNKNOWN",
      gift: null,
      quote: null,
      checkout: null,
      method: pending.method,
      requestId: pending.requestId,
      recoveryToken,
      pending,
      pendingSiteId: gift.siteId,
      checkoutStatus: null,
    });
  });

  it.each([
    {},
    { pending },
    { siteId: "../wedding", pending },
    { siteId: gift.siteId, pending: { ...pending, recoveryToken: undefined } },
    { siteId: gift.siteId, pending: { ...pending, accountId: "private" } },
    { siteId: gift.siteId, pending: { ...pending, mode: "disabled" } },
  ])(
    "keeps unbound, legacy or corrupt restored operations locked",
    (identity) => {
      const state = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        ...identity,
      } as never);
      expect(state).toMatchObject({
        phase: "UNKNOWN",
        pending: null,
        recoveryToken: null,
      });
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: awaitingStatus,
        }),
      ).toBe(state);
      expect(giftCheckoutReducer(state, { type: "CLOSE" })).toBe(state);
    },
  );

  it("refuses replacing a locked operation during restoration", () => {
    const state = restored();
    expect(
      giftCheckoutReducer(state, {
        type: "RESTORE_UNKNOWN",
        siteId: "wedding-b",
        pending: {
          ...pending,
          requestId: "request-b",
          recoveryToken: otherRecoveryToken,
        },
      }),
    ).toBe(state);
  });

  it.each(["IDLE", "READY", "CREATING", "REDIRECTING"] as const)(
    "ignores status outside UNKNOWN to avoid racing creation (%s)",
    (phase) => {
      const state =
        phase === "IDLE"
          ? createGiftCheckoutState()
          : phase === "READY"
            ? ready()
            : phase === "REDIRECTING"
              ? giftCheckoutReducer(creating(), {
                  type: "CHECKOUT_RESOLVED",
                  checkout,
                })
              : creating();
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: awaitingStatus,
        }),
      ).toBe(state);
    },
  );

  it.each([
    { siteId: "wedding-b" },
    { quoteId: "quote-b" },
    { requestId: "request-b" },
    { method: "CREDIT_CARD", checkout: { ...checkout, method: "CREDIT_CARD" } },
    { mode: "live", checkout: { ...checkout, mode: "live" } },
    { walletId: "private" },
    { mayStartNewAttempt: true },
    { checkout: null },
  ])(
    "ignores statuses outside the exact operation and strict C1 contract",
    (extra) => {
      const state = restored();
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: { ...awaitingStatus, ...extra },
        } as never),
      ).toBe(state);
    },
  );

  it.each([
    "CREATING",
    "OUTCOME_UNKNOWN",
    "AWAITING_PAYMENT",
    "RECEIVED",
    "REFUNDED",
  ] as const)(
    "stores truthful %s status while keeping another checkout locked",
    (paymentState) => {
      const status: CheckoutStatus = {
        ...awaitingStatus,
        state: paymentState,
        checkout: paymentState === "AWAITING_PAYMENT" ? checkout : null,
        observedAt:
          paymentState === "CREATING" || paymentState === "OUTCOME_UNKNOWN"
            ? null
            : now,
      };
      const state = giftCheckoutReducer(restored(), {
        type: "STATUS_RESOLVED",
        status,
      });
      expect(state).toMatchObject({
        phase: "UNKNOWN",
        checkoutStatus: status,
        pending,
        recoveryToken,
      });
      for (const event of [
        { type: "CLOSE" },
        { type: "SELECT_GIFT", gift },
        { type: "SELECT_METHOD", method: "PIX" },
        {
          type: "CHECKOUT_STARTED",
          requestId: "request-b",
          recoveryToken: otherRecoveryToken,
          now,
        },
      ] as GiftCheckoutEvent[])
        expect(giftCheckoutReducer(state, event)).toBe(state);
      if (paymentState === "RECEIVED" || paymentState === "REFUNDED")
        expect(state.error).toBeNull();
    },
  );

  it.each([{ orderId: "order-b" }, { attemptId: "attempt-b" }])(
    "binds later statuses to the already observed order and attempt",
    (identity) => {
      const state = giftCheckoutReducer(restored(), {
        type: "STATUS_RESOLVED",
        status: awaitingStatus,
      });
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: {
            ...awaitingStatus,
            ...identity,
            checkout: { ...checkout, ...identity },
          },
        }),
      ).toBe(state);
    },
  );

  it("checks a previously known hosted checkout's order and attempt as well", () => {
    const state = { ...restored(), checkout };
    expect(
      giftCheckoutReducer(state, {
        type: "STATUS_RESOLVED",
        status: {
          ...awaitingStatus,
          orderId: "order-b",
          checkout: { ...checkout, orderId: "order-b" },
        },
      }),
    ).toBe(state);
  });

  it("releases only an authoritative CLOSED_UNPAID status for a fresh quote and identity", () => {
    const status: CheckoutStatus = {
      ...awaitingStatus,
      state: "CLOSED_UNPAID",
      checkout: null,
      closedReason: "EXPIRED",
      mayStartNewAttempt: true,
    };
    const state = restored();
    const closed = giftCheckoutReducer(state, {
      type: "STATUS_RESOLVED",
      status,
    });
    expect(closed).toMatchObject({
      phase: "IDLE",
      quote: null,
      gift: null,
      method: null,
      checkout: null,
      requestId: null,
      recoveryToken: null,
      pending: null,
      pendingSiteId: null,
      checkoutStatus: status,
      revision: state.revision + 1,
    });
    const newGift = giftCheckoutReducer(closed, { type: "SELECT_GIFT", gift });
    const newMethod = giftCheckoutReducer(newGift, {
      type: "SELECT_METHOD",
      method: "PIX",
    });
    const newQuote = giftCheckoutReducer(newMethod, {
      type: "QUOTE_RESOLVED",
      quote: { ...quote, id: "quote-b" },
      revision: newMethod.revision,
    });
    expect(
      giftCheckoutReducer(newQuote, {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: otherRecoveryToken,
        now,
      }),
    ).toMatchObject({
      phase: "CREATING",
      requestId: "request-b",
      recoveryToken: otherRecoveryToken,
    });
    expect(
      giftCheckoutReducer(closed, {
        type: "STATUS_RESOLVED",
        status: awaitingStatus,
      }),
    ).toBe(closed);
  });

  it.each(["RECEIVED", "REFUNDED"] as const)(
    "never unlocks a recorded %s payment through a later unpaid status",
    (paymentState) => {
      const status: CheckoutStatus = {
        ...awaitingStatus,
        state: paymentState,
        checkout: null,
      };
      const state = giftCheckoutReducer(restored(), {
        type: "STATUS_RESOLVED",
        status,
      });
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: {
            ...awaitingStatus,
            state: "CLOSED_UNPAID",
            checkout: null,
            observedAt: "2026-10-12T18:01:00.000Z",
            closedReason: "CANCELED",
            mayStartNewAttempt: true,
          },
        }),
      ).toBe(state);
    },
  );

  it("accepts a refund after receipt while ignoring older or less-final observations", () => {
    const received: CheckoutStatus = {
      ...awaitingStatus,
      state: "RECEIVED",
      checkout: null,
    };
    const state = giftCheckoutReducer(restored(), {
      type: "STATUS_RESOLVED",
      status: received,
    });
    expect(
      giftCheckoutReducer(state, {
        type: "STATUS_RESOLVED",
        status: awaitingStatus,
      }),
    ).toBe(state);
    const refunded: CheckoutStatus = {
      ...received,
      state: "REFUNDED",
      observedAt: "2026-10-12T18:01:00.000Z",
    };
    const final = giftCheckoutReducer(state, {
      type: "STATUS_RESOLVED",
      status: refunded,
    });
    expect(final.checkoutStatus).toEqual(refunded);
    expect(
      giftCheckoutReducer(final, { type: "STATUS_RESOLVED", status: received }),
    ).toBe(final);
  });

  it("ignores an older unpaid observation and an earlier unobserved creation after awaiting payment", () => {
    const state = giftCheckoutReducer(restored(), {
      type: "STATUS_RESOLVED",
      status: awaitingStatus,
    });
    const older: CheckoutStatus = {
      ...awaitingStatus,
      state: "CLOSED_UNPAID",
      checkout: null,
      observedAt: "2026-10-12T17:59:00.000Z",
      closedReason: "FAILED",
      mayStartNewAttempt: true,
    };
    expect(
      giftCheckoutReducer(state, { type: "STATUS_RESOLVED", status: older }),
    ).toBe(state);
    expect(
      giftCheckoutReducer(state, {
        type: "STATUS_RESOLVED",
        status: {
          ...awaitingStatus,
          state: "CREATING",
          checkout: null,
          observedAt: null,
        },
      }),
    ).toBe(state);
  });
});

describe("current uncertainty after historical receipt", () => {
  const newer = "2026-10-12T18:01:00.000Z";
  const newest = "2026-10-12T18:02:00.000Z";
  function terminal(paymentState: "RECEIVED" | "REFUNDED") {
    const restored = giftCheckoutReducer(createGiftCheckoutState(), {
      type: "RESTORE_UNKNOWN",
      siteId: gift.siteId,
      pending,
    });
    return giftCheckoutReducer(restored, {
      type: "STATUS_RESOLVED",
      status: { ...awaitingStatus, state: paymentState, checkout: null },
    });
  }
  function uncertain(
    state: GiftCheckoutState,
    observedAt: string | null = newer,
  ) {
    return giftCheckoutReducer(state, {
      type: "STATUS_RESOLVED",
      status: {
        ...awaitingStatus,
        state: "OUTCOME_UNKNOWN",
        checkout: null,
        observedAt,
      },
    });
  }
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "replaces historical %s certainty with newer current verification",
    (paymentState) => {
      const previous = terminal(paymentState);
      const next = uncertain(previous);
      expect(next.checkoutStatus?.state).toBe("OUTCOME_UNKNOWN");
      expect(next.checkout).toBeNull();
      expect(next.error).toContain("verificado");
      expect(next.phase).toBe("UNKNOWN");
      expect(next.pending).toMatchObject({
        ...pending,
        terminalStatus: previous.checkoutStatus,
        lastStatus: next.checkoutStatus,
      });
      expect(giftCheckoutReducer(next, { type: "CLOSE" })).toBe(next);
      expect(giftCheckoutReducer(next, { type: "SELECT_GIFT", gift })).toBe(
        next,
      );
      expect(
        giftCheckoutReducer(next, { type: "SELECT_METHOD", method: "PIX" }),
      ).toBe(next);
      expect(
        giftCheckoutReducer(next, {
          type: "CHECKOUT_STARTED",
          requestId: "new-request",
          recoveryToken: otherRecoveryToken,
          now: newest,
        }),
      ).toBe(next);
    },
  );
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "gives equal-timestamp uncertainty precedence over %s without permitting certainty to overwrite the tie",
    (paymentState) => {
      const previous = terminal(paymentState);
      const next = uncertain(previous, now);
      expect(next.checkoutStatus?.state).toBe("OUTCOME_UNKNOWN");
      if (!previous.checkoutStatus)
        throw new Error("Expected historical status");
      expect(
        giftCheckoutReducer(next, {
          type: "STATUS_RESOLVED",
          status: previous.checkoutStatus,
        }),
      ).toBe(next);
    },
  );
  it.each([null, "2026-10-12T17:59:00.000Z", "invalid"])(
    "ignores missing, stale or invalid uncertainty timestamps: %s",
    (observedAt) => {
      const previous = terminal("RECEIVED");
      expect(uncertain(previous, observedAt)).toBe(previous);
    },
  );
  it.each([
    { siteId: "wedding-b" },
    { quoteId: "quote-b" },
    { requestId: "request-b" },
    { orderId: "order-b" },
    { attemptId: "attempt-b" },
    { method: "CREDIT_CARD" },
    { mode: "live" },
  ])("ignores foreign uncertainty after a receipt: %j", (identity) => {
    const previous = terminal("RECEIVED");
    expect(
      giftCheckoutReducer(previous, {
        type: "STATUS_RESOLVED",
        status: {
          ...awaitingStatus,
          ...identity,
          state: "OUTCOME_UNKNOWN",
          checkout: null,
          observedAt: newer,
        },
      } as never),
    ).toBe(previous);
  });
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "retains a %s floor through uncertainty, close and remount",
    (paymentState) => {
      const next = uncertain(terminal(paymentState));
      if (!next.pending) throw new Error("Expected retained operation");
      const remounted = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        siteId: gift.siteId,
        pending: next.pending,
      });
      expect(remounted.checkoutStatus).toBeNull();
      expect(remounted.pending).toEqual(next.pending);
      expect(giftCheckoutReducer(remounted, { type: "CLOSE" })).toBe(remounted);
      for (const state of [next, remounted]) {
        for (const status of [
          { ...awaitingStatus, observedAt: newest },
          {
            ...awaitingStatus,
            state: "CREATING",
            checkout: null,
            observedAt: newest,
          },
          {
            ...awaitingStatus,
            state: "CLOSED_UNPAID",
            checkout: null,
            closedReason: "EXPIRED",
            mayStartNewAttempt: true,
            observedAt: newest,
          },
        ] as CheckoutStatus[])
          expect(
            giftCheckoutReducer(state, { type: "STATUS_RESOLVED", status }),
          ).toBe(state);
        expect(uncertain(state, now)).toBe(state);
        expect(uncertain(state, null)).toBe(state);
        expect(
          giftCheckoutReducer(state, {
            type: "STATUS_RESOLVED",
            status: {
              ...awaitingStatus,
              state: paymentState,
              checkout: null,
              observedAt: newer,
            },
          }),
        ).toBe(state);
      }
    },
  );
  it("accepts newer terminal resolution while preserving refund's historical floor", () => {
    const received = uncertain(terminal("RECEIVED"));
    const resolved = giftCheckoutReducer(received, {
      type: "STATUS_RESOLVED",
      status: {
        ...awaitingStatus,
        state: "RECEIVED",
        checkout: null,
        observedAt: newest,
      },
    });
    expect(resolved.checkoutStatus?.state).toBe("RECEIVED");
    expect(resolved.error).toBeNull();
    const refunded = uncertain(terminal("REFUNDED"));
    expect(
      giftCheckoutReducer(refunded, {
        type: "STATUS_RESOLVED",
        status: {
          ...awaitingStatus,
          state: "RECEIVED",
          checkout: null,
          observedAt: newest,
        },
      }),
    ).toBe(refunded);
    expect(
      giftCheckoutReducer(refunded, {
        type: "STATUS_RESOLVED",
        status: {
          ...awaitingStatus,
          state: "REFUNDED",
          checkout: null,
          observedAt: newest,
        },
      }).checkoutStatus?.state,
    ).toBe("REFUNDED");
  });
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "allows a fresh identical %s consultation after remount when no subsequent uncertainty was recorded",
    (paymentState) => {
      const previous = terminal(paymentState);
      if (!previous.pending || !previous.checkoutStatus)
        throw new Error("Expected historical status");
      const remounted = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        siteId: gift.siteId,
        pending: previous.pending,
      });
      expect(remounted.checkoutStatus).toBeNull();
      const confirmed = giftCheckoutReducer(remounted, {
        type: "STATUS_RESOLVED",
        status: previous.checkoutStatus,
      });
      expect(confirmed.checkoutStatus?.state).toBe(paymentState);
      expect(confirmed.phase).toBe("UNKNOWN");
    },
  );
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "never treats different UTC precision as newer %s proof",
    (paymentState) => {
      const state = uncertain(terminal(paymentState));
      expect(
        giftCheckoutReducer(state, {
          type: "STATUS_RESOLVED",
          status: {
            ...awaitingStatus,
            state: paymentState,
            checkout: null,
            observedAt: "2026-10-12T18:01:00Z",
          },
        }),
      ).toBe(state);
    },
  );
});

describe("uncertain gift checkout and closure", () => {
  const blockedEvents: GiftCheckoutEvent[] = [
    { type: "SELECT_GIFT", gift: { ...gift, id: "gift-b" } },
    { type: "SELECT_METHOD", method: "CREDIT_CARD" },
    { type: "CHECKOUT_STARTED", requestId: "request-b", recoveryToken, now },
    { type: "CLOSE" },
  ];

  it.each(["CREATING", "REDIRECTING", "UNKNOWN"] as const)(
    "blocks replacement choices and closure while %s",
    (phase) => {
      const state =
        phase === "REDIRECTING"
          ? giftCheckoutReducer(creating(), {
              type: "CHECKOUT_RESOLVED",
              checkout,
            })
          : phase === "UNKNOWN"
            ? giftCheckoutReducer(creating(), {
                type: "CHECKOUT_FAILED",
                unknown: true,
                message: "O pagamento ainda está sendo verificado.",
              })
            : creating();
      for (const event of blockedEvents)
        expect(giftCheckoutReducer(state, event)).toBe(state);
    },
  );

  it("preserves uncertain quote/request even if the failure also claims invalidation", () => {
    expect(
      giftCheckoutReducer(creating(), {
        type: "CHECKOUT_FAILED",
        message: "O pagamento ainda está sendo verificado.",
        unknown: true,
        invalidateQuote: true,
      }),
    ).toMatchObject({
      phase: "UNKNOWN",
      quote,
      requestId: "request-a",
      checkout: null,
    });
  });

  it("restores an uncertain reload without fabricating a quote or payment", () => {
    const state = giftCheckoutReducer(createGiftCheckoutState(), {
      type: "RESTORE_UNKNOWN",
    });
    expect(state).toMatchObject({
      phase: "UNKNOWN",
      gift: null,
      method: null,
      quote: null,
      checkout: null,
      requestId: null,
      error:
        "O pagamento ainda está sendo verificado. Aguarde antes de tentar novamente.",
    });
    for (const event of blockedEvents)
      expect(giftCheckoutReducer(state, event)).toBe(state);
  });

  it("invalidates pending quote generations when closing a nonbusy selection", () => {
    const state = quoting();
    const closed = giftCheckoutReducer(state, { type: "CLOSE" });
    expect(closed).toEqual({
      ...createGiftCheckoutState(),
      revision: state.revision + 1,
    });
    expect(
      giftCheckoutReducer(closed, {
        type: "QUOTE_RESOLVED",
        quote,
        revision: state.revision,
      }),
    ).toBe(closed);
  });
});
