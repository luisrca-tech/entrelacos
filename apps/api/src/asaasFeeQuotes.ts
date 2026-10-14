import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { giftCentsSchema, giftQuoteSchema } from "@entrelacos/contracts";
import type { AsaasAccountFeesObservation } from "./asaasHttpClient";
import type { FinancialAccountBinding } from "./financialOverview";
import { parseBrlCents } from "./giftMoney";
import type { GiftQuoteServiceDependencies } from "./giftQuotes";
import {
  type WithdrawalFeeQuote,
  type WithdrawalFeeScope,
  WithdrawalReservationServiceError,
} from "./withdrawalReservations";

export type AsaasFeeProfileRequest =
  | {
      purpose: "processing";
      scope: Parameters<GiftQuoteServiceDependencies["loadPricingPolicy"]>[0];
    }
  | { purpose: "withdrawal"; scope: WithdrawalFeeScope };

// Only an independent private authority can supply this guarantee for the original operation.
export interface AsaasTrustedFeeProfile {
  verification: "verified";
  request: AsaasFeeProfileRequest;
  binding: FinancialAccountBinding;
  operatorReference: string;
  recipientReference: string;
  holderReference: string;
  holderConsentReference: string;
  holderAuthority: "VERIFIED_ORIGINAL_ACCOUNT_HOLDER_CONSENT";
  authorityReference: string;
  authorityVersion: string;
  validFrom: Date;
  validUntil: Date;
  applicability: "GUARANTEED_FUTURE_OPERATION";
  applicableCharges: "COMPLETE";
  promotion: "NONE";
  quota: "INAPPLICABLE";
  terms:
    | {
        kind: "processing";
        method: "PIX" | "CREDIT_CARD";
        model: "AFFINE";
        base: "CHARGED_GROSS";
        rounding: "CEILING";
        clamp: "NONE";
        cardCharge: "NOT_APPLICABLE" | "DETACHED_ONE_INSTALLMENT";
      }
    | {
        kind: "withdrawal";
        rail: "PIX" | "TED";
        route: "EXTERNAL_BANK";
        model: "FIXED";
        debit: "GROSS_AMOUNT_INCLUDES_FEE";
        rounding: "CEILING";
      };
}

export interface AsaasFeeQuotesOptions {
  readAccountFees(
    binding: FinancialAccountBinding,
  ): Promise<AsaasAccountFeesObservation>;
  resolveFeeProfile(
    request: AsaasFeeProfileRequest,
  ): Promise<AsaasTrustedFeeProfile | null>;
  now(): Date;
  pricingFreshnessMs: number;
  withdrawalFreshnessMs: number;
}

function unavailable(): never {
  throw new WithdrawalReservationServiceError(409, "FEE_QUOTE_UNAVAILABLE");
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return unavailable();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  const result = giftQuoteSchema.shape.siteId.safeParse(value);
  if (!result.success) return unavailable();
  return result.data;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}

function time(value: unknown): number {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    return unavailable();
  return value.getTime();
}

function feeCents(value: unknown): number {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)
  )
    return unavailable();
  return parseBrlCents(value);
}

function request(
  purpose: AsaasFeeProfileRequest["purpose"],
  value: unknown,
): AsaasFeeProfileRequest {
  const scope = exact(
    structuredClone(value),
    purpose === "processing"
      ? [
          "provider",
          "siteId",
          "operatorReference",
          "accountReference",
          "recipientReference",
          "environment",
          "destinationVersion",
          "bankReference",
          "method",
        ]
      : [
          "siteId",
          "accountId",
          "accountReference",
          "environment",
          "bankReference",
          "destinationVersion",
          "amountCents",
          "currency",
        ],
  );
  id(scope.siteId);
  reference(scope.accountReference);
  reference(scope.bankReference);
  if (
    !["sandbox", "live"].includes(String(scope.environment)) ||
    !Number.isSafeInteger(scope.destinationVersion) ||
    (scope.destinationVersion as number) < 1
  )
    return unavailable();
  if (purpose === "processing") {
    reference(scope.operatorReference);
    reference(scope.recipientReference);
    if (
      scope.provider !== "ASAAS" ||
      !["PIX", "CREDIT_CARD"].includes(String(scope.method))
    )
      return unavailable();
  } else {
    id(scope.accountId);
    if (
      scope.currency !== "BRL" ||
      !giftCentsSchema.safeParse(scope.amountCents).success ||
      scope.amountCents === 0
    )
      return unavailable();
  }
  return { purpose, scope } as unknown as AsaasFeeProfileRequest;
}

function trustedProfile(
  value: unknown,
  original: AsaasFeeProfileRequest,
  now: number,
): AsaasTrustedFeeProfile {
  const profile = exact(structuredClone(value), [
    "verification",
    "request",
    "binding",
    "operatorReference",
    "recipientReference",
    "holderReference",
    "holderConsentReference",
    "holderAuthority",
    "authorityReference",
    "authorityVersion",
    "validFrom",
    "validUntil",
    "applicability",
    "applicableCharges",
    "promotion",
    "quota",
    "terms",
  ]);
  exact(profile.request, ["purpose", "scope"]);
  const binding = exact(profile.binding, [
    "provider",
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
  ]);
  id(binding.accountBindingId);
  id(profile.authorityReference);
  id(profile.authorityVersion);
  reference(profile.operatorReference);
  reference(profile.recipientReference);
  reference(profile.holderReference);
  reference(profile.holderConsentReference);
  if (
    profile.verification !== "verified" ||
    !isDeepStrictEqual(profile.request, original) ||
    binding.provider !== "ASAAS" ||
    binding.siteId !== original.scope.siteId ||
    binding.accountReference !== original.scope.accountReference ||
    binding.environment !== original.scope.environment ||
    profile.holderAuthority !== "VERIFIED_ORIGINAL_ACCOUNT_HOLDER_CONSENT" ||
    profile.applicability !== "GUARANTEED_FUTURE_OPERATION" ||
    profile.applicableCharges !== "COMPLETE" ||
    profile.promotion !== "NONE" ||
    profile.quota !== "INAPPLICABLE" ||
    time(profile.validFrom) > now ||
    time(profile.validUntil) <= now ||
    time(profile.validUntil) <= time(profile.validFrom)
  )
    return unavailable();
  if (original.purpose === "processing") {
    const terms = exact(profile.terms, [
      "kind",
      "method",
      "model",
      "base",
      "rounding",
      "clamp",
      "cardCharge",
    ]);
    if (
      profile.operatorReference !== original.scope.operatorReference ||
      profile.recipientReference !== original.scope.recipientReference ||
      terms.kind !== "processing" ||
      terms.method !== original.scope.method ||
      terms.model !== "AFFINE" ||
      terms.base !== "CHARGED_GROSS" ||
      terms.rounding !== "CEILING" ||
      terms.clamp !== "NONE" ||
      terms.cardCharge !==
        (original.scope.method === "CREDIT_CARD"
          ? "DETACHED_ONE_INSTALLMENT"
          : "NOT_APPLICABLE")
    )
      return unavailable();
  } else {
    const terms = exact(profile.terms, [
      "kind",
      "rail",
      "route",
      "model",
      "debit",
      "rounding",
    ]);
    if (
      binding.accountBindingId !== original.scope.accountId ||
      terms.kind !== "withdrawal" ||
      !["PIX", "TED"].includes(String(terms.rail)) ||
      terms.route !== "EXTERNAL_BANK" ||
      terms.model !== "FIXED" ||
      terms.debit !== "GROSS_AMOUNT_INCLUDES_FEE" ||
      terms.rounding !== "CEILING"
    )
      return unavailable();
  }
  return profile as unknown as AsaasTrustedFeeProfile;
}

export function createAsaasFeeQuotes(options: AsaasFeeQuotesOptions): {
  loadPricingPolicy: GiftQuoteServiceDependencies["loadPricingPolicy"];
  quoteWithdrawal(scope: WithdrawalFeeScope): Promise<WithdrawalFeeQuote>;
} {
  if (!options || typeof options !== "object") return unavailable();
  const {
    readAccountFees,
    resolveFeeProfile,
    now,
    pricingFreshnessMs,
    withdrawalFreshnessMs,
  } = options;
  if (
    typeof readAccountFees !== "function" ||
    typeof resolveFeeProfile !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(pricingFreshnessMs) ||
    pricingFreshnessMs <= 0 ||
    !Number.isSafeInteger(withdrawalFreshnessMs) ||
    withdrawalFreshnessMs <= 0 ||
    withdrawalFreshnessMs > 300_000
  )
    return unavailable();

  async function observe(original: AsaasFeeProfileRequest) {
    const startedAt = time(now());
    const suppliedProfile = await resolveFeeProfile(structuredClone(original));
    const beforeRead = time(now());
    if (beforeRead < startedAt) return unavailable();
    // The resolver bridges original account/holder and rail facts absent from
    // the public ports. Copy its original authority before the next await.
    const profile = trustedProfile(suppliedProfile, original, beforeRead);
    const suppliedObservation = await readAccountFees(
      structuredClone(profile.binding),
    );
    const afterRead = time(now());
    const observation = exact(structuredClone(suppliedObservation), [
      "source",
      "provider",
      "siteId",
      "accountBindingId",
      "accountReference",
      "environment",
      "currency",
      "observedAt",
      "completedAt",
      "fees",
    ]);
    const nativeObservedAt = time(observation.observedAt);
    const completedAt = time(observation.completedAt);
    if (
      afterRead < beforeRead ||
      observation.source !== "provider" ||
      observation.currency !== "BRL" ||
      Object.entries(profile.binding).some(
        ([key, value]) => observation[key] !== value,
      ) ||
      nativeObservedAt < beforeRead ||
      nativeObservedAt > completedAt ||
      completedAt > afterRead
    )
      return unavailable();
    const freshness =
      original.purpose === "processing"
        ? pricingFreshnessMs
        : withdrawalFreshnessMs;
    const expiresAt = Math.min(
      time(profile.validUntil),
      beforeRead + freshness,
    );
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= afterRead)
      return unavailable();
    time(new Date(expiresAt));
    return {
      profile,
      observation: observation as unknown as AsaasAccountFeesObservation,
      observedAt: beforeRead,
      afterRead,
      expiresAt,
    };
  }

  function finish(
    sample: Awaited<ReturnType<typeof observe>>,
    original: AsaasFeeProfileRequest,
    components: number[],
  ) {
    const returnedAt = time(now());
    if (returnedAt < sample.afterRead || returnedAt >= sample.expiresAt)
      return unavailable();
    const p = sample.profile;
    // Sampling time and freshness-derived expiry are evidence, not tariff identity.
    const policyVersion = `asaas.fees.${createHash("sha256")
      .update(
        JSON.stringify([
          original.purpose,
          original.purpose === "processing"
            ? [
                original.scope.siteId,
                original.scope.provider,
                original.scope.operatorReference,
                original.scope.accountReference,
                original.scope.recipientReference,
                original.scope.environment,
                original.scope.destinationVersion,
                original.scope.bankReference,
                original.scope.method,
              ]
            : [
                original.scope.siteId,
                original.scope.accountId,
                original.scope.accountReference,
                original.scope.environment,
                original.scope.bankReference,
                original.scope.destinationVersion,
                original.scope.amountCents,
                original.scope.currency,
              ],
          [
            p.binding.provider,
            p.binding.siteId,
            p.binding.accountBindingId,
            p.binding.accountReference,
            p.binding.environment,
          ],
          p.operatorReference,
          p.recipientReference,
          p.holderReference,
          p.holderConsentReference,
          p.holderAuthority,
          p.authorityReference,
          p.authorityVersion,
          time(p.validFrom),
          time(p.validUntil),
          p.applicability,
          p.applicableCharges,
          p.promotion,
          p.quota,
          p.terms.kind === "processing"
            ? [
                p.terms.kind,
                p.terms.method,
                p.terms.model,
                p.terms.base,
                p.terms.rounding,
                p.terms.clamp,
                p.terms.cardCharge,
                200,
              ]
            : [
                p.terms.kind,
                p.terms.rail,
                p.terms.route,
                p.terms.model,
                p.terms.debit,
                p.terms.rounding,
              ],
          components,
        ]),
      )
      .digest("hex")}`;
    return {
      policyVersion,
      observedAt: new Date(sample.observedAt),
      expiresAt: new Date(sample.expiresAt),
    };
  }

  return {
    async loadPricingPolicy(value) {
      try {
        const original = request("processing", value);
        if (original.purpose !== "processing") return unavailable();
        const sample = await observe(original);
        const fees =
          original.scope.method === "CREDIT_CARD"
            ? sample.observation.fees.payment?.creditCard
            : sample.observation.fees.payment?.pix;
        if (!fees) return unavailable();
        let fixed: number;
        let rate: number;
        if (original.scope.method === "CREDIT_CARD") {
          const card = sample.observation.fees.payment?.creditCard;
          if (
            !card ||
            card.discountOneInstallmentPercentage != null ||
            card.discountExpiration != null
          )
            return unavailable();
          fixed = feeCents(card.operationValue);
          rate = feeCents(card.oneInstallmentPercentage);
        } else {
          const pix = sample.observation.fees.payment?.pix;
          if (
            !pix ||
            pix.fixedFeeValueWithDiscount != null ||
            pix.discountExpiration != null ||
            feeCents(pix.minimumFeeValue) !== 0 ||
            feeCents(pix.maximumFeeValue) !== 0 ||
            pix.monthlyCreditsWithoutFee !== 0
          )
            return unavailable();
          fixed = feeCents(pix.fixedFeeValue);
          rate = feeCents(pix.percentageFee);
        }
        if (rate >= 10_000) return unavailable();
        const evidence = finish(sample, original, [fixed, rate]);
        const { method, ...binding } = original.scope;
        return Object.freeze({
          ...binding,
          verification: "verified",
          provenance: "provider",
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
          policy: Object.freeze({
            version: evidence.policyVersion,
            method,
            commissionBasisPoints: 200,
            processingFixedCents: fixed,
            processingBasisPoints: rate,
            rounding: "CEILING",
          }),
        });
      } catch {
        return null;
      }
    },
    async quoteWithdrawal(value) {
      try {
        const original = request("withdrawal", value);
        if (original.purpose !== "withdrawal") return unavailable();
        const sample = await observe(original);
        if (sample.profile.terms.kind !== "withdrawal") return unavailable();
        const rail =
          sample.profile.terms.rail === "PIX"
            ? sample.observation.fees.transfer?.pix
            : sample.observation.fees.transfer?.ted;
        const pix = sample.observation.fees.transfer?.pix;
        if (
          rail?.consideredInMonthlyTransfersWithoutFee !== false ||
          (sample.profile.terms.rail === "PIX" &&
            (pix?.discountValue != null || pix?.expirationDate != null))
        )
          return unavailable();
        const fee = feeCents(rail.feeValue);
        if (fee >= original.scope.amountCents) return unavailable();
        const evidence = finish(sample, original, [fee]);
        return Object.freeze({
          ...original.scope,
          feeCents: fee,
          policyVersion: evidence.policyVersion,
          provenance: "provider",
          verification: "verified",
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
        });
      } catch {
        return unavailable();
      }
    },
  };
}
