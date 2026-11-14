import { describe, expect, it } from "vitest";
import {
  buildAsaasCheckoutPayload,
  readAsaasCheckoutTerms,
} from "./asaasCheckoutPayload";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import { buildGiftV2Settlement, type GiftQuoteSnapshot } from "./giftQuotes";

function fixture() {
  const binding = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    environment: "sandbox" as const,
    accountReference: "account-one",
    recipientReference: "recipient-one",
    destinationVersion: 1,
    bankReference: "bank-one",
  };
  const snapshot: GiftQuoteSnapshot = {
    quote: {
      id: "quote-one",
      siteId: "site-one",
      giftId: "gift-one",
      title: "Symbolic gift",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 0,
      totalCents: 10200,
      policyVersion: "verified-one",
      expiresAt: "2026-10-12T12:05:00.000Z",
      mode: "sandbox",
    },
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Symbolic gift",
      description: "Symbolic contribution",
      nominalCents: 10000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving: binding,
    pricing: {
      ...binding,
      verification: "verified",
      provenance: "provider",
      observedAt: "2026-10-12T11:59:00.000Z",
      expiresAt: "2026-10-12T12:10:00.000Z",
      policy: {
        version: "verified-one",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt: "2026-10-12T12:00:00.000Z",
    expiresAt: "2026-10-12T12:05:00.000Z",
  };
  const options = {
    environment: "sandbox" as "sandbox" | "live",
    platformWalletId: "platform-wallet",
    publicOrigin: "https://wedding.example.test",
    minutesToExpire: 10,
    callbacks: {
      successUrl: "https://wedding.example.test/gifts/return",
      cancelUrl: "https://wedding.example.test/gifts/canceled",
      expiredUrl: "https://wedding.example.test/gifts/expired",
    },
  };
  return {
    command: {
      siteId: "site-one",
      attemptId: "attempt-one",
      quoteSnapshot: snapshot,
    },
    options,
    snapshot,
  };
}

describe("Asaas hosted checkout payload", () => {
  it.each(["PIX", "CREDIT_CARD"] as const)(
    "charges only the configured 1000 cents for %s and splits 20 cents",
    (method) => {
      const values = fixture();
      Object.assign(values.snapshot.quote, {
        method,
        nominalCents: 1000,
        totalCents: 1000,
        commissionCents: 20,
        processingCents: 99,
        feeAllocation: "RECIPIENT_DEDUCTED",
      });
      values.snapshot.gift.nominalCents = 1000;
      Object.assign(values.snapshot.pricing.policy, {
        method,
        processingFixedCents: 99,
        feeAllocation: "RECIPIENT_DEDUCTED",
      });
      const payload = buildAsaasCheckoutPayload(values.command, values.options);
      expect(payload.items).toEqual([
        { name: "Symbolic gift", quantity: 1, value: 10 },
      ]);
      expect(payload.splits).toEqual([
        { walletId: "platform-wallet", fixedValue: 0.2 },
      ]);
      delete values.snapshot.pricing.policy.feeAllocation;
      expect(() =>
        buildAsaasCheckoutPayload(values.command, values.options),
      ).toThrow("Checkout payload unavailable");
    },
  );

  it("permits local test pricing only with a server-authorized development demo matching the purchase scope", () => {
    const values = fixture();
    values.snapshot.pricing.provenance = "local-test";
    const options = {
      ...values.options,
      sandboxDemoPricing: {
        siteId: "site-one",
        accountReference: "account-one",
        isDemo: true,
        applicationEnvironment: "development" as const,
      },
    };
    expect(
      buildAsaasCheckoutPayload(values.command, options).items[0].value,
    ).toBe(102);
    expect(values.snapshot.pricing.provenance).toBe("local-test");
  });

  it.each([
    { isDemo: false },
    { applicationEnvironment: "production" },
    { applicationEnvironment: "test" },
    { siteId: "other" },
    { accountReference: "other" },
  ])("rejects unauthorized local test pricing: %j", (change) => {
    const values = fixture();
    values.snapshot.pricing.provenance = "local-test";
    const sandboxDemoPricing = {
      siteId: "site-one",
      accountReference: "account-one",
      isDemo: true,
      applicationEnvironment: "development",
      ...change,
    };
    expect(() =>
      buildAsaasCheckoutPayload(values.command, {
        ...values.options,
        sandboxDemoPricing,
      } as never),
    ).toThrow();
  });

  it("never permits a demo authorization to enable local test pricing in live mode", () => {
    const values = fixture();
    values.snapshot.pricing.provenance = "local-test";
    values.options.environment = "live";
    values.snapshot.quote.mode = "live";
    values.snapshot.receiving.environment = "live";
    values.snapshot.pricing.environment = "live";
    expect(() =>
      buildAsaasCheckoutPayload(values.command, {
        ...values.options,
        sandboxDemoPricing: {
          siteId: "site-one",
          accountReference: "account-one",
          isDemo: true,
          applicationEnvironment: "development",
        },
      }),
    ).toThrow();
  });

  it.each([
    "http://localhost:4321",
    "https://localhost:4321",
    "http://127.0.0.1:4321",
    "https://127.0.0.1:4321",
    "http://[::1]:4321",
    "https://[::1]:4321",
    "https://preview.localhost",
  ])(
    "rejects loopback provider callbacks even in Sandbox: %s",
    (publicOrigin) => {
      const values = fixture();
      values.options.publicOrigin = publicOrigin;
      values.options.callbacks = {
        successUrl: `${publicOrigin}/`,
        cancelUrl: `${publicOrigin}/`,
        expiredUrl: `${publicOrigin}/`,
      };
      expect(() =>
        buildAsaasCheckoutPayload(values.command, values.options),
      ).toThrow("Checkout payload unavailable");
    },
  );

  it.each(["http://wedding.example.test", "http://localhost.evil.test:4321"])(
    "rejects non-loopback HTTP sandbox origins: %s",
    (publicOrigin) => {
      const values = fixture();
      values.options.publicOrigin = publicOrigin;
      values.options.callbacks = {
        successUrl: `${publicOrigin}/presentes`,
        cancelUrl: `${publicOrigin}/presentes`,
        expiredUrl: `${publicOrigin}/presentes`,
      };
      expect(() =>
        buildAsaasCheckoutPayload(values.command, values.options),
      ).toThrow();
    },
  );

  it("uses one quoted method, detached charge, exact fixed nominal commission and durable external reference", () => {
    const values = fixture();
    const payload = buildAsaasCheckoutPayload(values.command, values.options);
    expect(payload).toEqual({
      billingTypes: ["PIX"],
      chargeTypes: ["DETACHED"],
      minutesToExpire: 10,
      externalReference: "attempt-one",
      callback: values.options.callbacks,
      items: [{ name: "Symbolic gift", quantity: 1, value: 102 }],
      splits: [{ walletId: "platform-wallet", fixedValue: 2 }],
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /percentualValue|customerData|creditCard|accountReference|bankReference|recoveryToken/,
    );
    expect(values.snapshot.quote.totalCents).toBe(10200);
  });

  it("restricts a credit card quote to a single detached payment", () => {
    const values = fixture();
    values.snapshot.quote.method = "CREDIT_CARD";
    values.snapshot.pricing.policy.method = "CREDIT_CARD";
    expect(
      buildAsaasCheckoutPayload(values.command, values.options).billingTypes,
    ).toEqual(["CREDIT_CARD"]);
  });

  it("omits a zero-cent split instead of manufacturing a provider minimum", () => {
    const values = fixture();
    Object.assign(values.snapshot.quote, {
      nominalCents: 1,
      commissionCents: 0,
      totalCents: 1,
    });
    values.snapshot.gift.nominalCents = 1;
    const payload = buildAsaasCheckoutPayload(values.command, values.options);
    expect(payload.items[0].value).toBe(0.01);
    expect(payload.splits).toEqual([]);
  });

  it.each([
    { environment: "live" },
    { platformWalletId: "" },
    { platformWalletId: "platform-wallet\n" },
    { platformWalletId: "recipient-one" },
    { minutesToExpire: 9 },
    { minutesToExpire: 1441 },
    { minutesToExpire: 10.5 },
    { publicOrigin: "https://wedding.example.test/path" },
  ])("rejects invalid injected server configuration %j", (change) => {
    const values = fixture();
    expect(() =>
      buildAsaasCheckoutPayload(values.command, {
        ...values.options,
        ...change,
      } as typeof values.options),
    ).toThrow("Checkout payload unavailable");
  });

  it.each([
    "https://evil.example.test/return",
    "http://wedding.example.test/return",
    "https://user:secret@wedding.example.test/return",
    "https://wedding.example.test/return?recoveryToken=private",
    "https://wedding.example.test/return#private",
  ])("rejects foreign or token-bearing callback %s", (successUrl) => {
    const values = fixture();
    expect(() =>
      buildAsaasCheckoutPayload(values.command, {
        ...values.options,
        callbacks: { ...values.options.callbacks, successUrl },
      }),
    ).toThrow("Checkout payload unavailable");
  });

  it.each([
    "site",
    "provider",
    "account",
    "amount",
    "policy",
    "gift",
    "provenance",
  ])("rejects inconsistent immutable %s binding", (change) => {
    const values = fixture();
    if (change === "site") values.command.siteId = "other";
    if (change === "provider") values.snapshot.receiving.provider = "OTHER";
    if (change === "account")
      values.snapshot.pricing.accountReference = "other";
    if (change === "amount") values.snapshot.quote.totalCents++;
    if (change === "policy")
      values.snapshot.pricing.policy.processingFixedCents = 1;
    if (change === "gift") values.snapshot.gift.id = "other";
    if (change === "provenance")
      values.snapshot.pricing.provenance = "local-test";
    expect(() =>
      buildAsaasCheckoutPayload(values.command, values.options),
    ).toThrow("Checkout payload unavailable");
  });

  it("does not retain extra provider credentials or mutable callback objects", () => {
    const values = fixture();
    Object.assign(values.snapshot.receiving, { apiKey: "private" });
    const payload = buildAsaasCheckoutPayload(values.command, values.options);
    values.options.callbacks.successUrl = "https://evil.example.test";
    expect(payload.callback.successUrl).toBe(
      "https://wedding.example.test/gifts/return",
    );
    expect(JSON.stringify(payload)).not.toContain("private");
  });
});

describe("Sandbox buyer homologation payload", () => {
  it("requires exact server authorization and splits only the nominal commission", () => {
    const v = fixture();
    Object.assign(v.snapshot.quote, { feeAllocation: "BUYER_GROSS_UP" });
    Object.assign(v.snapshot.pricing.policy, {
      feeBasis: "SANDBOX_BUYER_ESTIMATE",
      feeAllocation: "BUYER_GROSS_UP",
    });
    const options = {
      ...v.options,
      sandboxBuyerGrossUpSiteId: "site-one",
      sandboxDemoPricing: {
        siteId: "site-one",
        accountReference: "account-one",
        isDemo: true,
        applicationEnvironment: "development" as const,
      },
    };
    expect(buildAsaasCheckoutPayload(v.command, options).splits).toEqual([
      { walletId: "platform-wallet", fixedValue: 2 },
    ]);
    for (const change of [
      { sandboxBuyerGrossUpSiteId: undefined },
      { sandboxBuyerGrossUpSiteId: "other" },
      { environment: "live" },
      {
        sandboxDemoPricing: {
          ...options.sandboxDemoPricing,
          applicationEnvironment: "production",
        },
      },
    ])
      expect(() =>
        buildAsaasCheckoutPayload(v.command, {
          ...options,
          ...change,
        } as never),
      ).toThrow();
  });
});

function v2Fixture(method: "PIX" | "CREDIT_CARD", installmentCount?: number) {
  const values = fixture();
  const policy = platformTariffPolicy(method);
  const amounts = quoteGiftPurchaseAmounts(
    { nominalCents: 10000, method, policy },
    installmentCount,
  );
  Object.assign(values.snapshot.quote, {
    method,
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
    ...amounts,
  });
  values.snapshot.pricing.provenance = "platform-tariff-table";
  values.snapshot.pricing.policy = policy as never;
  Object.assign(values.snapshot, {
    settlement: buildGiftV2Settlement(values.snapshot.quote),
  });
  return values;
}

describe("PLATFORM_ACCOUNT_SPLIT_V2 hosted checkout payload", () => {
  it.each(["PIX", "CREDIT_CARD"] as const)(
    "splits the full nominal to the couple wallet for %s and keeps the commission in the main account",
    (method) => {
      const values = v2Fixture(method);
      const payload = buildAsaasCheckoutPayload(values.command, values.options);
      expect(payload.items[0].value).toBe(
        values.snapshot.quote.totalCents / 100,
      );
      expect(payload.splits).toEqual([
        { walletId: "recipient-one", fixedValue: 100 },
      ]);
      expect(JSON.stringify(payload)).not.toContain("platform-wallet");
    },
  );

  it("still refuses a platform wallet equal to the couple wallet", () => {
    const values = v2Fixture("PIX");
    expect(() =>
      buildAsaasCheckoutPayload(values.command, {
        ...values.options,
        platformWalletId: "recipient-one",
      }),
    ).toThrow("Checkout payload unavailable");
  });

  it("refuses tariff-table provenance for a V1 quote and provider provenance for a V2 quote", () => {
    const v1 = fixture();
    v1.snapshot.pricing.provenance = "platform-tariff-table";
    expect(() => buildAsaasCheckoutPayload(v1.command, v1.options)).toThrow(
      "Checkout payload unavailable",
    );
    const v2 = v2Fixture("PIX");
    v2.snapshot.pricing.provenance = "provider";
    expect(() => buildAsaasCheckoutPayload(v2.command, v2.options)).toThrow(
      "Checkout payload unavailable",
    );
  });

  it("refuses a V2 quote whose frozen settlement is missing or altered", () => {
    const missing = v2Fixture("PIX");
    Object.assign(missing.snapshot, { settlement: undefined });
    expect(() =>
      buildAsaasCheckoutPayload(missing.command, missing.options),
    ).toThrow("Checkout payload unavailable");
    const altered = v2Fixture("PIX");
    Object.assign(altered.snapshot, {
      settlement: {
        ...altered.snapshot.settlement,
        recipientSplitCents: [9999],
      },
    });
    expect(() =>
      buildAsaasCheckoutPayload(altered.command, altered.options),
    ).toThrow("Checkout payload unavailable");
  });

  it("returns the frozen per-installment couple split for an installment quote but refuses a hosted payload", () => {
    const values = v2Fixture("CREDIT_CARD", 3);
    const terms = readAsaasCheckoutTerms(values.command, values.options);
    expect(terms.settlement?.recipientSplitCents).toEqual(
      values.snapshot.settlement?.recipientSplitCents,
    );
    expect(
      terms.settlement?.recipientSplitCents.reduce((a, b) => a + b, 0),
    ).toBe(10000);
    expect(() =>
      buildAsaasCheckoutPayload(values.command, values.options),
    ).toThrow("Checkout payload unavailable");
  });
});
