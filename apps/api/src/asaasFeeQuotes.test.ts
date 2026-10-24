import { describe, expect, it, vi } from "vitest";
import {
  type AsaasFeeQuotesOptions,
  type AsaasTrustedFeeProfile,
  createAsaasFeeQuotes,
} from "./asaasFeeQuotes";
import type { AsaasAccountFeesObservation } from "./asaasHttpClient";
import { quoteGiftAmounts } from "./giftMoney";
import type { GiftQuoteServiceDependencies } from "./giftQuotes";
import {
  type WithdrawalFeeScope,
  type WithdrawalReservationOptions,
  WithdrawalReservationServiceError,
} from "./withdrawalReservations";

const instant = new Date("2026-10-14T03:00:00.000Z");
const processing = {
  provider: "ASAAS",
  siteId: "site:one",
  operatorReference: "operator_one",
  accountReference: "remote_account_one",
  recipientReference: "recipient_one",
  environment: "sandbox" as const,
  destinationVersion: 3,
  bankReference: "bank_one",
  method: "CREDIT_CARD" as const,
};
const withdrawal: WithdrawalFeeScope = {
  siteId: "site:one",
  accountId: "account.one",
  accountReference: "remote_account_one",
  environment: "sandbox",
  bankReference: "bank_one",
  destinationVersion: 3,
  amountCents: 10000,
  currency: "BRL",
};

function fixture(purpose: "processing" | "withdrawal" = "processing") {
  const scope = structuredClone(
    purpose === "processing" ? processing : withdrawal,
  );
  const binding = {
    provider: "ASAAS" as const,
    siteId: "site:one",
    accountBindingId: "account.one",
    accountReference: "remote_account_one",
    environment: "sandbox" as const,
  };
  let profile: AsaasTrustedFeeProfile | null = {
    verification: "verified",
    request:
      purpose === "processing"
        ? { purpose, scope: structuredClone(processing) }
        : { purpose, scope: structuredClone(withdrawal) },
    binding,
    operatorReference: "operator_one",
    recipientReference: "recipient_one",
    holderReference: "holder_one",
    holderConsentReference: "consent_one",
    holderAuthority: "VERIFIED_ORIGINAL_ACCOUNT_HOLDER_CONSENT",
    authorityReference: "authority.one",
    authorityVersion: "version.one",
    validFrom: new Date(instant.getTime() - 1000),
    validUntil: new Date(instant.getTime() + 3600000),
    applicability: "GUARANTEED_FUTURE_OPERATION",
    applicableCharges: "COMPLETE",
    promotion: "NONE",
    quota: "INAPPLICABLE",
    terms:
      purpose === "processing"
        ? {
            kind: "processing",
            method: "CREDIT_CARD",
            model: "AFFINE",
            base: "CHARGED_GROSS",
            rounding: "CEILING",
            clamp: "NONE",
            cardCharge: "DETACHED_ONE_INSTALLMENT",
          }
        : {
            kind: "withdrawal",
            rail: "TED",
            route: "EXTERNAL_BANK",
            model: "FIXED",
            debit: "GROSS_AMOUNT_INCLUDES_FEE",
            rounding: "CEILING",
          },
  };
  const clock = { time: instant.getTime() };
  const observation: AsaasAccountFeesObservation = {
    source: "provider",
    ...binding,
    currency: "BRL",
    observedAt: new Date(instant),
    completedAt: new Date(instant),
    fees: {
      payment: {
        creditCard: {
          operationValue: "0.49",
          oneInstallmentPercentage: "2.99",
        },
        pix: {
          fixedFeeValue: "0.39",
          percentageFee: "0.00",
          minimumFeeValue: "0.00",
          maximumFeeValue: "0.00",
          monthlyCreditsWithoutFee: 0,
        },
      },
      transfer: {
        monthlyTransfersWithoutFee: 30,
        ted: {
          feeValue: "5.00",
          consideredInMonthlyTransfersWithoutFee: false,
        },
        pix: {
          feeValue: "1.99",
          consideredInMonthlyTransfersWithoutFee: false,
        },
      },
    },
  };
  const resolveFeeProfile = vi.fn<AsaasFeeQuotesOptions["resolveFeeProfile"]>(
    async () => profile,
  );
  const readAccountFees = vi.fn<AsaasFeeQuotesOptions["readAccountFees"]>(
    async () => {
      observation.observedAt = new Date(clock.time);
      observation.completedAt = new Date(clock.time);
      return observation;
    },
  );
  const options: AsaasFeeQuotesOptions = {
    resolveFeeProfile,
    readAccountFees,
    now: () => new Date(clock.time),
    pricingFreshnessMs: 60000,
    withdrawalFreshnessMs: 300000,
  };
  return {
    adapter: createAsaasFeeQuotes(options),
    options,
    scope,
    clock,
    observation,
    readAccountFees,
    resolveFeeProfile,
    get profile() {
      return profile;
    },
    set profile(value) {
      profile = value;
    },
  };
}

async function unavailable(action: Promise<unknown>) {
  const error = await action.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WithdrawalReservationServiceError);
  expect(error).toMatchObject({ status: 409, code: "FEE_QUOTE_UNAVAILABLE" });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain("private");
}

describe("independently authorized exact fee quotes", () => {
  it("fits frozen pricing and withdrawal ports and reuses gross CEILING arithmetic with the nominal 2% proposal", async () => {
    const values = fixture();
    const load: GiftQuoteServiceDependencies["loadPricingPolicy"] =
      values.adapter.loadPricingPolicy;
    type Enabled = Exclude<WithdrawalReservationOptions, { mode: "disabled" }>;
    const port: Enabled["feeQuotes"] = values.adapter;
    expect(typeof port.quoteWithdrawal).toBe("function");
    const result = await load(processing);
    const { method: _method, ...binding } = processing;
    expect(result).toMatchObject({
      ...binding,
      verification: "verified",
      provenance: "provider",
      observedAt: instant,
      expiresAt: new Date(instant.getTime() + 60000),
      policy: {
        method: "CREDIT_CARD",
        commissionBasisPoints: 200,
        processingFixedCents: 49,
        processingBasisPoints: 299,
        rounding: "CEILING",
      },
    });
    expect(result).not.toHaveProperty("method");
    const amounts = quoteGiftAmounts({
      nominalCents: 10000,
      method: "CREDIT_CARD",
      policy: result?.policy ?? null,
    });
    expect(amounts).toMatchObject({
      nominalCents: 10000,
      commissionCents: 200,
      processingCents: 365,
      totalCents: 10565,
    });
    expect(values.readAccountFees.mock.calls[0][0]).toEqual(
      values.profile?.binding,
    );
  });

  it.each(["TED", "PIX"] as const)(
    "quotes only proved fixed external-bank %s and preserves the original gross scope",
    async (rail) => {
      const values = fixture("withdrawal");
      if (values.profile?.terms.kind !== "withdrawal")
        throw new Error("Invalid fixture");
      values.profile.terms.rail = rail;
      const result = await values.adapter.quoteWithdrawal(withdrawal);
      expect(result).toMatchObject({
        ...withdrawal,
        feeCents: rail === "TED" ? 500 : 199,
        verification: "verified",
        provenance: "provider",
        observedAt: instant,
        expiresAt: new Date(instant.getTime() + 300000),
      });
    },
  );

  it("accepts explicit zero only with complete independent applicability authority", async () => {
    const values = fixture("withdrawal");
    if (!values.observation.fees.transfer?.ted)
      throw new Error("Invalid fixture");
    values.observation.fees.transfer.ted.feeValue = "0.00";
    expect((await values.adapter.quoteWithdrawal(withdrawal)).feeCents).toBe(0);
    values.profile = null;
    await unavailable(values.adapter.quoteWithdrawal(withdrawal));
  });

  it.each([
    "absent",
    "unverified",
    "expired",
    "future",
    "quota",
    "promotion",
    "incomplete",
  ] as const)("denies %s profiles before dispatch", async (failure) => {
    for (const purpose of ["processing", "withdrawal"] as const) {
      const values = fixture(purpose);
      if (!values.profile) throw new Error("Invalid fixture");
      if (failure === "absent") values.profile = null;
      else if (failure === "unverified")
        Object.assign(values.profile, { verification: "unverified" });
      else if (failure === "expired")
        values.profile.validUntil = new Date(instant);
      else if (failure === "future")
        values.profile.validFrom = new Date(instant.getTime() + 1);
      else if (failure === "quota")
        Object.assign(values.profile, { quota: "UNRESERVED" });
      else if (failure === "promotion")
        Object.assign(values.profile, { promotion: "UNKNOWN_TIMEZONE" });
      else Object.assign(values.profile, { applicableCharges: "UNKNOWN" });
      if (purpose === "processing")
        expect(await values.adapter.loadPricingPolicy(processing)).toBeNull();
      else await unavailable(values.adapter.quoteWithdrawal(withdrawal));
      expect(values.readAccountFees).not.toHaveBeenCalled();
    }
  });

  it.each([
    "binding",
    "request",
    "method",
    "base",
    "rounding",
    "clamp",
    "cardCharge",
    "authority",
  ] as const)(
    "rejects unsupported processing authority %s",
    async (failure) => {
      const values = fixture();
      if (values.profile?.terms.kind !== "processing")
        throw new Error("Invalid fixture");
      if (failure === "binding")
        values.profile.binding.accountReference = "replacement_account";
      else if (failure === "request")
        values.profile.request.scope.bankReference = "replacement_bank";
      else if (failure === "authority") values.profile.authorityReference = "";
      else
        Object.assign(values.profile.terms, {
          [failure]: failure === "method" ? "PIX" : "UNSUPPORTED",
        });
      expect(await values.adapter.loadPricingPolicy(processing)).toBeNull();
      expect(values.readAccountFees).not.toHaveBeenCalled();
    },
  );

  it.each(["account", "rail", "route", "model", "debit"] as const)(
    "rejects unsupported withdrawal authority %s",
    async (failure) => {
      const values = fixture("withdrawal");
      if (values.profile?.terms.kind !== "withdrawal")
        throw new Error("Invalid fixture");
      if (failure === "account")
        values.profile.binding.accountBindingId = "replacement.account";
      else Object.assign(values.profile.terms, { [failure]: "UNSUPPORTED" });
      await unavailable(values.adapter.quoteWithdrawal(withdrawal));
      expect(values.readAccountFees).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "0.001", "100.00", "1e-2", "0.49000000000000001"])(
    "does not zero or round invalid applicable processing components %s",
    async (component) => {
      const values = fixture();
      if (!values.observation.fees.payment?.creditCard)
        throw new Error("Invalid fixture");
      Object.assign(values.observation.fees.payment.creditCard, {
        oneInstallmentPercentage: component,
      });
      expect(await values.adapter.loadPricingPolicy(processing)).toBeNull();
    },
  );

  it.each([undefined, null, "0.001", "21474836.48", "100.00"])(
    "does not zero or round invalid fixed withdrawal components %s",
    async (component) => {
      const values = fixture("withdrawal");
      if (!values.observation.fees.transfer?.ted)
        throw new Error("Invalid fixture");
      Object.assign(values.observation.fees.transfer.ted, {
        feeValue: component,
      });
      await unavailable(values.adapter.quoteWithdrawal(withdrawal));
    },
  );

  it.each([
    "minimum",
    "maximum",
    "quota",
    "promotion",
    "unknownQuota",
  ] as const)(
    "refuses native PIX %s ambiguity under the affine port",
    async (failure) => {
      const values = fixture();
      if (
        values.profile?.terms.kind !== "processing" ||
        values.profile.request.purpose !== "processing" ||
        !values.observation.fees.payment?.pix
      )
        throw new Error("Invalid fixture");
      values.profile.request.scope.method = "PIX";
      values.profile.terms.method = "PIX";
      values.profile.terms.cardCharge = "NOT_APPLICABLE";
      if (failure === "minimum")
        values.observation.fees.payment.pix.minimumFeeValue = "0.29";
      if (failure === "maximum")
        values.observation.fees.payment.pix.maximumFeeValue = "1.99";
      if (failure === "quota")
        values.observation.fees.payment.pix.monthlyCreditsWithoutFee = 30;
      if (failure === "unknownQuota")
        delete values.observation.fees.payment.pix.monthlyCreditsWithoutFee;
      if (failure === "promotion")
        values.observation.fees.payment.pix.discountExpiration =
          "2019-05-19 00:00:00";
      expect(
        await values.adapter.loadPricingPolicy({
          ...processing,
          method: "PIX",
        }),
      ).toBeNull();
    },
  );

  it("supports explicit unclamped PIX affine data without free-quota inference", async () => {
    const values = fixture();
    if (
      values.profile?.terms.kind !== "processing" ||
      values.profile.request.purpose !== "processing"
    )
      throw new Error("Invalid fixture");
    values.profile.request.scope.method = "PIX";
    values.profile.terms.method = "PIX";
    values.profile.terms.cardCharge = "NOT_APPLICABLE";
    expect(
      (await values.adapter.loadPricingPolicy({ ...processing, method: "PIX" }))
        ?.policy,
    ).toMatchObject({ processingFixedCents: 39, processingBasisPoints: 0 });
  });

  it.each([
    "freeQuota",
    "unknownQuota",
    "promotion",
    "omittedRail",
    "foreignObservation",
  ] as const)(
    "refuses withdrawal %s instead of claiming a free or ready quote",
    async (failure) => {
      const values = fixture("withdrawal");
      if (
        values.profile?.terms.kind !== "withdrawal" ||
        !values.observation.fees.transfer?.pix
      )
        throw new Error("Invalid fixture");
      values.profile.terms.rail = "PIX";
      if (failure === "freeQuota")
        values.observation.fees.transfer.pix.consideredInMonthlyTransfersWithoutFee = true;
      if (failure === "unknownQuota")
        delete values.observation.fees.transfer.pix
          .consideredInMonthlyTransfersWithoutFee;
      if (failure === "promotion")
        Object.assign(values.observation.fees.transfer.pix, {
          discountValue: "0.00",
          expirationDate: "2026-12-01 00:00:00",
        });
      if (failure === "omittedRail")
        delete values.observation.fees.transfer.pix;
      if (failure === "foreignObservation")
        values.observation.accountBindingId = "other.account";
      await unavailable(values.adapter.quoteWithdrawal(withdrawal));
    },
  );

  it("copies requested scope before resolver await and trusted profile before fee await", async () => {
    const values = fixture();
    const request = { ...processing };
    let release!: (value: AsaasAccountFeesObservation) => void;
    values.readAccountFees.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const action = values.adapter.loadPricingPolicy(request);
    request.accountReference = "replacement_account";
    await Promise.resolve();
    if (!values.profile) throw new Error("Invalid fixture");
    values.profile.binding.accountReference = "replacement_profile";
    values.profile.authorityVersion = "replacement.version";
    release(values.observation);
    expect(await action).toMatchObject({
      accountReference: "remote_account_one",
    });
    expect(values.readAccountFees.mock.calls[0][0].accountReference).toBe(
      "remote_account_one",
    );
  });

  it("records the earliest pre-GET bound and real authority expiry without freshening late completion", async () => {
    const values = fixture();
    values.resolveFeeProfile.mockImplementationOnce(async () => {
      values.clock.time += 10;
      return values.profile;
    });
    if (!values.profile) throw new Error("Invalid fixture");
    values.profile.validUntil = new Date(instant.getTime() + 100);
    values.readAccountFees.mockImplementationOnce(async () => {
      values.clock.time += 20;
      values.observation.observedAt = new Date(instant.getTime() + 15);
      values.observation.completedAt = new Date(values.clock.time);
      return values.observation;
    });
    expect(await values.adapter.loadPricingPolicy(processing)).toMatchObject({
      observedAt: new Date(instant.getTime() + 10),
      expiresAt: new Date(instant.getTime() + 100),
    });
  });

  it.each([
    "resolverBackwards",
    "readerBackwards",
    "expired",
    "stale",
    "futureObservation",
    "completionBackwards",
  ] as const)("fails closed after asynchronous %s", async (failure) => {
    const values = fixture();
    if (failure === "resolverBackwards")
      values.resolveFeeProfile.mockImplementationOnce(async () => {
        values.clock.time--;
        return values.profile;
      });
    else
      values.readAccountFees.mockImplementationOnce(async () => {
        if (failure === "readerBackwards") values.clock.time--;
        if (failure === "expired") values.clock.time += 3600000;
        if (failure === "stale") values.clock.time += 60001;
        if (failure === "futureObservation")
          values.observation.observedAt = new Date(values.clock.time + 1);
        values.observation.completedAt = new Date(
          failure === "completionBackwards"
            ? values.clock.time - 1
            : values.clock.time,
        );
        return values.observation;
      });
    expect(await values.adapter.loadPricingPolicy(processing)).toBeNull();
  });

  it("keeps identity stable across samples but changes it for actual authority, scope or effective fee changes without rewriting originals", async () => {
    const values = fixture();
    const original = await values.adapter.loadPricingPolicy(processing);
    expect(original).not.toBeNull();
    const saved = structuredClone(original);
    values.clock.time += 1000;
    const sampled = await values.adapter.loadPricingPolicy(processing);
    expect(sampled?.policy.version).toBe(original?.policy.version);
    expect(sampled?.expiresAt).not.toEqual(original?.expiresAt);
    if (!values.profile || !values.observation.fees.payment?.creditCard)
      throw new Error("Invalid fixture");
    values.profile.authorityVersion = "version.two";
    const renewed = await values.adapter.loadPricingPolicy(processing);
    expect(renewed?.policy.version).not.toBe(original?.policy.version);
    values.observation.fees.payment.creditCard.operationValue = "0.50";
    const repriced = await values.adapter.loadPricingPolicy(processing);
    expect(repriced?.policy.version).not.toBe(renewed?.policy.version);
    expect(original).toEqual(saved);
    expect(original?.policy.version.length).toBeLessThanOrEqual(128);
  });

  it("keeps withdrawal consent identity stable across fresh reads and preserves the old evidence on real term changes", async () => {
    const values = fixture("withdrawal");
    const original = await values.adapter.quoteWithdrawal(withdrawal);
    const saved = structuredClone(original);
    values.clock.time += 1000;
    expect(
      (await values.adapter.quoteWithdrawal(withdrawal)).policyVersion,
    ).toBe(original.policyVersion);
    if (!values.observation.fees.transfer?.ted)
      throw new Error("Invalid fixture");
    values.observation.fees.transfer.ted.feeValue = "5.01";
    const changed = await values.adapter.quoteWithdrawal(withdrawal);
    expect(changed.policyVersion).not.toBe(original.policyVersion);
    expect(original).toEqual(saved);
  });

  it("sanitizes resolver/native faults and captures original callable configuration", async () => {
    const values = fixture("withdrawal");
    values.options.resolveFeeProfile = vi.fn();
    values.options.readAccountFees = vi.fn();
    values.options.now = () => new Date(Number.NaN);
    values.resolveFeeProfile.mockRejectedValueOnce(
      new Error("private authority"),
    );
    await unavailable(values.adapter.quoteWithdrawal(withdrawal));
    values.readAccountFees.mockRejectedValueOnce(new Error("private native"));
    await unavailable(values.adapter.quoteWithdrawal(withdrawal));
    expect(values.readAccountFees).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pricingFreshnessMs: 0 },
    { withdrawalFreshnessMs: 300001 },
    { withdrawalFreshnessMs: 0 },
    { resolveFeeProfile: null },
    { readAccountFees: null },
    { now: null },
  ])("rejects invalid required configuration %j", (change) => {
    const values = fixture();
    expect(() =>
      createAsaasFeeQuotes({
        ...values.options,
        ...change,
      } as AsaasFeeQuotesOptions),
    ).toThrow(WithdrawalReservationServiceError);
  });

  it.each([null, undefined])(
    "sanitizes a missing required adapter configuration %s",
    (options) => {
      expect(() =>
        createAsaasFeeQuotes(options as unknown as AsaasFeeQuotesOptions),
      ).toThrow(WithdrawalReservationServiceError);
    },
  );

  it.each([
    "bankReference",
    "accountReference",
    "operatorReference",
    "recipientReference",
    "siteId",
  ] as const)(
    "rejects a noncanonical original scope field %s before authority dispatch",
    async (field) => {
      const values = fixture();
      const scope = { ...processing, [field]: `${processing[field]}\n` };
      if (values.profile?.request.purpose !== "processing")
        throw new Error("Invalid fixture");
      Object.assign(values.profile.request.scope, scope);
      if (field === "siteId" || field === "accountReference")
        Object.assign(values.profile.binding, { [field]: scope[field] });
      if (field === "operatorReference" || field === "recipientReference")
        Object.assign(values.profile, { [field]: scope[field] });
      expect(await values.adapter.loadPricingPolicy(scope)).toBeNull();
      expect(values.resolveFeeProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    "holderReference",
    "holderConsentReference",
    "holderAuthority",
  ] as const)(
    "requires independently supplied original holder authority %s",
    async (field) => {
      const values = fixture();
      if (!values.profile) throw new Error("Invalid fixture");
      Object.assign(values.profile, {
        [field]: field === "holderAuthority" ? "SITE_ADMIN" : "",
      });
      expect(await values.adapter.loadPricingPolicy(processing)).toBeNull();
      expect(values.readAccountFees).not.toHaveBeenCalled();
    },
  );

  it("copies withdrawal scope before the first await and refuses late evidence", async () => {
    const values = fixture("withdrawal");
    const scope = { ...withdrawal };
    const action = values.adapter.quoteWithdrawal(scope);
    scope.amountCents = 1;
    scope.accountId = "replacement.account";
    expect(await action).toMatchObject(withdrawal);
    values.readAccountFees.mockImplementationOnce(async () => {
      values.clock.time += 300000;
      values.observation.observedAt = new Date(instant);
      values.observation.completedAt = new Date(values.clock.time);
      return values.observation;
    });
    await unavailable(values.adapter.quoteWithdrawal(withdrawal));
  });

  it("changes identity for actual holder consent, authority validity and original destination changes", async () => {
    const values = fixture();
    const original = await values.adapter.loadPricingPolicy(processing);
    if (values.profile?.request.purpose !== "processing")
      throw new Error("Invalid fixture");
    values.profile.holderConsentReference = "consent_two";
    const holderChanged = await values.adapter.loadPricingPolicy(processing);
    expect(holderChanged?.policy.version).not.toBe(original?.policy.version);
    values.profile.validUntil = new Date(instant.getTime() + 7200000);
    const validityChanged = await values.adapter.loadPricingPolicy(processing);
    expect(validityChanged?.policy.version).not.toBe(
      holderChanged?.policy.version,
    );
    values.profile.request.scope.destinationVersion = 4;
    const destinationChanged = await values.adapter.loadPricingPolicy({
      ...processing,
      destinationVersion: 4,
    });
    expect(destinationChanged?.policy.version).not.toBe(
      validityChanged?.policy.version,
    );
    expect(original?.destinationVersion).toBe(3);
  });
});
