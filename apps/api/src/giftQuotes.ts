import {
  type GiftItem,
  type GiftQuote,
  giftQuoteInputSchema,
  giftQuoteSchema,
  type PublicGiftItem,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import { type GiftProcessingPolicy, quoteGiftAmounts } from "./giftMoney";
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
  provenance: "provider" | "local-test";
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
  readonly createdAt: string;
  readonly expiresAt: string;
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
        stored?.publicationState !== "PUBLISHED" ||
        stored.siteActive !== true
      ) {
        return quoteInvalid();
      }
      // A preference does not approve live tariffs. Sandbox homologation requires
      // an explicit site opt-in and separately scoped provider evidence.
      const allocation =
        stored.pricingSettings?.feeAllocation ?? "RECIPIENT_DEDUCTED";
      if (
        allocation === "BUYER_GROSS_UP" &&
        dependencies.sandboxBuyerGrossUpSiteId !== site.data
      )
        return policyUnavailable();

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
        allocation === "BUYER_GROSS_UP" ? allocation : undefined,
      );
      if (
        allocation === "BUYER_GROSS_UP" &&
        pricing.policy.feeBasis !== "SANDBOX_BUYER_ESTIMATE"
      )
        return policyUnavailable();
      pricing.policy.feeAllocation = allocation;
      const amounts = quoteGiftAmounts({
        nominalCents: gift.data.nominalCents,
        method: body.data.method,
        policy: pricing.policy,
      });
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
        expiresAt,
        mode: readiness.mode,
      });
      if (!quote.success) return quoteInvalid();
      const snapshot = freezeSnapshot<GiftQuoteSnapshot>(
        structuredClone({
          quote: quote.data,
          ...(stored.pricingSettings
            ? { pricingSettings: structuredClone(stored.pricingSettings) }
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
              feeAllocation: pricing.policy.feeAllocation,
            },
            observedAt: pricingObservedAt,
            expiresAt: pricingExpiresAt,
          },
          createdAt,
          expiresAt,
        }),
      );
      await dependencies.repository.append(snapshot);
      return structuredClone(snapshot.quote);
    },
  };
}
