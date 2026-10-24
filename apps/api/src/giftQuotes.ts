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

export interface StoredGiftForQuote {
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
  // The adapter must read stored publication and site activity, never browser data.
  findPublishedGift(
    siteId: string,
    giftId: string,
  ): Promise<StoredGiftForQuote | null>;
  loadReceivingContext(
    siteId: string,
  ): Promise<GiftQuoteReceivingContext | null>;
  loadPricingPolicy(
    binding: GiftQuoteReceivingBinding & { method: GiftQuote["method"] },
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

      const loaded = await dependencies.loadReceivingContext(site.data);
      if (!loaded) throw new ReceivingReadinessServiceError();
      const context = structuredClone(loaded);
      const receivingClock = readQuoteClock(dependencies);
      const readiness = evaluateReceivingReadiness({
        ...context,
        siteId: site.data,
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
        siteId: site.data,
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
        method: body.data.method,
      });
      if (!loadedPricing) return policyUnavailable();
      const pricing = structuredClone(loadedPricing);
      if (
        pricing.policy.feeBasis === "OBSERVED_ESTIMATE" &&
        !(
          (context.environment === "development" &&
            context.mode === "sandbox" &&
            context.isDemo === true) ||
          (context.environment === "production" &&
            context.mode === "live" &&
            allowsLiveSite({
              siteId: site.data,
              isDemo: context.isDemo,
              mode: context.mode,
              applicationEnvironment: context.environment,
              liveDemoSiteId: context.liveDemoSiteId,
            }) &&
            pricing.provenance === "provider")
        )
      )
        return policyUnavailable();
      pricing.policy.feeAllocation = "RECIPIENT_DEDUCTED";
      const { now, nowTime, deadlineTime, createdAt } =
        readQuoteClock(dependencies);
      // An asynchronous pricing read must not extend old receiving evidence.
      assertReceivingReady(
        evaluateReceivingReadiness({ ...context, siteId: site.data, now }),
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
