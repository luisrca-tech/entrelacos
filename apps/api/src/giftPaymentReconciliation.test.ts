import { describe, expect, it } from "vitest";
import {
  type GiftPaymentReconciliationInput,
  reconcileGiftPaymentObservation,
} from "./giftPaymentReconciliation";

const now = new Date("2026-10-12T12:00:00.000Z");
const observedAt = new Date("2026-10-12T11:59:59.000Z");

function fixture(): GiftPaymentReconciliationInput {
  const receiving = {
    siteId: "site-1",
    provider: "ASAAS",
    operatorReference: "operator-1",
    environment: "live" as const,
    accountReference: "remote-account-1",
    recipientReference: "recipient-wallet-1",
    destinationVersion: 1,
    bankReference: "bank-1",
  };
  return {
    quoteSnapshot: {
      quote: {
        id: "quote-1",
        giftId: "gift-1",
        siteId: "site-1",
        title: "A contribution",
        method: "PIX",
        currency: "BRL",
        nominalCents: 10_000,
        commissionBasisPoints: 200,
        commissionCents: 200,
        processingCents: 300,
        totalCents: 10_500,
        policyVersion: "local-policy-v1",
        expiresAt: "2026-10-12T11:05:00.000Z",
        mode: "live",
      },
      gift: {
        id: "gift-1",
        siteId: "site-1",
        title: "A contribution",
        description: "",
        nominalCents: 10_000,
        currency: "BRL",
        image: null,
        sortOrder: 0,
      },
      receiving,
      // This illustrative injected policy is not approved provider pricing.
      pricing: {
        ...receiving,
        verification: "verified",
        provenance: "provider",
        observedAt: "2026-10-12T10:59:00.000Z",
        expiresAt: "2026-10-12T11:10:00.000Z",
        policy: {
          version: "local-policy-v1",
          method: "PIX",
          commissionBasisPoints: 200,
          processingBasisPoints: 0,
          processingFixedCents: 300,
          rounding: "CEILING",
        },
      },
      createdAt: "2026-10-12T11:00:00.000Z",
      expiresAt: "2026-10-12T11:05:00.000Z",
    },
    checkout: {
      siteId: "site-1",
      accountId: "account-1",
      orderId: "order-1",
      attemptId: "attempt-1",
      providerCheckoutReference: "checkout-1",
      accountReference: "remote-account-1",
      environment: "live",
    },
    platformWalletId: "platform-wallet-1",
    observation: {
      source: "provider",
      provider: "ASAAS",
      siteId: "site-1",
      accountReference: "remote-account-1",
      environment: "live",
      currency: "BRL",
      observedAt,
      payment: {
        id: "pay_1",
        checkoutSession: "checkout-1",
        externalReference: "attempt-1",
        billingType: "PIX",
        status: "RECEIVED",
        value: "105.00",
        netValue: "102.00",
        split: [
          {
            id: "split-1",
            walletId: "platform-wallet-1",
            fixedValue: "2.00",
            totalValue: "2.00",
            status: "DONE",
          },
        ],
      },
    },
    now,
  };
}

function paymentInput(
  changes: Record<string, unknown>,
): GiftPaymentReconciliationInput {
  const input = fixture();
  return {
    ...input,
    observation: {
      ...input.observation,
      payment: {
        ...(input.observation.payment as Record<string, unknown>),
        ...changes,
      },
    },
  };
}

describe("confirmed payment observations", () => {
  it("records the provider's matching net allocation awaiting release without a receipt effect", () => {
    const result = reconcileGiftPaymentObservation(
      paymentInput({ status: "CONFIRMED" }),
    );
    expect(result).toMatchObject({
      outcome: "NOT_RECEIVED",
      effect: null,
      payment: {
        providerStatus: "CONFIRMED",
        processingCents: 300,
        recipientNetCents: 10000,
        commissionCents: null,
        splitFixedCents: 200,
      },
    });
  });

  it.each([
    { split: [] },
    { value: "106.00" },
    { deleted: true },
    { deleted: "true" },
    {
      split: [
        {
          id: "split-1",
          walletId: "platform-wallet-1",
          fixedValue: "2.00",
          totalValue: "3.00",
          status: "DONE",
        },
      ],
    },
  ])(
    "never projects confirmed allocation with inconsistent or restricted money: %j",
    (changes) => {
      const result = reconcileGiftPaymentObservation(
        paymentInput({ status: "CONFIRMED", ...changes }),
      );
      expect(result).toMatchObject({
        effect: null,
        payment: { recipientNetCents: null },
      });
    },
  );
});

const settledSplit = {
  id: "split-1",
  walletId: "platform-wallet-1",
  fixedValue: "2.00",
  totalValue: "2.00",
  status: "DONE",
};

describe("actual provider fee allocation", () => {
  it.each(["PIX", "CREDIT_CARD"] as const)(
    "settles the new 1000-cent %s quote into 99 fee, 20 commission and 881 recipient cents",
    (method) => {
      const input = paymentInput({
        billingType: method,
        value: "10.00",
        netValue: "9.01",
        split: [{ ...settledSplit, fixedValue: "0.20", totalValue: "0.20" }],
      });
      Object.assign(input.quoteSnapshot.quote, {
        method,
        nominalCents: 1000,
        totalCents: 1000,
        commissionCents: 20,
        processingCents: 0,
        feeAllocation: "RECIPIENT_DEDUCTED",
      });
      Object.assign(input.quoteSnapshot.pricing.policy, {
        method,
        feeAllocation: "RECIPIENT_DEDUCTED",
        processingFixedCents: 0,
      });
      input.quoteSnapshot.gift.nominalCents = 1000;
      const frozen = structuredClone(input.quoteSnapshot);
      expect(reconcileGiftPaymentObservation(input)).toMatchObject({
        outcome: "RECEIVED",
        payment: {
          grossCents: 1000,
          processingCents: 99,
          commissionCents: 20,
          recipientNetCents: 881,
          splitFixedCents: 20,
        },
        effect: { amountCents: 881 },
      });
      expect(input.quoteSnapshot).toEqual(frozen);
      for (const netValue of ["0.20", "0.19"]) {
        Object.assign(input.observation.payment as object, { netValue });
        expect(reconcileGiftPaymentObservation(input)).toMatchObject({
          outcome: "DIVERGENT",
          effect: null,
        });
      }
    },
  );

  it.each(["CONFIRMED", "RECEIVED"])(
    "keeps the buyer quote and allocates the actual fee to the holder for %s",
    (status) => {
      const input = paymentInput({
        status,
        value: "10.20",
        netValue: "9.21",
        split: [{ ...settledSplit, fixedValue: "0.20", totalValue: "0.20" }],
      });
      Object.assign(input.quoteSnapshot.quote, {
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 0,
        totalCents: 1020,
      });
      const frozenQuote = structuredClone(input.quoteSnapshot.quote);
      const result = reconcileGiftPaymentObservation(input);
      expect(result).toMatchObject({
        outcome: status === "RECEIVED" ? "RECEIVED" : "NOT_RECEIVED",
        payment: {
          grossCents: 1020,
          processingCents: 99,
          recipientNetCents: 901,
          splitFixedCents: 20,
        },
      });
      expect(result.effect).toEqual(
        status === "RECEIVED"
          ? expect.objectContaining({ amountCents: 901, kind: "GIFT_RECEIVED" })
          : null,
      );
      expect(input.quoteSnapshot.quote).toEqual(frozenQuote);
    },
  );

  it.each([
    ["101.99", 301, 9999],
    ["102.01", 299, 10001],
  ] as const)(
    "conserves the fixed buyer total when observed provider net is %s",
    (netValue, fee, recipient) => {
      const input = paymentInput({ netValue });
      const result = reconcileGiftPaymentObservation(input);
      expect(result).toMatchObject({
        outcome: "RECEIVED",
        payment: {
          processingCents: fee,
          recipientNetCents: recipient,
          commissionCents: 200,
        },
        effect: { amountCents: recipient },
      });
      expect(input.quoteSnapshot.quote.processingCents).toBe(300);
    },
  );

  it.each(["2.00", "1.99"])(
    "does not post a zero or negative holder allocation: %s",
    (netValue) => {
      expect(
        reconcileGiftPaymentObservation(paymentInput({ netValue })),
      ).toMatchObject({
        outcome: "DIVERGENT",
        reason: "ALLOCATION_MISMATCH",
        effect: null,
      });
    },
  );
});

describe("gift payment reconciliation decision", () => {
  it.each([undefined, null])(
    "keeps a DONE split's unobserved actual amount unknown: %s",
    (totalValue) => {
      const input = paymentInput({ split: [{ ...settledSplit, totalValue }] });
      expect(reconcileGiftPaymentObservation(input)).toMatchObject({
        outcome: "SPLIT_PENDING",
        reason: "SPLIT_NOT_SETTLED",
        payment: {
          splitFixedCents: 200,
          commissionCents: null,
          recipientNetCents: null,
        },
        effect: null,
      });
    },
  );
  it("retains a contradictory actual split total without fabricating the configured commission", () => {
    const input = paymentInput({
      split: [{ ...settledSplit, totalValue: "2.01" }],
    });
    expect(reconcileGiftPaymentObservation(input)).toMatchObject({
      outcome: "DIVERGENT",
      payment: {
        splitFixedCents: 200,
        commissionCents: 201,
        recipientNetCents: 9999,
      },
      effect: null,
    });
  });
  it("rejects fractional-cent actual split totals", () => {
    expect(() =>
      reconcileGiftPaymentObservation(
        paymentInput({ split: [{ ...settledSplit, totalValue: "2.001" }] }),
      ),
    ).toThrow("Payment observation cannot be reconciled");
  });
  it("prepares an actual conserved receipt only after provider receipt and the exact fixed split", () => {
    const result = reconcileGiftPaymentObservation(fixture());
    expect(result).toEqual({
      outcome: "RECEIVED",
      reason: null,
      payment: {
        siteId: "site-1",
        accountId: "account-1",
        environment: "live",
        orderId: "order-1",
        attemptId: "attempt-1",
        providerPaymentReference: "pay_1",
        providerStatus: "RECEIVED",
        verificationStatus: "VERIFIED",
        observedAt,
        currency: "BRL",
        grossCents: 10_500,
        processingCents: 300,
        commissionCents: 200,
        recipientNetCents: 10_000,
        splitProviderReference: "split-1",
        splitFixedCents: 200,
      },
      effect: {
        effectKey:
          "GIFT_RECEIVED:6ec81111d581d10d7725c768ec7408574fb3bc895f76ec93e678dd3d469db8cf",
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        currency: "BRL",
        amountCents: 10_000,
      },
    });
  });

  it.each([
    "PENDING",
    "CONFIRMED",
    "AUTHORIZED",
    "PAID",
    "REFUNDED",
    "REFUND_IN_PROGRESS",
    "CHARGEBACK_DISPUTE",
    "DELETED",
    "BLOCKED",
  ])(
    "does not post receipt for authoritative payment status %s even with an old receipt event claim",
    (status) => {
      const result = reconcileGiftPaymentObservation(
        paymentInput({ status, event: "PAYMENT_RECEIVED", approved: true }),
      );
      expect(result).toMatchObject({
        outcome: "NOT_RECEIVED",
        effect: null,
        payment: { providerStatus: status },
      });
    },
  );

  it.each([
    "PENDING",
    "AWAITING_CREDIT",
    "REFUSED",
    "CANCELLED",
    "REFUNDED",
    "UNKNOWN",
  ])("does not treat split %s as a settled commission", (status) => {
    const result = reconcileGiftPaymentObservation(
      paymentInput({ split: [{ ...settledSplit, status }] }),
    );
    expect(result).toMatchObject({
      outcome: "SPLIT_PENDING",
      effect: null,
      payment: {
        commissionCents: null,
        recipientNetCents: null,
        splitFixedCents: 200,
      },
    });
  });

  it.each([
    [
      { value: "105.01" },
      {
        grossCents: 10_501,
        processingCents: 301,
        commissionCents: 200,
        recipientNetCents: 10_000,
      },
    ],
    [
      { split: [{ ...settledSplit, fixedValue: "2.01", totalValue: "2.01" }] },
      {
        grossCents: 10_500,
        processingCents: 300,
        commissionCents: 201,
        recipientNetCents: 9_999,
      },
    ],
  ])(
    "reports divergent actual allocation %j without manufacturing quote values",
    (changes, actual) => {
      const result = reconcileGiftPaymentObservation(paymentInput(changes));
      expect(result).toMatchObject({
        outcome: "DIVERGENT",
        reason: "ALLOCATION_MISMATCH",
        effect: null,
        payment: actual,
      });
      expect(result.payment && BigInt(result.payment.grossCents)).toBe(
        BigInt(actual.processingCents) +
          BigInt(actual.commissionCents) +
          BigInt(actual.recipientNetCents),
      );
    },
  );

  it.each([
    [[]],
    [[{ ...settledSplit, walletId: "other-wallet" }]],
    [
      [
        settledSplit,
        {
          ...settledSplit,
          id: "split-extra",
          walletId: "other-wallet",
          fixedValue: "1.00",
        },
      ],
    ],
    [[{ ...settledSplit, percentualValue: 2 }]],
    [
      [
        {
          id: "split-1",
          walletId: "platform-wallet-1",
          percentualValue: 2,
          status: "DONE",
        },
      ],
    ],
  ])(
    "does not settle an absent, extra, redirected or percentage split %j",
    (split) => {
      const result = reconcileGiftPaymentObservation(paymentInput({ split }));
      expect(result).toMatchObject({
        outcome: "DIVERGENT",
        reason: "SPLIT_MISMATCH",
        effect: null,
        payment: { recipientNetCents: null },
      });
    },
  );

  it("retains unknown provider net/processing/allocation as null", () => {
    const result = reconcileGiftPaymentObservation(
      paymentInput({ netValue: null }),
    );
    expect(result).toMatchObject({
      outcome: "DIVERGENT",
      effect: null,
      payment: {
        grossCents: 10_500,
        processingCents: null,
        commissionCents: 200,
        recipientNetCents: null,
      },
    });
  });

  it.each([
    { deleted: true },
    { refunds: [{ id: "refund-1" }] },
    { chargeback: { status: "REQUESTED" } },
  ])(
    "does not credit a RECEIVED status with restricting payment facts %j",
    (restriction) => {
      expect(
        reconcileGiftPaymentObservation(paymentInput(restriction)),
      ).toMatchObject({
        outcome: "NOT_RECEIVED",
        reason: "PAYMENT_RESTRICTED",
        effect: null,
      });
    },
  );

  it.each([
    { checkoutSession: "different-checkout" },
    { externalReference: "different-attempt" },
    { billingType: "CREDIT_CARD" },
    { currency: "USD" },
  ])("rejects mismatching provider correlation %j", (changes) => {
    expect(() =>
      reconcileGiftPaymentObservation(paymentInput(changes)),
    ).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "PAYMENT_BINDING_MISMATCH",
      }),
    );
  });

  it.each([
    { siteId: "other-site" },
    { accountReference: "other-account" },
    { environment: "sandbox" },
    { provider: "OTHER_PROVIDER" },
    { source: "browser" },
    { currency: "USD" },
  ])("rejects an untrusted or differently bound observation %j", (changes) => {
    const input = fixture();
    expect(() =>
      reconcileGiftPaymentObservation({
        ...input,
        observation: { ...input.observation, ...changes },
      } as GiftPaymentReconciliationInput),
    ).toThrowError(
      expect.objectContaining({ code: "PAYMENT_BINDING_MISMATCH" }),
    );
  });

  it.each([
    { siteId: "other-site" },
    { accountReference: "other-account" },
    { environment: "sandbox" },
    { accountId: "" },
    { attemptId: "" },
  ])("rejects an invalid stored checkout binding %j", (changes) => {
    const input = fixture();
    expect(() =>
      reconcileGiftPaymentObservation({
        ...input,
        checkout: { ...input.checkout, ...changes },
      } as GiftPaymentReconciliationInput),
    ).toThrowError(
      expect.objectContaining({ code: "PAYMENT_BINDING_MISMATCH" }),
    );
  });

  it.each([undefined, "", "recipient-wallet-1"])(
    "requires the server-selected platform wallet %s",
    (platformWalletId) => {
      expect(() =>
        reconcileGiftPaymentObservation({
          ...fixture(),
          platformWalletId,
        } as GiftPaymentReconciliationInput),
      ).toThrowError(
        expect.objectContaining({ code: "PAYMENT_BINDING_MISMATCH" }),
      );
    },
  );

  it.each([
    { id: null },
    { checkoutSession: null },
    { status: null },
    { value: "0" },
    { value: "100,00" },
    { value: "1e2" },
    { value: 105.001 },
    { value: Infinity },
    { netValue: "106.00" },
    { split: [{ ...settledSplit, fixedValue: "2.001" }] },
  ])(
    "rejects required identity or malformed money %j without raw values in its error",
    (changes) => {
      expect(() =>
        reconcileGiftPaymentObservation(paymentInput(changes)),
      ).toThrowError(
        expect.objectContaining({ code: "PAYMENT_OBSERVATION_INVALID" }),
      );
    },
  );

  it.each([
    new Date(now.getTime() + 1),
    new Date("invalid"),
    new Date("2026-10-12T10:59:00.000Z"),
  ])(
    "rejects future/invalid observations and observations before the frozen quote: %s",
    (time) => {
      const input = fixture();
      expect(() =>
        reconcileGiftPaymentObservation({
          ...input,
          observation: { ...input.observation, observedAt: time },
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PAYMENT_OBSERVATION_INVALID" }),
      );
    },
  );

  it.each(["REFUNDED", "DISPUTED", "CANCELLED"] as const)(
    "does not regress verified terminal %s on a later RECEIVED observation",
    (state) => {
      const input = fixture();
      expect(
        reconcileGiftPaymentObservation({
          ...input,
          existingTerminal: {
            providerPaymentReference: "pay_1",
            state,
            observedAt: new Date("2026-10-12T11:59:00.000Z"),
          },
        }),
      ).toEqual({
        outcome: "NO_REGRESSION",
        reason: "TERMINAL_PAYMENT",
        payment: null,
        effect: null,
      });
    },
  );

  it("keeps actual payment identities independent even for the same checkout", () => {
    const one = reconcileGiftPaymentObservation(fixture());
    const two = reconcileGiftPaymentObservation(paymentInput({ id: "pay_2" }));
    expect(one.effect?.effectKey).not.toBe(two.effect?.effectKey);
    expect(two).toMatchObject({
      outcome: "RECEIVED",
      payment: { providerPaymentReference: "pay_2", attemptId: "attempt-1" },
    });
  });

  it("accepts numeric JSON money by strict decimal conversion and supports the quoted card method", () => {
    const input = paymentInput({
      billingType: "CREDIT_CARD",
      value: 105,
      netValue: 102,
      split: [{ ...settledSplit, fixedValue: 2 }],
    });
    const quoteSnapshot = {
      ...input.quoteSnapshot,
      quote: { ...input.quoteSnapshot.quote, method: "CREDIT_CARD" as const },
      pricing: {
        ...input.quoteSnapshot.pricing,
        policy: {
          ...input.quoteSnapshot.pricing.policy,
          method: "CREDIT_CARD" as const,
        },
      },
    };
    expect(
      reconcileGiftPaymentObservation({ ...input, quoteSnapshot }),
    ).toMatchObject({ outcome: "RECEIVED", effect: { amountCents: 10_000 } });
  });

  it.each([undefined, null])(
    "keeps a missing split observation unknown even when quoted commission rounds to zero: %s",
    (split) => {
      const input = paymentInput({ value: "3.01", netValue: "0.01", split });
      Object.assign(input.quoteSnapshot.quote, {
        nominalCents: 1,
        commissionCents: 0,
        totalCents: 301,
      });
      Object.assign(input.quoteSnapshot.gift, { nominalCents: 1 });
      const result = reconcileGiftPaymentObservation(input);
      expect(result).toMatchObject({
        outcome: "SPLIT_PENDING",
        reason: "SPLIT_NOT_SETTLED",
        payment: {
          grossCents: 301,
          processingCents: 300,
          commissionCents: null,
          recipientNetCents: null,
          splitFixedCents: null,
          splitProviderReference: null,
        },
        effect: null,
      });
    },
  );

  it("allows zero rounded commission only with no unsupported outgoing split", () => {
    const input = paymentInput({ value: "3.01", netValue: "0.01", split: [] });
    const quoteSnapshot = {
      ...input.quoteSnapshot,
      quote: {
        ...input.quoteSnapshot.quote,
        nominalCents: 1,
        commissionCents: 0,
        totalCents: 301,
      },
      gift: { ...input.quoteSnapshot.gift, nominalCents: 1 },
    };
    expect(
      reconcileGiftPaymentObservation({ ...input, quoteSnapshot }),
    ).toMatchObject({
      outcome: "RECEIVED",
      payment: {
        commissionCents: 0,
        splitFixedCents: 0,
        splitProviderReference: null,
        recipientNetCents: 1,
      },
      effect: { amountCents: 1 },
    });
  });

  it("whitelists new provider attributes without exposing payer, card token, secrets or URLs", () => {
    const input = paymentInput({
      creditCard: { creditCardToken: "private-card-token" },
      payer: { cpf: "private-tax-id", email: "private-payer-email" },
      access_token: "private-credential",
      invoiceUrl: "https://private-provider.example/secret",
      newProviderField: { confidential: "private-new-field" },
    });
    const unchanged = structuredClone(input);
    const result = reconcileGiftPaymentObservation(input);
    expect(result.outcome).toBe("RECEIVED");
    expect(JSON.stringify(result)).not.toMatch(
      /private-|invoiceUrl|creditCard|payer|access_token|https:/,
    );
    expect(input).toEqual(unchanged);
  });

  it("requires the frozen quote's nominal 200bps allocation", () => {
    const input = fixture();
    const quoteSnapshot = {
      ...input.quoteSnapshot,
      quote: {
        ...input.quoteSnapshot.quote,
        commissionCents: 201,
        totalCents: 10_501,
      },
    };
    expect(() =>
      reconcileGiftPaymentObservation({ ...input, quoteSnapshot }),
    ).toThrowError(
      expect.objectContaining({ status: 409, code: "PAYMENT_QUOTE_INVALID" }),
    );
  });

  it("supports canonical C1 local IDs without treating provider IDs as URLs", () => {
    const input = paymentInput({ externalReference: "attempt.1" });
    expect(
      reconcileGiftPaymentObservation({
        ...input,
        checkout: {
          ...input.checkout,
          orderId: "order:1",
          attemptId: "attempt.1",
        },
      }),
    ).toMatchObject({
      outcome: "RECEIVED",
      payment: { orderId: "order:1", attemptId: "attempt.1" },
    });
  });

  it("does not expose an arbitrary string as a provider status or retain raw error details", () => {
    let error: unknown;
    try {
      reconcileGiftPaymentObservation(
        paymentInput({ status: "private-credential" }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 400,
      code: "PAYMENT_OBSERVATION_INVALID",
    });
    expect(String(error)).not.toContain("private-credential");
    expect(error).not.toHaveProperty("cause");
  });

  it.each(["2.10", "2.04"])(
    "does not substitute 2%% of gross or provider net for 2%% nominal: %s",
    (fixedValue) => {
      expect(
        reconcileGiftPaymentObservation(
          paymentInput({ split: [{ ...settledSplit, fixedValue }] }),
        ),
      ).toMatchObject({ outcome: "DIVERGENT", effect: null });
    },
  );

  it("honors nearest-cent nominal commission independently from actual processing fee", () => {
    const input = paymentInput({
      value: "0.26",
      netValue: "0.26",
      split: [{ ...settledSplit, fixedValue: "0.01", totalValue: "0.01" }],
    });
    const quoteSnapshot = {
      ...input.quoteSnapshot,
      quote: {
        ...input.quoteSnapshot.quote,
        nominalCents: 25,
        commissionCents: 1,
        processingCents: 0,
        totalCents: 26,
      },
      gift: { ...input.quoteSnapshot.gift, nominalCents: 25 },
      pricing: {
        ...input.quoteSnapshot.pricing,
        policy: {
          ...input.quoteSnapshot.pricing.policy,
          processingFixedCents: 0,
        },
      },
    };
    expect(
      reconcileGiftPaymentObservation({ ...input, quoteSnapshot }),
    ).toMatchObject({
      outcome: "RECEIVED",
      payment: {
        grossCents: 26,
        processingCents: 0,
        commissionCents: 1,
        recipientNetCents: 25,
      },
      effect: { amountCents: 25 },
    });
  });
});

describe("explicit buyer gross-up settlement", () => {
  it.each(["101.99", "102.01"])(
    "reports a processing divergence for provider net %s without rewriting the quote",
    (netValue) => {
      const input = paymentInput({ netValue });
      input.quoteSnapshot.quote.feeAllocation = "BUYER_GROSS_UP";
      const frozen = structuredClone(input.quoteSnapshot);
      const result = reconcileGiftPaymentObservation(input);
      expect(result).toMatchObject({
        outcome: "DIVERGENT",
        reason: "ALLOCATION_MISMATCH",
        effect: null,
        payment: {
          processingCents: netValue === "101.99" ? 301 : 299,
          recipientNetCents: netValue === "101.99" ? 9999 : 10001,
          commissionCents: 200,
        },
      });
      expect(input.quoteSnapshot).toEqual(frozen);
    },
  );

  it("receives the exact explicit gross-up allocation", () => {
    const input = fixture();
    input.quoteSnapshot.quote.feeAllocation = "BUYER_GROSS_UP";
    expect(reconcileGiftPaymentObservation(input)).toMatchObject({
      outcome: "RECEIVED",
      effect: { amountCents: 10000 },
    });
  });
});

describe("recipient and historical fee settlement", () => {
  it.each(["RECIPIENT_DEDUCTED", undefined] as const)(
    "preserves actual recipient credit and the immutable estimate for allocation %s",
    (feeAllocation) => {
      const input = paymentInput({ netValue: "101.99" });
      if (feeAllocation === "RECIPIENT_DEDUCTED") {
        Object.assign(input.quoteSnapshot.quote, {
          feeAllocation,
          nominalCents: 10500,
          commissionCents: 210,
        });
        Object.assign(input.observation.payment as object, {
          split: [{ ...settledSplit, fixedValue: "2.10", totalValue: "2.10" }],
        });
        input.quoteSnapshot.gift.nominalCents = 10500;
      } else {
        expect(input.quoteSnapshot.quote).not.toHaveProperty("feeAllocation");
      }
      const frozen = structuredClone(input.quoteSnapshot);
      const recipientNetCents = feeAllocation ? 9989 : 9999;
      expect(reconcileGiftPaymentObservation(input)).toMatchObject({
        outcome: "RECEIVED",
        payment: { processingCents: 301, recipientNetCents },
        effect: { amountCents: recipientNetCents },
      });
      expect(input.quoteSnapshot).toEqual(frozen);
    },
  );
});
