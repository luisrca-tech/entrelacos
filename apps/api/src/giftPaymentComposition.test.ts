import type { DatabaseConnection } from "@entrelacos/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createGiftPaymentComposition } from "./giftPaymentComposition";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import { encryptProviderCredential } from "./providerCredentials";

// Exercise the composition's private provider boundary; checkout reservation logic
// has its own repository tests and must not be replaced by an in-memory ledger.
vi.mock("./giftCheckouts", async (original) => ({
  ...(await original<typeof import("./giftCheckouts")>()),
  createGiftCheckoutService: (dependencies: {
    createHostedCheckout(command: unknown): Promise<{ checkout: unknown }>;
  }) => ({
    createCheckout: async (_site: unknown, command: unknown) =>
      (await dependencies.createHostedCheckout(command)).checkout,
  }),
}));

vi.mock("./giftQuotes", async (original) => ({
  ...(await original<typeof import("./giftQuotes")>()),
  createGiftQuoteService: (dependencies: {
    loadPricingPolicy(scope: unknown): Promise<unknown>;
  }) => ({
    createQuote: (_site: unknown, scope: unknown) =>
      dependencies.loadPricingPolicy(scope),
  }),
}));

function checkoutFixture() {
  const now = new Date("2026-10-16T16:00:00.000Z");
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
      expiresAt: "2026-10-16T16:05:00.000Z",
      mode: "sandbox",
    },
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Symbolic gift",
      description: "Contribution",
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
      observedAt: "2026-10-16T16:00:00.000Z",
      expiresAt: "2026-10-16T16:05:00.000Z",
      policy: {
        version: "verified-one",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt: "2026-10-16T16:00:00.000Z",
    expiresAt: "2026-10-16T16:05:00.000Z",
  };
  const config = configuration();
  if (config.mode === "disabled")
    throw new Error("Enabled configuration required");
  const envelope = encryptProviderCredential(
    "$aact_hmlg_subaccount-secret",
    {
      provider: "ASAAS",
      siteId: "site-one",
      accountBindingId: "receiving-one",
      environment: "sandbox",
    },
    config.credentialKeyring,
    config.credentialKeyId,
  );
  const account = {
    id: "receiving-one",
    siteId: "site-one",
    provider: "ASAAS",
    environment: "sandbox",
    isCurrent: true,
    accountReference: "account-one",
    operatorReference: "operator-one",
    recipientReference: "recipient-one",
    credentialVersion: envelope.version,
    credentialKeyId: envelope.keyId,
    credentialNonce: envelope.nonce,
    credentialCiphertext: envelope.ciphertext,
    credentialTag: envelope.tag,
  };
  const values = fixture();
  const rows: unknown[][] = [
    [{ account, isDemo: true }],
    [{ origin: values.publicOrigin }],
  ];
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: vi.fn(async () => rows.shift() ?? []),
  };
  values.db.select = vi.fn(() => query) as never;
  values.fetch.mockResolvedValue(
    new Response(JSON.stringify({ id: "checkout-one" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return {
    ...values,
    now: () => now,
    config,
    snapshot,
    account,
    rows,
    command: {
      siteId: "site-one",
      orderId: "order-one",
      attemptId: "attempt-one",
      requestId: "request-one",
      quoteSnapshot: snapshot,
    },
  };
}

function configuration(): GiftPaymentConfig {
  return {
    mode: "sandbox",
    applicationEnvironment: "development",
    platformApiKey: "$aact_hmlg_platform",
    platformAccountId: "platform-account",
    platformWalletId: "platform-wallet",
    credentialKeyId: "development-key",
    credentialKeyring: new Map([
      ["development-key", new Uint8Array(32).fill(1)],
    ]),
    webhookPublicOrigin: "https://tunnel.example.test",
    webhookUrl: "https://tunnel.example.test/v1/webhooks/asaas",
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const db = {
    select: vi.fn(() => {
      throw new Error("Unexpected database access");
    }),
    execute: vi.fn(() => {
      throw new Error("Unexpected database access");
    }),
    transaction: vi.fn(() => {
      throw new Error("Unexpected database access");
    }),
  } as unknown as DatabaseConnection["db"];
  const fetch = vi.fn<typeof globalThis.fetch>();
  const completion = deferred();
  const loop = {
    start: vi.fn(() => completion.promise),
    stop: vi.fn(() => completion.promise),
  };
  const createWorkerLoop = vi.fn(() => loop);
  return {
    db,
    fetch,
    loop,
    completion,
    createWorkerLoop,
    publicOrigin: "http://localhost:4321",
  };
}

function emptyWithdrawalHistory(siteId = "site-one") {
  return {
    rows: [
      {
        id: null,
        siteId,
        amountCents: null,
        feeCents: null,
        netCents: null,
        currency: null,
        destinationVersion: null,
        state: null,
        createdAt: null,
        updatedAt: null,
        mode: null,
        accountMatches: false,
      },
    ],
  };
}

describe("gift payment composition", () => {
  it.each(["sandbox", "live"] as const)(
    "reads actual empty withdrawal history without a receiving account in %s mode",
    async (mode) => {
      const values = fixture();
      const execute = vi.fn(async (_query: SQL) => emptyWithdrawalHistory());
      values.db.execute = execute as never;
      const config = { ...configuration(), mode } as GiftPaymentConfig;
      const composition = createGiftPaymentComposition(config, values);
      expect(composition.ports.finance?.listWithdrawals).toBeTypeOf("function");
      await expect(
        composition.ports.finance?.listWithdrawals?.("site-one"),
      ).resolves.toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(query.params).toEqual([mode, "site-one", mode, null]);
      expect(values.db.select).not.toHaveBeenCalled();
      expect(values.fetch).not.toHaveBeenCalled();
      await composition.close();
    },
  );

  it("preserves stored withdrawal history site validation", async () => {
    const values = fixture();
    values.db.execute = vi.fn(async () =>
      emptyWithdrawalHistory("another-site"),
    ) as never;
    const composition = createGiftPaymentComposition(configuration(), values);
    expect(composition.ports.finance?.listWithdrawals).toBeTypeOf("function");
    await expect(
      composition.ports.finance?.listWithdrawals?.("site-one"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
    await composition.close();
  });

  it("drains withdrawal history reads before closing and rejects new reads after close", async () => {
    const values = fixture();
    const query = deferred();
    values.db.execute = vi.fn(async () => {
      await query.promise;
      return emptyWithdrawalHistory();
    }) as never;
    const composition = createGiftPaymentComposition(configuration(), values);
    expect(composition.ports.finance?.listWithdrawals).toBeTypeOf("function");
    const reading = composition.ports.finance?.listWithdrawals?.("site-one");
    await Promise.resolve();
    expect(values.db.execute).toHaveBeenCalledTimes(1);
    const closing = composition.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      composition.ports.finance?.listWithdrawals?.("site-one"),
    ).rejects.toThrow("Gift payment composition unavailable");
    query.resolve();
    await expect(reading).resolves.toEqual([]);
    await closing;
    expect(closed).toBe(true);
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it("preserves observed real Sandbox quota and promotion conditions through the native fee reader", async () => {
    const values = checkoutFixture();
    values.rows.splice(
      0,
      values.rows.length,
      [{ account: values.account, isDemo: true }],
      [{ account: values.account, isDemo: true }],
    );
    values.db.execute = vi.fn(async () => ({
      rows: [
        {
          ...values.account,
          accountBindingId: values.account.id,
          isDemo: true,
        },
      ],
    })) as never;
    values.fetch.mockImplementation(async () =>
      Response.json({
        payment: {
          pix: {
            type: "FIXED",
            fixedFeeValue: 1.99,
            fixedFeeValueWithDiscount: 0.99,
            discountExpiration: "2027-01-16 00:00:00",
            percentageFee: null,
            minimumFeeValue: null,
            maximumFeeValue: null,
            monthlyCreditsWithoutFee: 100,
            creditsReceivedOfCurrentMonth: 0,
          },
          creditCard: {
            operationValue: 0.49,
            oneInstallmentPercentage: 2.99,
            discountOneInstallmentPercentage: 1.99,
            hasValidDiscount: true,
            discountExpiration: "2027-01-16 00:00:00",
          },
        },
      }),
    );
    const composition = createGiftPaymentComposition(values.config, values);
    expect(
      await composition.ports.giftPayments?.createQuote("site-one", {
        ...values.snapshot.receiving,
        method: "PIX",
      }),
    ).toMatchObject({
      provenance: "provider",
      policy: {
        processingFixedCents: 0,
        processingBasisPoints: 0,
        feeBasis: "OBSERVED_ESTIMATE",
        feeAllocation: "RECIPIENT_DEDUCTED",
      },
    });
    expect(
      await composition.ports.giftPayments?.createQuote("site-one", {
        ...values.snapshot.receiving,
        method: "CREDIT_CARD",
      }),
    ).toMatchObject({
      provenance: "provider",
      policy: {
        processingFixedCents: 49,
        processingBasisPoints: 199,
        feeBasis: "OBSERVED_ESTIMATE",
        feeAllocation: "RECIPIENT_DEDUCTED",
      },
    });
    await composition.close();
  });
  it("automatically prices only persisted development Sandbox demo accounts using their actual fee response", async () => {
    const values = checkoutFixture();
    values.db.execute = vi.fn(async () => ({
      rows: [
        {
          ...values.account,
          accountBindingId: values.account.id,
          isDemo: true,
        },
      ],
    })) as never;
    values.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          payment: {
            pix: {
              fixedFeeValue: 0.99,
              percentageFee: 0,
              minimumFeeValue: 0,
              maximumFeeValue: 0,
              monthlyCreditsWithoutFee: 0,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const composition = createGiftPaymentComposition(values.config, values);
    const result = await composition.ports.giftPayments?.createQuote(
      "site-one",
      { ...values.snapshot.receiving, method: "PIX" },
    );
    expect(result).toMatchObject({
      provenance: "provider",
      policy: {
        processingFixedCents: 99,
        processingBasisPoints: 0,
        commissionBasisPoints: 200,
      },
    });
    expect(String(values.fetch.mock.calls[0][0])).toBe(
      "https://api-sandbox.asaas.com/v3/myAccount/fees/",
    );
    expect(
      new Headers(values.fetch.mock.calls[0][1]?.headers).get("access_token"),
    ).toBe("$aact_hmlg_subaccount-secret");
    await composition.close();
  });

  it("prices a production recipient from bound native fees without an unimplemented fee-profile service", async () => {
    const values = checkoutFixture();
    const config = {
      ...values.config,
      mode: "live",
      applicationEnvironment: "production",
    } as const;
    if (config.credentialKeyring === undefined)
      throw new Error("Missing test keyring");
    const envelope = encryptProviderCredential(
      "$aact_prod_private-live-account-key",
      {
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "receiving-one",
        environment: "live",
      },
      config.credentialKeyring,
      config.credentialKeyId,
    );
    Object.assign(values.account, {
      environment: "live",
      credentialNonce: envelope.nonce,
      credentialCiphertext: envelope.ciphertext,
      credentialTag: envelope.tag,
    });
    values.rows[0] = [{ account: values.account, isDemo: false }];
    values.db.execute = vi.fn(async () => ({
      rows: [
        {
          ...values.account,
          accountBindingId: values.account.id,
          isDemo: false,
        },
      ],
    })) as never;
    values.fetch.mockResolvedValue(
      Response.json({
        payment: {
          pix: {
            type: "FIXED",
            fixedFeeValue: 1.99,
            percentageFee: null,
            minimumFeeValue: null,
            maximumFeeValue: null,
            monthlyCreditsWithoutFee: 0,
          },
        },
      }),
    );
    const composition = createGiftPaymentComposition(config, values);
    const result = await composition.ports.giftPayments?.createQuote(
      "site-one",
      { ...values.snapshot.receiving, environment: "live", method: "PIX" },
    );
    expect(result).toMatchObject({
      provenance: "provider",
      environment: "live",
      policy: {
        feeAllocation: "RECIPIENT_DEDUCTED",
        feeBasis: "OBSERVED_ESTIMATE",
        processingFixedCents: 199,
        processingBasisPoints: 0,
      },
    });
    expect(String(values.fetch.mock.calls[0][0])).toBe(
      "https://api.asaas.com/v3/myAccount/fees/",
    );
    await composition.close();
  });

  it("creates a live observed-price checkout for exactly the configured gift value", async () => {
    const values = checkoutFixture();
    values.publicOrigin = "https://wedding.example.test";
    values.rows[1] = [{ origin: values.publicOrigin }];
    const config = {
      ...values.config,
      mode: "live",
      applicationEnvironment: "production",
    } as const;
    if (config.credentialKeyring === undefined)
      throw new Error("Missing test keyring");
    const envelope = encryptProviderCredential(
      "$aact_prod_private-live-account-key",
      {
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "receiving-one",
        environment: "live",
      },
      config.credentialKeyring,
      config.credentialKeyId,
    );
    Object.assign(values.account, {
      environment: "live",
      credentialNonce: envelope.nonce,
      credentialCiphertext: envelope.ciphertext,
      credentialTag: envelope.tag,
    });
    values.rows[0] = [{ account: values.account, isDemo: false }];
    values.snapshot.receiving.environment = "live" as never;
    values.snapshot.pricing.environment = "live" as never;
    values.snapshot.quote.mode = "live";
    Object.assign(values.snapshot.pricing.policy, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      feeBasis: "OBSERVED_ESTIMATE",
    });
    Object.assign(values.snapshot.quote, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      totalCents: 10000,
    });
    const composition = createGiftPaymentComposition(config, values);
    expect(
      await composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).toMatchObject({
      hostedUrl: "https://asaas.com/checkoutSession/show?id=checkout-one",
    });
    const payload = JSON.parse(String(values.fetch.mock.calls[0][1]?.body));
    expect(payload.items).toEqual([
      { name: "Symbolic gift", quantity: 1, value: 100 },
    ]);
    expect(payload.splits).toEqual([
      { walletId: "platform-wallet", fixedValue: 2 },
    ]);
    expect(String(values.fetch.mock.calls[0][0])).toBe(
      "https://api.asaas.com/v3/checkouts",
    );
    await composition.close();
  });
  it("creates the exact-price real checkout for an opted-in production showcase", async () => {
    const values = checkoutFixture();
    values.publicOrigin = "https://wedding.example.test";
    values.rows[1] = [{ origin: values.publicOrigin }];
    const config = {
      ...values.config,
      mode: "live",
      applicationEnvironment: "production",
      liveDemoSiteId: "site-one",
    } as const;
    if (config.credentialKeyring === undefined)
      throw new Error("Missing test keyring");
    const envelope = encryptProviderCredential(
      "$aact_prod_private-live-account-key",
      {
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "receiving-one",
        environment: "live",
      },
      config.credentialKeyring,
      config.credentialKeyId,
    );
    Object.assign(values.account, {
      environment: "live",
      credentialNonce: envelope.nonce,
      credentialCiphertext: envelope.ciphertext,
      credentialTag: envelope.tag,
    });
    values.rows[0] = [{ account: values.account, isDemo: true }];
    values.snapshot.receiving.environment = "live" as never;
    values.snapshot.pricing.environment = "live" as never;
    values.snapshot.quote.mode = "live";
    Object.assign(values.snapshot.pricing.policy, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      feeBasis: "OBSERVED_ESTIMATE",
    });
    Object.assign(values.snapshot.quote, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      totalCents: 10000,
    });
    const composition = createGiftPaymentComposition(config, values);
    expect(
      await composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).toMatchObject({
      hostedUrl: "https://asaas.com/checkoutSession/show?id=checkout-one",
    });
    const payload = JSON.parse(String(values.fetch.mock.calls[0][1]?.body));
    expect(payload.items).toEqual([
      { name: "Symbolic gift", quantity: 1, value: 100 },
    ]);
    expect(payload.splits).toEqual([
      { walletId: "platform-wallet", fixedValue: 2 },
    ]);
    expect(String(values.fetch.mock.calls[0][0])).toBe(
      "https://api.asaas.com/v3/checkouts",
    );
    await composition.close();
  });
  it("does not give non-demo Sandbox accounts a demo pricing policy", async () => {
    const values = checkoutFixture();
    values.rows[0] = [{ account: values.account, isDemo: false }];
    const composition = createGiftPaymentComposition(values.config, values);
    expect(
      await composition.ports.giftPayments?.createQuote("site-one", {
        ...values.snapshot.receiving,
        method: "PIX",
      }),
    ).toBeNull();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });

  it("keeps the automatic demo pricing path disabled outside development", async () => {
    const values = checkoutFixture();
    const composition = createGiftPaymentComposition(
      { ...values.config, applicationEnvironment: "test" },
      values,
    );
    expect(
      await composition.ports.giftPayments?.createQuote("site-one", {
        ...values.snapshot.receiving,
        method: "PIX",
      }),
    ).toBeNull();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });

  it("creates the real hosted Sandbox checkout with local test evidence only after verifying the stored demo", async () => {
    const values = checkoutFixture();
    values.snapshot.pricing.provenance = "local-test";
    const composition = createGiftPaymentComposition(values.config, values);
    expect(
      await composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).toMatchObject({
      hostedUrl: "https://sandbox.asaas.com/checkoutSession/show/checkout-one",
    });
    expect(String(values.fetch.mock.calls[0][1]?.body)).not.toMatch(
      /sandboxDemoPricing|local-test|isDemo/,
    );
    await composition.close();
  });

  it("rejects a copied demo-priced quote when the persisted site is no longer a demo", async () => {
    const values = checkoutFixture();
    values.snapshot.pricing.provenance = "local-test";
    values.rows[0] = [{ account: values.account, isDemo: false }];
    const composition = createGiftPaymentComposition(values.config, values);
    await expect(
      composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).rejects.toThrow();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });
  it("rejects an observed fee estimate copied outside its persisted DEV Sandbox demo scope", async () => {
    const values = checkoutFixture();
    values.snapshot.pricing.provenance = "provider";
    values.snapshot.pricing.policy.feeBasis = "OBSERVED_ESTIMATE";
    values.rows[0] = [{ account: values.account, isDemo: false }];
    const composition = createGiftPaymentComposition(values.config, values);
    await expect(
      composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).rejects.toThrow();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });
  it("keeps disabled mode inert, including unavailable configuration and dependencies", async () => {
    const options = new Proxy(
      {},
      {
        get() {
          throw new Error("Unexpected dependency access");
        },
      },
    );
    const composition = createGiftPaymentComposition(
      { mode: "disabled" },
      options as never,
    );
    expect(composition.ports).toEqual({});
    composition.start();
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it("assembles enabled ports without touching the database or dispatching provider requests", async () => {
    const values = fixture();
    const composition = createGiftPaymentComposition(configuration(), values);
    expect(Object.keys(composition.ports).sort()).toEqual([
      "asaasWebhook",
      "finance",
      "giftPayments",
      "receiving",
      "withdrawalReservation",
    ]);
    expect(values.fetch).not.toHaveBeenCalled();
    expect(values.loop.start).not.toHaveBeenCalled();
    await composition.close();
    expect(values.loop.stop).not.toHaveBeenCalled();
  });

  it("composes an independent opt-in withdrawal authorization receiver and owns its lifecycle", async () => {
    const values = fixture();
    const authorizationToken = "fixture-withdrawal-authorization-secret";
    const config = configuration();
    if (config.mode === "disabled") throw new Error("Expected enabled fixture");
    const composition = createGiftPaymentComposition(
      {
        ...config,
        withdrawalAuthorization: {
          token: authorizationToken,
          url: "https://webhook.example.test/v1/webhooks/asaas/withdrawal-authorization",
        },
      },
      values,
    );
    expect(composition.ports.asaasWithdrawalAuthorization).toBeDefined();
    expect(values.fetch).not.toHaveBeenCalled();
    await expect(
      composition.ports.asaasWithdrawalAuthorization?.receive(
        "different-fixture-authorization-token",
        "{}",
      ),
    ).resolves.toEqual({ status: "REFUSED" });
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
    await expect(
      composition.ports.asaasWithdrawalAuthorization?.receive(
        authorizationToken,
        "{}",
      ),
    ).rejects.toThrow("Gift payment composition unavailable");
  });

  it("starts one owned worker and waits for its actual stop before finishing close", async () => {
    const values = fixture();
    const composition = createGiftPaymentComposition(configuration(), values);
    composition.start();
    composition.start();
    expect(values.loop.start).toHaveBeenCalledTimes(1);
    const closing = composition.close();
    expect(composition.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(values.loop.stop).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    values.completion.resolve();
    await closing;
    expect(() => composition.start()).toThrow(
      "Gift payment composition unavailable",
    );
    await expect(
      composition.ports.giftPayments?.createQuote("site-one", {}),
    ).rejects.toThrow("Gift payment composition unavailable");
  });

  it("never accepts a webhook after close or queries account bindings for an invalid token", async () => {
    const values = fixture();
    const composition = createGiftPaymentComposition(configuration(), values);
    await expect(
      composition.ports.asaasWebhook?.receive("short", "{}"),
    ).rejects.toMatchObject({ code: "WEBHOOK_AUTH_DENIED" });
    await composition.close();
    await expect(
      composition.ports.asaasWebhook?.receive("a".repeat(32), "{}"),
    ).rejects.toThrow("Gift payment composition unavailable");
  });

  it("retains ownership of the actual worker run when stop reports failure", async () => {
    const values = fixture();
    values.loop.stop.mockRejectedValueOnce(new Error("private-worker-detail"));
    const composition = createGiftPaymentComposition(configuration(), values);
    composition.start();
    let settled = false;
    const closing = composition.close().catch((error: Error) => {
      settled = true;
      return error;
    });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(settled).toBe(false);
    values.completion.resolve();
    expect(await closing).toMatchObject({
      message: "Gift payment composition unavailable",
    });
  });

  it("rejects incompatible environment configuration before creating dependencies", () => {
    const config = {
      ...configuration(),
      applicationEnvironment: "production",
    } as GiftPaymentConfig;
    expect(() => createGiftPaymentComposition(config, fixture())).toThrow(
      "Gift payment composition unavailable",
    );
  });
  it("uses only the credential bound to the persisted site/account/environment and registered local callbacks", async () => {
    const values = checkoutFixture();
    const composition = createGiftPaymentComposition(values.config, values);
    const checkout = await composition.ports.giftPayments?.createCheckout(
      "site-one",
      values.command,
    );
    expect(checkout?.hostedUrl).toBe(
      "https://sandbox.asaas.com/checkoutSession/show/checkout-one",
    );
    expect(values.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = values.fetch.mock.calls[0];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/checkouts");
    expect(new Headers(init?.headers).get("access_token")).toBe(
      "$aact_hmlg_subaccount-secret",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.callback).toEqual({
      successUrl: "http://localhost:4321/",
      cancelUrl: "http://localhost:4321/",
      expiredUrl: "http://localhost:4321/",
    });
    expect(body.splits).toEqual([
      { walletId: "platform-wallet", fixedValue: 2 },
    ]);
    expect(JSON.stringify(body)).not.toContain(values.config.platformApiKey);
    await composition.close();
  });

  it.each([
    "environment",
    "siteId",
    "accountReference",
    "operatorReference",
    "recipientReference",
  ] as const)(
    "rejects a persisted account with a mismatching %s before provider dispatch",
    async (field) => {
      const values = checkoutFixture();
      values.account[field] = "other";
      const composition = createGiftPaymentComposition(values.config, values);
      await expect(
        composition.ports.giftPayments?.createCheckout(
          "site-one",
          values.command,
        ),
      ).rejects.toThrow();
      expect(values.fetch).not.toHaveBeenCalled();
      await composition.close();
    },
  );

  it("rejects ciphertext copied from a different local account binding", async () => {
    const values = checkoutFixture();
    values.account.id = "another-account";
    const composition = createGiftPaymentComposition(values.config, values);
    await expect(
      composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_UNAVAILABLE" });
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });

  it("rejects unregistered callback origins before provider dispatch", async () => {
    const values = checkoutFixture();
    values.rows[1] = [];
    const composition = createGiftPaymentComposition(values.config, values);
    await expect(
      composition.ports.giftPayments?.createCheckout(
        "site-one",
        values.command,
      ),
    ).rejects.toThrow();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });

  it("drains an in-flight provider request before closing and preserves the caller's credential key", async () => {
    const values = checkoutFixture();
    let respond!: (response: Response) => void;
    values.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const composition = createGiftPaymentComposition(values.config, values);
    const checkout = composition.ports.giftPayments?.createCheckout(
      "site-one",
      values.command,
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(values.fetch).toHaveBeenCalledTimes(1);
    const closing = composition.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    respond(
      new Response(JSON.stringify({ id: "checkout-one" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await checkout;
    await closing;
    expect([...values.config.credentialKeyring.values()][0]).toEqual(
      new Uint8Array(32).fill(1),
    );
  });
});
