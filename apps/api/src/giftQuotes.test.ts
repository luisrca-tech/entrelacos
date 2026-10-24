import { giftQuoteSchema } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftQuoteService,
  type GiftPricingEvidence,
  type GiftQuoteServiceDependencies,
  type GiftQuoteSnapshot,
  type StoredGiftForQuote,
} from "./giftQuotes";
import type { ReceivingReadinessInput } from "./receivingReadiness";

const instant = "2026-10-12T12:00:00.000Z";
const observedAt = "2026-10-12T11:59:30.000Z";
const policyExpiry = "2026-10-12T12:10:00.000Z";

function fixture() {
  const storedGift: StoredGiftForQuote = {
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Symbolic trip",
      description: "A contribution to our trip",
      nominalCents: 10_000,
      currency: "BRL",
      image: { url: "https://images.example.test/trip.webp", alt: "Our trip" },
      sortOrder: 0,
    },
    publicationState: "PUBLISHED",
    siteActive: true,
  };
  const providerBinding = {
    siteId: "site-one",
    provider: "asaas",
    operatorReference: "operator-private",
    environment: "live" as const,
    accountReference: "account-private",
    recipientReference: "recipient-private",
    destinationVersion: 1,
    bankReference: "bank-private",
  };
  const context: Omit<ReceivingReadinessInput, "siteId" | "now"> = {
    isDemo: false,
    environment: "production",
    mode: "live",
    providerBinding,
    evidence: {
      ...providerBinding,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      observedAt: new Date(observedAt),
      bankObservedAt: new Date(observedAt),
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
    },
    freshnessMs: 60_000,
  };
  const pricing: GiftPricingEvidence = {
    ...providerBinding,
    verification: "verified",
    provenance: "provider",
    observedAt: new Date(observedAt),
    expiresAt: new Date(policyExpiry),
    policy: {
      version: "verified-test-policy-v1",
      method: "PIX",
      commissionBasisPoints: 200,
      processingBasisPoints: 250,
      processingFixedCents: 39,
      rounding: "CEILING",
    },
  };
  const appended: GiftQuoteSnapshot[] = [];
  const dependencies: GiftQuoteServiceDependencies = {
    findPublishedGift: vi.fn(async () => storedGift),
    loadReceivingContext: vi.fn(async () => context),
    loadPricingPolicy: vi.fn(async () => pricing),
    repository: {
      append: vi.fn(async (snapshot) => {
        appended.push(snapshot);
      }),
    },
    now: vi.fn(() => new Date(instant)),
    generateId: vi.fn(() => "quote-one"),
    quoteTtlMs: 300_000,
    pricingFreshnessMs: 60_000,
  };
  return { storedGift, context, pricing, appended, dependencies };
}

const body = { giftId: "gift-one", method: "PIX" };

function makeDemo(fixtureValues: ReturnType<typeof fixture>) {
  const { context, pricing } = fixtureValues;
  context.isDemo = true;
  context.environment = "test";
  context.mode = "sandbox";
  if (context.providerBinding) context.providerBinding.environment = "sandbox";
  if (context.evidence) {
    context.evidence.environment = "sandbox";
    context.evidence.provenance = "simulation";
  }
  pricing.environment = "sandbox";
  pricing.provenance = "local-test";
}

async function expectDenied(
  fixtureValues: ReturnType<typeof fixture>,
  code: string,
) {
  await expect(
    createGiftQuoteService(fixtureValues.dependencies).createQuote(
      "site-one",
      body,
    ),
  ).rejects.toMatchObject({ code });
  expect(fixtureValues.dependencies.repository.append).not.toHaveBeenCalled();
}

describe("immutable gift quote creation", () => {
  it("persists observed-estimate semantics only for recipient-deducted DEV Sandbox demo quotes", async () => {
    const v = fixture();
    makeDemo(v);
    v.context.environment = "development";
    v.pricing.policy.feeBasis = "OBSERVED_ESTIMATE";
    const quote = await createGiftQuoteService(v.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote.feeAllocation).toBe("RECIPIENT_DEDUCTED");
    expect(v.appended[0].pricing.policy.feeBasis).toBe("OBSERVED_ESTIMATE");
    expect(v.pricing.policy.feeAllocation).toBeUndefined();
  });
  it("keeps a real showcase quote provider-bound and exactly nominal under the opt-in", async () => {
    const v = fixture();
    v.context.isDemo = true;
    Object.assign(v.context, { liveDemoSiteId: "site-one" });
    v.pricing.policy.feeBasis = "OBSERVED_ESTIMATE";
    expect(
      await createGiftQuoteService(v.dependencies).createQuote(
        "site-one",
        body,
      ),
    ).toMatchObject({
      mode: "live",
      totalCents: 10000,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    expect(v.context.isDemo).toBe(true);
  });
  it("keeps the exact guest price with live provider-observed recipient deductions", async () => {
    const v = fixture();
    v.pricing.policy.feeBasis = "OBSERVED_ESTIMATE";
    const quote = await createGiftQuoteService(v.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote).toMatchObject({
      nominalCents: 10000,
      totalCents: 10000,
      commissionCents: 200,
      processingCents: 289,
      feeAllocation: "RECIPIENT_DEDUCTED",
      mode: "live",
    });
    expect(v.appended[0].pricing.policy.feeBasis).toBe("OBSERVED_ESTIMATE");
  });
  it("rejects production observed estimates with local-test provenance", async () => {
    const v = fixture();
    v.pricing.policy.feeBasis = "OBSERVED_ESTIMATE";
    v.pricing.provenance = "local-test";
    await expectDenied(v, "POLICY_UNAVAILABLE");
  });

  it("loads stored values and keeps the configured buyer total and snapshots recipient deductions", async () => {
    const { dependencies, appended, storedGift, pricing } = fixture();
    const result = await createGiftQuoteService(dependencies).createQuote(
      "site-one",
      body,
    );
    expect(result).toEqual({
      id: "quote-one",
      giftId: "gift-one",
      siteId: "site-one",
      title: "Symbolic trip",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10_000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 289,
      totalCents: 10_000,
      feeAllocation: "RECIPIENT_DEDUCTED",
      policyVersion: "verified-test-policy-v1",
      expiresAt: "2026-10-12T12:05:00.000Z",
      mode: "live",
    });
    expect(giftQuoteSchema.safeParse(result).success).toBe(true);
    expect(dependencies.findPublishedGift).toHaveBeenCalledWith(
      "site-one",
      "gift-one",
    );
    expect(dependencies.loadPricingPolicy).toHaveBeenCalledWith({
      siteId: "site-one",
      provider: "asaas",
      operatorReference: "operator-private",
      environment: "live",
      accountReference: "account-private",
      recipientReference: "recipient-private",
      destinationVersion: 1,
      bankReference: "bank-private",
      method: "PIX",
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      quote: result,
      gift: storedGift.gift,
      receiving: {
        siteId: "site-one",
        provider: "asaas",
        operatorReference: "operator-private",
        environment: "live",
        accountReference: "account-private",
        recipientReference: "recipient-private",
        destinationVersion: 1,
        bankReference: "bank-private",
      },
      pricing: {
        ...pricing,
        policy: { ...pricing.policy, feeAllocation: "RECIPIENT_DEDUCTED" },
        observedAt,
        expiresAt: policyExpiry,
      },
      createdAt: instant,
      expiresAt: result.expiresAt,
    });
  });

  it.each([
    ["invalid site ID", "site one", body],
    ["cross-site price", "site-one", { ...body, siteId: "site-two" }],
    ["browser price", "site-one", { ...body, nominalCents: 1 }],
    ["browser wallet", "site-one", { ...body, walletId: "attacker-wallet" }],
    ["browser readiness", "site-one", { ...body, state: "READY" }],
    ["browser mode", "site-one", { ...body, mode: "live" }],
    ["browser clock", "site-one", { ...body, now: instant }],
    ["browser expiry", "site-one", { ...body, expiresAt: policyExpiry }],
    ["invalid gift ID", "site-one", { ...body, giftId: " gift-one" }],
    ["unsupported method", "site-one", { ...body, method: "BOLETO" }],
    ["lowercase method", "site-one", { ...body, method: "pix" }],
    ["empty input", "site-one", {}],
    ["null input", "site-one", null],
    ["nonstring site", 7, body],
  ])("rejects %s before lookup or append", async (_, siteId, input) => {
    const { dependencies } = fixture();
    await expect(
      createGiftQuoteService(dependencies).createQuote(siteId, input),
    ).rejects.toMatchObject({ status: 400, code: "QUOTE_INVALID" });
    expect(dependencies.findPublishedGift).not.toHaveBeenCalled();
    expect(dependencies.loadReceivingContext).not.toHaveBeenCalled();
    expect(dependencies.repository.append).not.toHaveBeenCalled();
  });

  it.each([
    ["missing gift", null],
    ["other site", { gift: { siteId: "site-two" } }],
    ["other item", { gift: { id: "gift-two" } }],
    ["draft", { publicationState: "DRAFT" }],
    ["archived", { publicationState: "ARCHIVED" }],
    ["inactive site", { siteActive: false }],
    ["unknown activity", { siteActive: undefined }],
    ["invalid price", { gift: { nominalCents: 0 } }],
    ["wrong currency", { gift: { currency: "USD" } }],
  ])("rejects %s from the authoritative gift lookup", async (_, override) => {
    const values = fixture();
    const stored = override
      ? {
          ...values.storedGift,
          ...override,
          gift: {
            ...values.storedGift.gift,
            ...("gift" in override ? override.gift : {}),
          },
        }
      : null;
    vi.mocked(values.dependencies.findPublishedGift).mockResolvedValue(
      stored as StoredGiftForQuote | null,
    );
    await expectDenied(values, "QUOTE_INVALID");
    expect(values.dependencies.loadReceivingContext).not.toHaveBeenCalled();
  });

  it("denies absent receiving context instead of accepting a READY projection", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.loadReceivingContext).mockResolvedValue(null);
    await expectDenied(values, "RECEIVING_NOT_READY");
    expect(values.dependencies.loadPricingPolicy).not.toHaveBeenCalled();
  });

  it.each(["missing binding", "disabled", "stale bank", "demo live"])(
    "re-evaluates readiness and denies %s",
    async (caseName) => {
      const values = fixture();
      if (caseName === "missing binding") values.context.providerBinding = null;
      if (caseName === "disabled") values.context.mode = "disabled";
      if (caseName === "stale bank" && values.context.evidence) {
        values.context.evidence.bankObservedAt = new Date(
          "2026-10-12T11:58:59.999Z",
        );
      }
      if (caseName === "demo live") values.context.isDemo = true;
      await expectDenied(values, "RECEIVING_NOT_READY");
      expect(values.dependencies.loadPricingPolicy).not.toHaveBeenCalled();
    },
  );

  it("forces the requested site and injected clock over unexpected context fields", async () => {
    const values = fixture();
    Object.assign(values.context, {
      siteId: "site-two",
      now: new Date("2026-10-12T11:00:00.000Z"),
    });
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote.siteId).toBe("site-one");
    expect(quote.expiresAt).toBe("2026-10-12T12:05:00.000Z");
  });

  it("denies missing pricing", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.loadPricingPolicy).mockResolvedValue(null);
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it.each([
    { siteId: "site-two" },
    { provider: "another-provider" },
    { operatorReference: "another-operator" },
    { accountReference: "another-account" },
    { recipientReference: "another-recipient" },
    { environment: "sandbox" },
    { destinationVersion: 2 },
    { bankReference: "another-bank" },
    { verification: "unverified" },
    { provenance: "unknown" },
    { provenance: "local-test" },
  ])("denies mismatched or unverified pricing %o", async (override) => {
    const values = fixture();
    Object.assign(values.pricing, override);
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it("denies a different method's pricing even when account evidence matches", async () => {
    const values = fixture();
    values.pricing.policy.method = "CREDIT_CARD";
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it("accepts verified account-specific provider pricing for one-payment card", async () => {
    const values = fixture();
    Object.assign(values.pricing.policy, {
      method: "CREDIT_CARD",
      processingBasisPoints: 499,
      processingFixedCents: 49,
    });
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      { ...body, method: "CREDIT_CARD" },
    );
    expect(quote).toMatchObject({
      method: "CREDIT_CARD",
      nominalCents: 10_000,
      commissionCents: 200,
      processingCents: 548,
      totalCents: 10_000,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    expect(values.appended[0].pricing.policy.method).toBe("CREDIT_CARD");
  });

  it("permits local-test pricing only for a labeled nonproduction sandbox demo", async () => {
    const values = fixture();
    makeDemo(values);
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote.mode).toBe("sandbox");
    expect(values.appended[0].pricing.provenance).toBe("local-test");
  });

  it("denies local-test pricing on a real sandbox site with provider readiness", async () => {
    const values = fixture();
    makeDemo(values);
    values.context.isDemo = false;
    if (values.context.evidence)
      values.context.evidence.provenance = "provider";
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it("does not use sandbox demo evidence in production", async () => {
    const values = fixture();
    makeDemo(values);
    values.context.environment = "production";
    await expectDenied(values, "RECEIVING_NOT_READY");
  });

  it.each([
    ["missing observation", null, new Date(policyExpiry)],
    ["invalid observation", new Date(Number.NaN), new Date(policyExpiry)],
    [
      "future observation",
      new Date("2026-10-12T12:00:00.001Z"),
      new Date(policyExpiry),
    ],
    [
      "stale observation",
      new Date("2026-10-12T11:58:59.999Z"),
      new Date(policyExpiry),
    ],
    ["missing expiry", new Date(observedAt), null],
    ["invalid expiry", new Date(observedAt), new Date(Number.NaN)],
    ["expired policy", new Date(observedAt), new Date(instant)],
    ["past expiry", new Date(observedAt), new Date("2026-10-12T11:59:59.999Z")],
  ])("denies pricing with %s", async (_, observation, expiry) => {
    const values = fixture();
    values.pricing.observedAt = observation;
    values.pricing.expiresAt = expiry;
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "denies invalid injected pricing freshness %s",
    async (pricingFreshnessMs) => {
      const values = fixture();
      values.dependencies.pricingFreshnessMs = pricingFreshnessMs;
      await expectDenied(values, "POLICY_UNAVAILABLE");
    },
  );

  it("allows observation exactly at the injected freshness boundary", async () => {
    const values = fixture();
    values.pricing.observedAt = new Date("2026-10-12T11:59:00.000Z");
    await expect(
      createGiftQuoteService(values.dependencies).createQuote("site-one", body),
    ).resolves.toMatchObject({ id: "quote-one" });
  });

  it("caps quote expiry at the pricing expiry", async () => {
    const values = fixture();
    values.pricing.expiresAt = new Date("2026-10-12T12:00:20.000Z");
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote.expiresAt).toBe("2026-10-12T12:00:20.000Z");
    expect(values.appended[0].expiresAt).toBe(quote.expiresAt);
  });

  it.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid injected quote TTL %s", async (quoteTtlMs) => {
    const values = fixture();
    values.dependencies.quoteTtlMs = quoteTtlMs;
    await expectDenied(values, "QUOTE_INVALID");
  });

  it("rejects an invalid injected clock", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.now).mockReturnValue(new Date(Number.NaN));
    await expectDenied(values, "QUOTE_INVALID");
  });

  it("rejects an invalid generated ID before appending", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.generateId).mockReturnValue("quote one");
    await expectDenied(values, "QUOTE_INVALID");
  });

  it("detaches and freezes the full snapshot while returning only public fields", async () => {
    const values = fixture();
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    const snapshot = values.appended[0];
    const original = structuredClone(snapshot);
    values.storedGift.gift.title = "Edited gift";
    values.storedGift.gift.nominalCents = 1;
    if (values.storedGift.gift.image)
      values.storedGift.gift.image.alt = "Edited";
    values.pricing.policy.processingBasisPoints = 9_000;
    values.pricing.observedAt?.setTime(0);
    if (values.context.providerBinding) {
      values.context.providerBinding.accountReference = "replacement-account";
      values.context.providerBinding.destinationVersion = 2;
    }
    quote.title = "Edited response";
    quote.nominalCents = 1;
    expect(snapshot).toEqual(original);
    for (const value of [
      snapshot,
      snapshot.quote,
      snapshot.gift,
      snapshot.gift.image,
      snapshot.receiving,
      snapshot.pricing,
      snapshot.pricing.policy,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      snapshot.pricing.policy.processingFixedCents = 999;
    }).toThrow(TypeError);
    const responseText = JSON.stringify(quote);
    for (const privateValue of [
      "operator-private",
      "account-private",
      "recipient-private",
      "bank-private",
      "destinationVersion",
      "provenance",
    ]) {
      expect(responseText).not.toContain(privateValue);
    }
  });

  it("propagates append failure without returning a created quote", async () => {
    const values = fixture();
    const error = new Error("Storage unavailable");
    vi.mocked(values.dependencies.repository.append).mockRejectedValue(error);
    await expect(
      createGiftQuoteService(values.dependencies).createQuote("site-one", body),
    ).rejects.toBe(error);
    expect(values.dependencies.repository.append).toHaveBeenCalledTimes(1);
    expect(values.appended).toHaveLength(0);
  });

  it("does not persist incidental credentials or payer details from internal loaders", async () => {
    const values = fixture();
    Object.assign(values.context.providerBinding ?? {}, {
      apiKey: "secret-key",
      payerEmail: "private-payer@example.test",
    });
    Object.assign(values.pricing, {
      apiKey: "secret-key",
      payerEmail: "private-payer@example.test",
    });
    Object.assign(values.pricing.policy, { secret: "policy-secret" });
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    for (const payload of [quote, values.appended[0]]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain("secret-key");
      expect(text).not.toContain("private-payer@example.test");
      expect(text).not.toContain("policy-secret");
    }
  });

  it("detaches gift and receiving data before invoking later loaders", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.loadReceivingContext).mockImplementation(
      async () => {
        values.storedGift.gift.title = "Changed after lookup";
        values.storedGift.gift.nominalCents = 1;
        return values.context;
      },
    );
    vi.mocked(values.dependencies.loadPricingPolicy).mockImplementation(
      async () => {
        if (values.context.providerBinding) {
          values.context.providerBinding.accountReference =
            "replacement-account";
        }
        return values.pricing;
      },
    );
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote).toMatchObject({
      title: "Symbolic trip",
      nominalCents: 10_000,
    });
    expect(values.appended[0].receiving.accountReference).toBe(
      "account-private",
    );
  });

  it("denies readiness that became stale while awaiting pricing", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.now)
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValue(new Date("2026-10-12T12:00:30.001Z"));
    await expectDenied(values, "RECEIVING_NOT_READY");
    expect(values.dependencies.loadPricingPolicy).toHaveBeenCalledOnce();
  });

  it("accepts evidence observed after asynchronous context loading began", async () => {
    const values = fixture();
    if (values.context.evidence) {
      values.context.evidence.observedAt = new Date("2026-10-12T12:00:00.005Z");
      values.context.evidence.bankObservedAt = new Date(
        "2026-10-12T12:00:00.005Z",
      );
    }
    vi.mocked(values.dependencies.now)
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValue(new Date("2026-10-12T12:00:00.010Z"));
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(quote.nominalCents).toBe(10000);
    expect(values.appended).toHaveLength(1);
  });

  it("denies fees that expired while awaiting pricing", async () => {
    const values = fixture();
    values.pricing.expiresAt = new Date("2026-10-12T12:00:20.000Z");
    vi.mocked(values.dependencies.now)
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValue(new Date("2026-10-12T12:00:30.000Z"));
    await expectDenied(values, "POLICY_UNAVAILABLE");
  });

  it("dates the immutable quote at final validation after loading fees", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.now)
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValue(new Date("2026-10-12T12:00:20.000Z"));
    const quote = await createGiftQuoteService(values.dependencies).createQuote(
      "site-one",
      body,
    );
    expect(values.appended[0].createdAt).toBe("2026-10-12T12:00:20.000Z");
    expect(quote.expiresAt).toBe("2026-10-12T12:05:20.000Z");
  });
});
