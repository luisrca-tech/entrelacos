import { createHash } from "node:crypto";
import type { AsaasAccountFeesObservation } from "./asaasHttpClient";
import type { FinancialAccountBinding } from "./financialOverview";
import { parseBrlCents } from "./giftMoney";
import type {
  GiftPricingEvidence,
  GiftQuoteServiceDependencies,
} from "./giftQuotes";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";
import { allowsSandboxBuyerGrossUp } from "./sandboxBuyerGrossUp";

export interface SandboxDemoPricingAuthorization
  extends FinancialAccountBinding,
    LiveSitePolicy {
  isDemo: boolean;
  sandboxBuyerGrossUpSiteId?: string;
  applicationEnvironment: "development" | "test" | "production";
}
type Scope = Parameters<GiftQuoteServiceDependencies["loadPricingPolicy"]>[0];
interface Options {
  readAccountFees(
    binding: FinancialAccountBinding,
  ): Promise<AsaasAccountFeesObservation>;
  now(): Date;
}
function cents(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)
  )
    throw new Error("Unsupported demo tariff");
  return parseBrlCents(value);
}
function time(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("Invalid demo pricing clock");
  return value.getTime();
}
const saoPaulo = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function localParts(date: Date) {
  return Object.fromEntries(
    saoPaulo.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}
function promotionExpiry(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    throw new Error("Ambiguous demo promotion expiry");
  // The operational estimate interprets Asaas wall-clock dates in Sao Paulo.
  // Verify the assumed offset against Intl; unsupported dates never gain validity.
  const date = new Date(`${value.replace(" ", "T")}-03:00`);
  const parts = localParts(date);
  if (
    `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` !==
    value
  )
    throw new Error("Invalid demo promotion expiry");
  return time(date);
}
function count(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  )
    throw new Error("Unknown demo quota");
  return value;
}

// Authorization comes from persisted site/account facts. This policy describes an
// observed fee schedule for a demo, never holder consent or a future tariff guarantee.
export async function loadSandboxDemoPricing(
  scope: Scope,
  authorization: SandboxDemoPricingAuthorization,
  options: Options,
): Promise<GiftPricingEvidence | null> {
  if (
    authorization.isDemo !== true ||
    authorization.applicationEnvironment !== "development" ||
    authorization.environment !== "sandbox" ||
    scope.environment !== "sandbox" ||
    (scope.feeAllocation === "BUYER_GROSS_UP" &&
      !allowsSandboxBuyerGrossUp({ ...authorization, siteId: scope.siteId }))
  )
    return null;
  return loadObservedPricing(scope, authorization, options);
}

// Live estimates use the recipient's scoped native schedule. Only settlement
// observations establish actual fees; the guest always pays the gift amount.
export async function loadLiveReceivingPricing(
  scope: Scope,
  authorization: SandboxDemoPricingAuthorization,
  options: Options,
): Promise<GiftPricingEvidence | null> {
  if (
    scope.feeAllocation === "BUYER_GROSS_UP" ||
    !allowsLiveSite({
      siteId: scope.siteId,
      isDemo: authorization.isDemo,
      mode: scope.environment,
      applicationEnvironment: authorization.applicationEnvironment,
      liveDemoSiteId: authorization.liveDemoSiteId,
    }) ||
    authorization.applicationEnvironment !== "production" ||
    authorization.environment !== "live" ||
    scope.environment !== "live"
  )
    return null;
  return loadObservedPricing(scope, authorization, options);
}

async function loadObservedPricing(
  originalScope: Scope,
  originalAuthorization: SandboxDemoPricingAuthorization,
  options: Options,
): Promise<GiftPricingEvidence | null> {
  try {
    const scope = structuredClone(originalScope);
    const authorization = { ...originalAuthorization };
    if (
      authorization.environment !== scope.environment ||
      scope.provider !== "ASAAS" ||
      authorization.provider !== "ASAAS" ||
      authorization.siteId !== scope.siteId ||
      authorization.accountReference !== scope.accountReference ||
      !authorization.accountBindingId ||
      !["PIX", "CREDIT_CARD"].includes(scope.method)
    )
      return null;
    const binding: FinancialAccountBinding = {
      provider: "ASAAS",
      siteId: scope.siteId,
      accountBindingId: authorization.accountBindingId,
      accountReference: scope.accountReference,
      environment: authorization.environment,
    };
    const started = time(options.now());
    const observation = structuredClone(await options.readAccountFees(binding));
    const completed = time(options.now());
    if (
      observation.source !== "provider" ||
      observation.currency !== "BRL" ||
      Object.entries(binding).some(
        ([key, value]) =>
          observation[key as keyof FinancialAccountBinding] !== value,
      ) ||
      time(observation.observedAt) < started ||
      time(observation.completedAt) < time(observation.observedAt) ||
      time(observation.completedAt) > completed ||
      completed < started ||
      completed >= started + 300_000
    )
      return null;
    let fixed: number;
    let rate: number;
    let expiresAt = started + 300_000;
    if (scope.method === "PIX") {
      const pix = observation.fees.payment?.pix;
      if (!pix || (pix.type != null && pix.type !== "FIXED")) return null;
      const fixedType = pix.type === "FIXED";
      if (
        (pix.minimumFeeValue == null && fixedType
          ? 0
          : cents(pix.minimumFeeValue)) !== 0 ||
        (pix.maximumFeeValue == null && fixedType
          ? 0
          : cents(pix.maximumFeeValue)) !== 0
      )
        return null;
      fixed = cents(pix.fixedFeeValue);
      rate =
        pix.percentageFee == null && fixedType ? 0 : cents(pix.percentageFee);
      if (fixedType && rate !== 0) return null;
      const monthly = count(pix.monthlyCreditsWithoutFee);
      if (
        pix.fixedFeeValueWithDiscount != null ||
        pix.discountExpiration != null
      ) {
        if (
          !fixedType ||
          pix.fixedFeeValueWithDiscount == null ||
          pix.discountExpiration == null
        )
          return null;
        const discounted = cents(pix.fixedFeeValueWithDiscount);
        const expiry = promotionExpiry(pix.discountExpiration);
        if (discounted > fixed) return null;
        if (expiry > completed) {
          fixed = discounted;
          expiresAt = Math.min(expiresAt, expiry);
        }
      }
      // Homologation uses the paid tariff: a quota counter does not reserve a
      // free slot, and Sandbox settlement has contradicted this counter.
      if (monthly > 0) {
        if (!fixedType) return null;
        const used = count(pix.creditsReceivedOfCurrentMonth);
        if (used < monthly && scope.feeAllocation !== "BUYER_GROSS_UP") {
          // Another charge can consume the last free slot. Settlement uses
          // observed actual fees rather than promising this estimate.
          fixed = 0;
          rate = 0;
          const parts = localParts(new Date(started));
          const nextMonth = new Date(
            Date.UTC(Number(parts.year), Number(parts.month), 1),
          );
          expiresAt = Math.min(
            expiresAt,
            promotionExpiry(`${nextMonth.toISOString().slice(0, 10)} 00:00:00`),
          );
        }
      }
    } else {
      const card = observation.fees.payment?.creditCard;
      if (!card) return null;
      fixed = cents(card.operationValue);
      rate = cents(card.oneInstallmentPercentage);
      if (
        card.discountOneInstallmentPercentage != null ||
        card.discountExpiration != null ||
        card.hasValidDiscount === true
      ) {
        if (
          typeof card.hasValidDiscount !== "boolean" ||
          card.discountOneInstallmentPercentage == null ||
          card.discountExpiration == null
        )
          return null;
        const discounted = cents(card.discountOneInstallmentPercentage);
        const expiry = promotionExpiry(card.discountExpiration);
        if (discounted > rate) return null;
        if (card.hasValidDiscount) {
          if (expiry <= completed) return null;
          rate = discounted;
          expiresAt = Math.min(expiresAt, expiry);
        }
      }
    }
    if (rate >= 10_000) return null;
    const version = `${authorization.environment === "live" ? "asaas-live-observed" : "sandbox-demo"}.${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          scope,
          binding,
          observation.fees.payment,
          fixed,
          rate,
          200,
        ]),
      )
      .digest("hex")}`;
    const { method, feeAllocation, ...receiving } = scope;
    return {
      ...receiving,
      verification: "verified",
      provenance: "provider",
      observedAt: new Date(started),
      expiresAt: new Date(expiresAt),
      policy: {
        version,
        method,
        feeAllocation:
          feeAllocation === "BUYER_GROSS_UP"
            ? feeAllocation
            : "RECIPIENT_DEDUCTED",
        feeBasis:
          feeAllocation === "BUYER_GROSS_UP"
            ? "SANDBOX_BUYER_ESTIMATE"
            : "OBSERVED_ESTIMATE",
        commissionBasisPoints: 200,
        processingFixedCents: fixed,
        processingBasisPoints: rate,
        rounding: "CEILING",
      },
    };
  } catch {
    return null;
  }
}
