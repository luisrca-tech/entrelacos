import { describe, expect, it, vi } from "vitest";
import type { AsaasAccountFeesObservation } from "./asaasHttpClient";
import {
  loadLiveReceivingPricing,
  loadSandboxDemoPricing,
} from "./sandboxDemoPricing";

function fixture() {
  const at = new Date("2026-10-16T16:00:00.000Z");
  const scope = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    accountReference: "account-one",
    recipientReference: "wallet-one",
    environment: "sandbox" as const,
    destinationVersion: 1,
    bankReference: "bank-one",
    method: "PIX" as "PIX" | "CREDIT_CARD",
  };
  const authorization = {
    provider: "ASAAS" as const,
    siteId: scope.siteId,
    accountBindingId: "binding-one",
    accountReference: scope.accountReference,
    environment: "sandbox" as const,
    isDemo: true,
    applicationEnvironment: "development" as
      | "development"
      | "test"
      | "production",
  };
  const observation: AsaasAccountFeesObservation = {
    source: "provider",
    provider: "ASAAS",
    siteId: scope.siteId,
    accountBindingId: authorization.accountBindingId,
    accountReference: scope.accountReference,
    environment: "sandbox",
    currency: "BRL",
    observedAt: at,
    completedAt: at,
    fees: {
      payment: {
        pix: {
          fixedFeeValue: "0.99",
          percentageFee: "0.00",
          minimumFeeValue: "0.00",
          maximumFeeValue: "0.00",
          monthlyCreditsWithoutFee: 0,
          fixedFeeValueWithDiscount: null,
          discountExpiration: null,
        },
        creditCard: {
          operationValue: "0.49",
          oneInstallmentPercentage: "1.99",
          discountOneInstallmentPercentage: null,
          discountExpiration: null,
        },
      },
    },
  };
  return {
    scope,
    authorization,
    observation,
    readAccountFees: vi.fn(async () => observation),
    now: () => at,
  };
}

describe("Sandbox demo pricing from actual account fee observations", () => {
  it("uses observed Pix coefficients as an explicit observed estimate without contractual fee authority", async () => {
    const v = fixture();
    const result = await loadSandboxDemoPricing(v.scope, v.authorization, v);
    expect(v.readAccountFees).toHaveBeenCalledWith({
      provider: "ASAAS",
      siteId: "site-one",
      accountBindingId: "binding-one",
      accountReference: "account-one",
      environment: "sandbox",
    });
    expect(result).toMatchObject({
      provenance: "provider",
      verification: "verified",
      siteId: v.scope.siteId,
      policy: {
        method: "PIX",
        commissionBasisPoints: 200,
        processingFixedCents: 99,
        processingBasisPoints: 0,
        rounding: "CEILING",
        feeAllocation: "RECIPIENT_DEDUCTED",
        feeBasis: "OBSERVED_ESTIMATE",
      },
    });
    expect(result?.policy.version).toMatch(/^sandbox-demo\.[a-f0-9]{64}$/);
    expect(result?.expiresAt?.getTime()).toBe(v.now().getTime() + 300_000);
  });
  it("supports undiscounted one-installment card coefficients without claiming their future applicability", async () => {
    const v = fixture();
    v.scope.method = "CREDIT_CARD";
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      provenance: "provider",
      policy: {
        method: "CREDIT_CARD",
        processingFixedCents: 49,
        processingBasisPoints: 199,
      },
    });
  });
  it.each([
    { isDemo: false },
    { applicationEnvironment: "production" },
    { applicationEnvironment: "test" },
    { siteId: "another" },
    { accountReference: "another" },
    { environment: "live" },
  ])(
    "denies an unauthorized operational scope before reading fees: %j",
    async (change) => {
      const v = fixture();
      Object.assign(v.authorization, change);
      expect(
        await loadSandboxDemoPricing(v.scope, v.authorization, v),
      ).toBeNull();
      expect(v.readAccountFees).not.toHaveBeenCalled();
    },
  );
  it.each([
    { monthlyCreditsWithoutFee: 1 },
    { fixedFeeValueWithDiscount: "0.50" },
    { discountExpiration: "2026-12-01" },
    { minimumFeeValue: "1.00" },
    { maximumFeeValue: "5.00" },
    { percentageFee: undefined },
    { fixedFeeValue: "0.001" },
  ])("fails closed for unsupported Pix tariffs: %j", async (change) => {
    const v = fixture();
    const pix = v.observation.fees.payment?.pix;
    if (!pix) throw new Error("Fixture requires Pix fees");
    Object.assign(pix, change);
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toBeNull();
  });
  it("rejects discounted cards instead of quietly using an advertised regular rate", async () => {
    const v = fixture();
    v.scope.method = "CREDIT_CARD";
    const card = v.observation.fees.payment?.creditCard;
    if (!card) throw new Error("Fixture requires card fees");
    card.discountOneInstallmentPercentage = "0.99";
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toBeNull();
  });
  it.each([
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
  ] as const)("rejects mismatched observed %s", async (field) => {
    const v = fixture();
    Object.assign(v.observation, { [field]: "another" });
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toBeNull();
  });
  it("does not convert transport failure into a default zero tariff", async () => {
    const v = fixture();
    v.readAccountFees.mockRejectedValueOnce(
      new Error("private-provider-secret"),
    );
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toBeNull();
  });
});

function promotedFixture() {
  const values = fixture();
  const pix = values.observation.fees.payment?.pix;
  const card = values.observation.fees.payment?.creditCard;
  if (!pix || !card) throw new Error("Expected fixture tariffs");
  Object.assign(pix, {
    type: "FIXED",
    fixedFeeValue: "1.99",
    fixedFeeValueWithDiscount: "0.99",
    discountExpiration: "2027-01-16 00:00:00",
    percentageFee: null,
    minimumFeeValue: null,
    maximumFeeValue: null,
    monthlyCreditsWithoutFee: 100,
    creditsReceivedOfCurrentMonth: 0,
  });
  Object.assign(card, {
    operationValue: "0.49",
    oneInstallmentPercentage: "2.99",
    discountOneInstallmentPercentage: "1.99",
    hasValidDiscount: true,
    discountExpiration: "2027-01-16 00:00:00",
  });
  return { ...values, pix, card };
}

describe("observed Sandbox promotional estimates", () => {
  it("estimates zero Pix fees while the observed free monthly quota has slots", async () => {
    const v = promotedFixture();
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      provenance: "provider",
      policy: { processingFixedCents: 0, processingBasisPoints: 0 },
    });
  });
  it("uses the observed active fixed promotion after the observed quota is exhausted", async () => {
    const v = promotedFixture();
    v.pix.creditsReceivedOfCurrentMonth = 100;
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      policy: { processingFixedCents: 99, processingBasisPoints: 0 },
    });
  });
  it("uses the base fixed tariff after a known promotion expires", async () => {
    const v = promotedFixture();
    v.pix.creditsReceivedOfCurrentMonth = 100;
    v.pix.discountExpiration = "2026-10-15 00:00:00";
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      policy: { processingFixedCents: 199, processingBasisPoints: 0 },
    });
  });
  it("clips an active promotion policy to its Sao Paulo expiry", async () => {
    const v = promotedFixture();
    v.pix.creditsReceivedOfCurrentMonth = 100;
    v.pix.discountExpiration = "2026-10-16 13:01:00";
    expect(
      (
        await loadSandboxDemoPricing(v.scope, v.authorization, v)
      )?.expiresAt?.toISOString(),
    ).toBe("2026-10-16T16:01:00.000Z");
  });
  it("clips free quota estimates at the next Sao Paulo monthly reset", async () => {
    const v = promotedFixture();
    const at = new Date("2026-11-01T02:59:30.000Z");
    v.now = () => at;
    v.observation.observedAt = at;
    v.observation.completedAt = at;
    expect(
      (
        await loadSandboxDemoPricing(v.scope, v.authorization, v)
      )?.expiresAt?.toISOString(),
    ).toBe("2026-11-01T03:00:00.000Z");
  });
  it("uses the actual card promotion only with its explicit valid flag", async () => {
    const v = promotedFixture();
    v.scope.method = "CREDIT_CARD";
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      provenance: "provider",
      policy: { processingFixedCents: 49, processingBasisPoints: 199 },
    });
  });
  it("uses the base card tariff when the provider explicitly marks its promotion inactive", async () => {
    const v = promotedFixture();
    v.scope.method = "CREDIT_CARD";
    v.card.hasValidDiscount = false;
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      policy: { processingFixedCents: 49, processingBasisPoints: 299 },
    });
  });
  it.each([
    { creditsReceivedOfCurrentMonth: null },
    { creditsReceivedOfCurrentMonth: -1 },
    { creditsReceivedOfCurrentMonth: 0.5 },
    { discountExpiration: "2027-02-30 00:00:00" },
    { discountExpiration: "2027-01-16" },
    { type: "UNKNOWN" },
    { percentageFee: "1.00" },
    { fixedFeeValueWithDiscount: "2.99" },
  ])(
    "rejects incomplete, ambiguous or contradictory Pix observations: %j",
    async (change) => {
      const v = promotedFixture();
      Object.assign(v.pix, change);
      expect(
        await loadSandboxDemoPricing(v.scope, v.authorization, v),
      ).toBeNull();
    },
  );
  it.each([
    { hasValidDiscount: undefined },
    { discountExpiration: null },
    { discountExpiration: "2026-10-15 00:00:00" },
    { discountOneInstallmentPercentage: "3.99" },
  ])(
    "rejects incomplete or contradictory active card promotions: %j",
    async (change) => {
      const v = promotedFixture();
      v.scope.method = "CREDIT_CARD";
      Object.assign(v.card, change);
      expect(
        await loadSandboxDemoPricing(v.scope, v.authorization, v),
      ).toBeNull();
    },
  );
});

describe("live recipient-deducted pricing from bound account observations", () => {
  function liveFixture() {
    const v = fixture();
    return {
      ...v,
      scope: { ...v.scope, environment: "live" as const },
      authorization: {
        ...v.authorization,
        environment: "live" as const,
        isDemo: false,
        applicationEnvironment: "production" as const,
      },
      readAccountFees: vi.fn(async () => ({
        ...v.observation,
        environment: "live" as const,
      })),
    };
  }
  it("uses native live fees for the expressly designated showcase without changing its demo marker", async () => {
    const v = liveFixture();
    const authorization = {
      ...v.authorization,
      isDemo: true,
      liveDemoSiteId: v.scope.siteId,
    };
    expect(
      await loadLiveReceivingPricing(v.scope, authorization, v),
    ).toMatchObject({
      provenance: "provider",
      environment: "live",
      policy: { feeAllocation: "RECIPIENT_DEDUCTED" },
    });
    expect(authorization.isDemo).toBe(true);
  });
  it.each(["PIX", "CREDIT_CARD"] as const)(
    "prices %s from production observations without fabricating a contractual guarantee",
    async (method) => {
      const v = liveFixture();
      const result = await loadLiveReceivingPricing(
        { ...v.scope, method },
        v.authorization,
        v,
      );
      expect(result).toMatchObject({
        environment: "live",
        provenance: "provider",
        verification: "verified",
        policy: {
          method,
          feeAllocation: "RECIPIENT_DEDUCTED",
          feeBasis: "OBSERVED_ESTIMATE",
          commissionBasisPoints: 200,
        },
      });
      expect(result?.policy.version).toMatch(
        /^asaas-live-observed\.[a-f0-9]{64}$/,
      );
      expect(v.readAccountFees).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: "live",
          accountBindingId: "binding-one",
        }),
      );
    },
  );
  it.each([
    { isDemo: true },
    { applicationEnvironment: "development" },
    { applicationEnvironment: "test" },
    { environment: "sandbox" },
    { accountReference: "foreign" },
    { siteId: "foreign" },
  ])(
    "rejects unsupported live authority before reading fees %j",
    async (change) => {
      const v = liveFixture();
      Object.assign(v.authorization, change);
      expect(
        await loadLiveReceivingPricing(v.scope, v.authorization, v),
      ).toBeNull();
      expect(v.readAccountFees).not.toHaveBeenCalled();
    },
  );
  it("rejects sandbox observations for a live receiving account", async () => {
    const v = liveFixture();
    v.readAccountFees.mockResolvedValue({
      ...v.observation,
      environment: "sandbox",
    } as never);
    expect(
      await loadLiveReceivingPricing(v.scope, v.authorization, v),
    ).toBeNull();
  });
});

describe("Sandbox buyer homologation fee evidence", () => {
  it("uses the paid promoted Pix tariff even when an unreserved free quota is reported", async () => {
    const v = fixture();
    Object.assign(v.scope, { feeAllocation: "BUYER_GROSS_UP" });
    Object.assign(v.authorization, { sandboxBuyerGrossUpSiteId: "site-one" });
    const pix = v.observation.fees.payment?.pix;
    if (!pix) throw new Error("Missing fixture tariff");
    Object.assign(pix, {
      type: "FIXED",
      fixedFeeValue: "1.99",
      fixedFeeValueWithDiscount: "0.99",
      discountExpiration: "2027-01-16 00:00:00",
      monthlyCreditsWithoutFee: 100,
      creditsReceivedOfCurrentMonth: 0,
    });
    expect(
      await loadSandboxDemoPricing(v.scope, v.authorization, v),
    ).toMatchObject({
      provenance: "provider",
      policy: {
        feeBasis: "SANDBOX_BUYER_ESTIMATE",
        feeAllocation: "BUYER_GROSS_UP",
        processingFixedCents: 99,
        processingBasisPoints: 0,
      },
    });
  });
  it.each([undefined, "another-site"])(
    "does not grant buyer pricing without exact opt-in %s",
    async (site) => {
      const v = fixture();
      Object.assign(v.scope, { feeAllocation: "BUYER_GROSS_UP" });
      Object.assign(v.authorization, { sandboxBuyerGrossUpSiteId: site });
      expect(
        await loadSandboxDemoPricing(v.scope, v.authorization, v),
      ).toBeNull();
      expect(v.readAccountFees).not.toHaveBeenCalled();
    },
  );
});
