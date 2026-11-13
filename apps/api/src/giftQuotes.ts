import {
  type GiftItem,
  type GiftQuote,
  type GiftTariffTier,
  getGiftTariffTier,
  giftMinimumNominalCents,
  giftQuoteInputSchema,
  giftQuoteSchema,
  type PublicGiftItem,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import {
  type GiftProcessingPolicy,
  giftV2RecipientSplitCents,
  quoteGiftPurchaseAmounts,
} from "./giftMoney";
import { allowsLiveSite } from "./liveSitePolicy";
import {
  assertReceivingReady,
  evaluateReceivingReadiness,
  type ReceivingProviderBinding,
  type ReceivingReadinessInput,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";
import { allowsSandboxBuyerGrossUp } from "./sandboxBuyerGrossUp";

export interface StoredGiftForQuote {
  pricingSettings?: {
    feeAllocation: "RECIPIENT_DEDUCTED" | "BUYER_GROSS_UP";
    revision: number;
  };
  gift: PublicGiftItem;
  publicationState: GiftItem["publicationState"];
  siteActive: boolean;
}

export type GiftQuoteReceivingContext = Omit<
  ReceivingReadinessInput,
  "siteId" | "now"
>;

export interface GiftQuoteReceivingBinding extends ReceivingProviderBinding {
  accountReference: string;
  recipientReference: string;
  destinationVersion: number;
  bankReference: string;
}

export interface GiftPricingEvidence extends GiftQuoteReceivingBinding {
  verification: "verified" | "unverified";
  // platform-tariff-table: V2 local tariff table (giftTariffs.ts), no network.
  provenance: "provider" | "local-test" | "platform-tariff-table";
  observedAt: Date | null;
  expiresAt: Date | null;
  policy: GiftProcessingPolicy;
}

export interface GiftQuoteSnapshot {
  readonly pricingSettings?: StoredGiftForQuote["pricingSettings"];
  readonly quote: GiftQuote;
  readonly gift: PublicGiftItem;
  readonly receiving: GiftQuoteReceivingBinding;
  readonly pricing: Omit<GiftPricingEvidence, "observedAt" | "expiresAt"> & {
    observedAt: string;
    expiresAt: string;
  };
  /** PLATFORM_ACCOUNT_SPLIT_V2 only: frozen settlement terms. */
  readonly settlement?: GiftV2SettlementSnapshot;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface GiftV2SettlementSnapshot {
  readonly version: "PLATFORM_ACCOUNT_SPLIT_V2";
  readonly tariffVersion: string;
  readonly tier: GiftTariffTier;
  readonly anticipationCents: number;
  /** Fixed split to the couple wallet per installment; sums to the nominal. */
  readonly recipientSplitCents: readonly number[];
}

/** Single dispatch point between V1 and V2 settlement (spec e.5). */
export function getSettlementVersion(source: {
  quote: Pick<GiftQuote, "settlementVersion">;
}): GiftQuote["settlementVersion"] {
  return source.quote.settlementVersion;
}

export function isPlatformAccountSplit(source: {
  quote: Pick<GiftQuote, "settlementVersion">;
}): boolean {
  return getSettlementVersion(source) === "PLATFORM_ACCOUNT_SPLIT_V2";
}

/** Recomputes and checks the V2 settlement terms frozen with a quote. */
export function buildGiftV2Settlement(
  quote: GiftQuote,
): GiftV2SettlementSnapshot {
  if (quote.settlementVersion !== "PLATFORM_ACCOUNT_SPLIT_V2")
    throw new Error("Quote is not a V2 quote");
  const count = quote.installmentCount ?? 1;
  return {
    version: "PLATFORM_ACCOUNT_SPLIT_V2",
    tariffVersion: quote.policyVersion,
    tier: getGiftTariffTier(quote.method, count),
    anticipationCents: quote.anticipationCents ?? 0,
    recipientSplitCents: giftV2RecipientSplitCents(quote),
  };
}

export function readGiftV2Settlement(
  quote: GiftQuote,
  settlement: GiftV2SettlementSnapshot | undefined,
): GiftV2SettlementSnapshot | undefined {
  if (quote.settlementVersion !== "PLATFORM_ACCOUNT_SPLIT_V2") {
    if (settlement !== undefined) throw new Error("Unexpected V2 settlement");
    return undefined;
  }
  const expected = buildGiftV2Settlement(quote);
  if (
    !settlement ||
    settlement.version !== expected.version ||
    settlement.tariffVersion !== expected.tariffVersion ||
    settlement.tier !== expected.tier ||
    settlement.anticipationCents !== expected.anticipationCents ||
    settlement.recipientSplitCents.length !==
      expected.recipientSplitCents.length ||
    settlement.recipientSplitCents.some(
      (cents, index) => cents !== expected.recipientSplitCents[index],
    )
  )
    throw new Error("V2 settlement does not match the quote");
  return expected;
}

export interface GiftQuoteServiceDependencies {
  sandboxBuyerGrossUpSiteId?: string;
  // The adapter must read stored publication and site activity, never browser data.
  findPublishedGift(
    siteId: string,
    giftId: string,
  ): Promise<StoredGiftForQuote | null>;
  loadReceivingContext(
    siteId: string,
  ): Promise<GiftQuoteReceivingContext | null>;
  loadPricingPolicy(
    binding: GiftQuoteReceivingBinding & {
      method: GiftQuote["method"];
      feeAllocation?: GiftQuote["feeAllocation"];
    },
  ): Promise<GiftPricingEvidence | null>;
  repository: { append(snapshot: GiftQuoteSnapshot): Promise<void> };
  now(): Date;
  generateId(): string;
  quoteTtlMs: number;
  pricingFreshnessMs: number;
}

export class GiftQuoteServiceError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: "QUOTE_INVALID" | "POLICY_UNAVAILABLE",
    readonly title: string,
  ) {
    super(title);
    this.name = "GiftQuoteServiceError";
  }
}

function quoteInvalid(): never {
  throw new GiftQuoteServiceError(
    400,
    "QUOTE_INVALID",
    "Gift quote is invalid",
  );
}

function policyUnavailable(): never {
  throw new GiftQuoteServiceError(
    409,
    "POLICY_UNAVAILABLE",
    "Gift processing policy is unavailable",
  );
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function dateTime(value: Date | null): number {
  return value instanceof Date ? value.getTime() : Number.NaN;
}

function readQuoteClock(dependencies: GiftQuoteServiceDependencies) {
  const nowTime = dateTime(dependencies.now());
  const deadlineTime = nowTime + dependencies.quoteTtlMs;
  if (
    !Number.isFinite(nowTime) ||
    !Number.isSafeInteger(dependencies.quoteTtlMs) ||
    dependencies.quoteTtlMs <= 0 ||
    !Number.isSafeInteger(deadlineTime) ||
    !Number.isFinite(new Date(deadlineTime).getTime())
  ) {
    return quoteInvalid();
  }
  const now = new Date(nowTime);
  const createdAt = now.toISOString();
  if (
    !giftQuoteSchema.shape.expiresAt.safeParse(createdAt).success ||
    !giftQuoteSchema.shape.expiresAt.safeParse(
      new Date(deadlineTime).toISOString(),
    ).success
  ) {
    return quoteInvalid();
  }
  return { now, nowTime, deadlineTime, createdAt };
}

export async function loadGiftPricingEvidence(
  dependencies: GiftQuoteServiceDependencies,
  siteId: string,
  method: GiftQuote["method"],
  feeAllocation?: GiftQuote["feeAllocation"],
) {
  const loaded = await dependencies.loadReceivingContext(siteId);
  if (!loaded) throw new ReceivingReadinessServiceError();
  const context = structuredClone(loaded);
  const receivingClock = readQuoteClock(dependencies);
  const readiness = evaluateReceivingReadiness({
    ...context,
    siteId: siteId,
    now: receivingClock.now,
  });
  assertReceivingReady(readiness);
  const binding = context.providerBinding;
  if (
    !binding?.accountReference ||
    !binding.recipientReference ||
    !binding.destinationVersion ||
    !binding.bankReference
  ) {
    throw new ReceivingReadinessServiceError();
  }
  const receiving: GiftQuoteReceivingBinding = {
    siteId: siteId,
    provider: binding.provider,
    operatorReference: binding.operatorReference,
    environment: binding.environment,
    accountReference: binding.accountReference,
    recipientReference: binding.recipientReference,
    destinationVersion: binding.destinationVersion,
    bankReference: binding.bankReference,
  };
  const loadedPricing = await dependencies.loadPricingPolicy({
    ...receiving,
    method: method,
    ...(feeAllocation ? { feeAllocation } : {}),
  });
  if (!loadedPricing) return policyUnavailable();
  const pricing = structuredClone(loadedPricing);
  if (
    pricing.policy.feeBasis === "SANDBOX_BUYER_ESTIMATE" &&
    (feeAllocation !== "BUYER_GROSS_UP" ||
      pricing.policy.feeAllocation !== "BUYER_GROSS_UP" ||
      pricing.provenance !== "provider" ||
      !allowsSandboxBuyerGrossUp({
        siteId,
        sandboxBuyerGrossUpSiteId: dependencies.sandboxBuyerGrossUpSiteId,
        applicationEnvironment: context.environment,
        environment: context.mode,
        isDemo: context.isDemo,
      }))
  )
    return policyUnavailable();
  if (
    pricing.policy.feeBasis === "OBSERVED_ESTIMATE" &&
    !(
      (context.environment === "development" &&
        context.mode === "sandbox" &&
        context.isDemo === true) ||
      (context.environment === "production" &&
        context.mode === "live" &&
        allowsLiveSite({
          siteId: siteId,
          isDemo: context.isDemo,
          mode: context.mode,
          applicationEnvironment: context.environment,
          liveDemoSiteId: context.liveDemoSiteId,
        }) &&
        pricing.provenance === "provider")
    )
  )
    return policyUnavailable();
  if (
    pricing.policy.feeBasis === "ACCOUNT_BUYER_ESTIMATE" &&
    (pricing.policy.feeAllocation !== "BUYER_GROSS_UP" ||
      pricing.provenance !== "provider")
  )
    return policyUnavailable();
  if (
    (pricing.policy.feeBasis === "PLATFORM_TARIFF_TABLE") !==
      (pricing.provenance === "platform-tariff-table") ||
    (pricing.policy.feeBasis === "PLATFORM_TARIFF_TABLE" &&
      (pricing.policy.feeAllocation !== "BUYER_GROSS_UP" ||
        (feeAllocation !== undefined && feeAllocation !== "BUYER_GROSS_UP")))
  )
    return policyUnavailable();
  const { now, nowTime, deadlineTime, createdAt } =
    readQuoteClock(dependencies);
  // An asynchronous pricing read must not extend old receiving evidence.
  assertReceivingReady(
    evaluateReceivingReadiness({ ...context, siteId: siteId, now }),
  );
  const observedTime = dateTime(pricing.observedAt);
  const pricingExpiryTime = dateTime(pricing.expiresAt);
  if (
    pricing.verification !== "verified" ||
    (pricing.provenance !== "provider" &&
      pricing.provenance !== "platform-tariff-table" &&
      (pricing.provenance !== "local-test" ||
        context.isDemo !== true ||
        context.environment === "production" ||
        receiving.environment !== "sandbox")) ||
    pricing.siteId !== receiving.siteId ||
    pricing.provider !== receiving.provider ||
    pricing.operatorReference !== receiving.operatorReference ||
    pricing.accountReference !== receiving.accountReference ||
    pricing.recipientReference !== receiving.recipientReference ||
    pricing.environment !== receiving.environment ||
    pricing.destinationVersion !== receiving.destinationVersion ||
    pricing.bankReference !== receiving.bankReference ||
    !Number.isSafeInteger(dependencies.pricingFreshnessMs) ||
    dependencies.pricingFreshnessMs <= 0 ||
    !Number.isFinite(observedTime) ||
    observedTime > nowTime ||
    nowTime - observedTime > dependencies.pricingFreshnessMs ||
    !Number.isFinite(pricingExpiryTime) ||
    pricingExpiryTime <= nowTime
  ) {
    return policyUnavailable();
  }
  const pricingObservedAt = new Date(observedTime).toISOString();
  const pricingExpiresAt = new Date(pricingExpiryTime).toISOString();
  if (
    !giftQuoteSchema.shape.expiresAt.safeParse(pricingObservedAt).success ||
    !giftQuoteSchema.shape.expiresAt.safeParse(pricingExpiresAt).success
  ) {
    return policyUnavailable();
  }
  return {
    readiness,
    receiving,
    pricing,
    deadlineTime,
    createdAt,
    pricingExpiryTime,
    pricingObservedAt,
    pricingExpiresAt,
  };
}

export function createGiftQuoteService(
  dependencies: GiftQuoteServiceDependencies,
) {
  return {
    async createQuote(siteId: unknown, input: unknown): Promise<GiftQuote> {
      const site = giftQuoteSchema.shape.siteId.safeParse(siteId);
      const body = giftQuoteInputSchema.safeParse(input);
      if (!site.success || !body.success) return quoteInvalid();

      readQuoteClock(dependencies);
      const stored = await dependencies.findPublishedGift(
        site.data,
        body.data.giftId,
      );
      const gift = publicGiftItemSchema.safeParse(stored?.gift);
      if (
        !gift.success ||
        gift.data.siteId !== site.data ||
        gift.data.id !== body.data.giftId ||
        gift.data.nominalCents < giftMinimumNominalCents ||
        stored?.publicationState !== "PUBLISHED" ||
        stored.siteActive !== true
      ) {
        return quoteInvalid();
      }
      const allocation = "BUYER_GROSS_UP";

      const {
        readiness,
        receiving,
        pricing,
        deadlineTime,
        createdAt,
        pricingExpiryTime,
        pricingObservedAt,
        pricingExpiresAt,
      } = await loadGiftPricingEvidence(
        dependencies,
        site.data,
        body.data.method,
        allocation,
      );
      const policy = { ...pricing.policy, feeAllocation: allocation } as const;
      const amounts = quoteGiftPurchaseAmounts(
        {
          nominalCents: gift.data.nominalCents,
          method: body.data.method,
          policy,
        },
        body.data.installmentCount,
      );
      const expiresAt = new Date(
        Math.min(deadlineTime, pricingExpiryTime),
      ).toISOString();
      const quote = giftQuoteSchema.safeParse({
        ...amounts,
        id: dependencies.generateId(),
        giftId: gift.data.id,
        siteId: site.data,
        title: gift.data.title,
        method: body.data.method,
        currency: gift.data.currency,
        commissionBasisPoints: 200,
        settlementVersion:
          policy.feeBasis === "PLATFORM_TARIFF_TABLE"
            ? "PLATFORM_ACCOUNT_SPLIT_V2"
            : "PLATFORM_FEE_GUARANTEE_V1",
        expiresAt,
        mode: readiness.mode,
      });
      if (!quote.success) return quoteInvalid();
      const settlement =
        quote.data.settlementVersion === "PLATFORM_ACCOUNT_SPLIT_V2"
          ? buildGiftV2Settlement(quote.data)
          : undefined;
      const snapshot = freezeSnapshot<GiftQuoteSnapshot>(
        structuredClone({
          quote: quote.data,
          ...(stored.pricingSettings
            ? {
                pricingSettings: {
                  revision: stored.pricingSettings.revision,
                  feeAllocation: allocation,
                },
              }
            : {}),
          gift: gift.data,
          receiving,
          pricing: {
            ...receiving,
            verification: pricing.verification,
            provenance: pricing.provenance,
            policy: {
              version: pricing.policy.version,
              method: pricing.policy.method,
              commissionBasisPoints: pricing.policy.commissionBasisPoints,
              processingBasisPoints: pricing.policy.processingBasisPoints,
              processingFixedCents: pricing.policy.processingFixedCents,
              rounding: pricing.policy.rounding,
              ...(pricing.policy.feeBasis
                ? { feeBasis: pricing.policy.feeBasis }
                : {}),
              feeAllocation: allocation,
              ...(policy.cardInstallmentBasisPoints
                ? {
                    cardInstallmentBasisPoints:
                      policy.cardInstallmentBasisPoints,
                  }
                : {}),
            },
            observedAt: pricingObservedAt,
            expiresAt: pricingExpiresAt,
          },
          ...(settlement ? { settlement } : {}),
          createdAt,
          expiresAt,
        }),
      );
      await dependencies.repository.append(snapshot);
      return structuredClone(snapshot.quote);
    },
  };
}
