import { describe, expect, it } from "vitest";
import { buildAsaasCheckoutPayload } from "./asaasCheckoutPayload";
import type { GiftQuoteSnapshot } from "./giftQuotes";

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

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "permits an HTTP loopback callback for sandbox only: %s",
    (host) => {
      const values = fixture();
      const publicOrigin = `http://${host}:4321`;
      values.options.publicOrigin = publicOrigin;
      values.options.callbacks = {
        successUrl: `${publicOrigin}/presentes`,
        cancelUrl: `${publicOrigin}/presentes`,
        expiredUrl: `${publicOrigin}/presentes`,
      };
      expect(
        buildAsaasCheckoutPayload(values.command, values.options).callback,
      ).toEqual(values.options.callbacks);
      values.options.environment = "live";
      values.snapshot.quote.mode = "live";
      values.snapshot.receiving.environment = "live";
      values.snapshot.pricing.environment = "live";
      expect(() =>
        buildAsaasCheckoutPayload(values.command, values.options),
      ).toThrow();
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
