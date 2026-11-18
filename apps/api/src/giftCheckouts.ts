import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  GIFT_PLATFORM_TARIFFS,
  type GiftCheckoutCreateResult,
  type GiftCheckoutPix,
  type GiftCheckoutState,
  type GiftCheckoutStatus,
  giftCheckoutCreateInputSchema,
  giftCheckoutStatusInputSchema,
  giftCheckoutStatusSchema,
  giftQuoteSchema,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import type { GiftCheckoutOrderBinding } from "./giftCheckoutLifecycle";
import { quoteGiftAmounts, quoteGiftPurchaseAmounts } from "./giftMoney";
import {
  type GiftQuoteReceivingContext,
  type GiftQuoteSnapshot,
  isPlatformAccountSplit,
  readGiftV2Settlement,
  type StoredGiftForQuote,
} from "./giftQuotes";
import {
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";
import type {
  PagarmeOrderClient,
  PagarmeOrderObservation,
} from "./pagarmeOrderClient";
import { buildPagarmeOrderRequest } from "./pagarmeOrderPayload";
import {
  assertReceivingReady,
  evaluateReceivingReadiness,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";

/** Provider of every new checkout; older stored rows keep their own value. */
export const GIFT_CHECKOUT_PROVIDER = "PAGARME";

export interface GiftCheckoutIdentity {
  siteId: string;
  quoteId: string;
  requestId: string;
  orderId: string;
  /** Also the checkout id returned to the guest and the Pagar.me order code. */
  attemptId: string;
}

export interface GiftCheckoutReservation extends GiftCheckoutIdentity {
  recoveryTokenHash: string;
  quoteSnapshot: GiftQuoteSnapshot;
  createdAt: string;
}

export interface GiftCheckoutRecord extends GiftCheckoutReservation {
  state: GiftCheckoutState;
  observedAt: string | null;
  closedReason: GiftCheckoutStatus["closedReason"];
  providerOrderId: string | null;
  pix: GiftCheckoutPix | null;
}

export interface GiftCheckoutEligibility {
  quoteSnapshot: GiftQuoteSnapshot;
  receivingContext: GiftQuoteReceivingContext | null;
  gift: StoredGiftForQuote | null;
}

export interface GiftCheckoutRepository {
  findByRequest(
    siteId: string,
    requestId: string,
  ): Promise<GiftCheckoutRecord | null>;
  findQuote(siteId: string, quoteId: string): Promise<GiftQuoteSnapshot | null>;
  // Atomically enforce unique(site, request), one order per quote and a single
  // creator; run the callback with locked, freshly read eligibility. Losers
  // return the existing row. Never call Pagar.me inside this transaction.
  reserve(
    reservation: GiftCheckoutReservation,
    assertLockedEligibility: (eligibility: GiftCheckoutEligibility) => void,
  ): Promise<{ created: boolean; record: GiftCheckoutRecord }>;
  // Bind the Pagar.me order to the attempt (CREATING/UNKNOWN only).
  saveOrder(
    identity: GiftCheckoutIdentity,
    order: PagarmeOrderObservation,
    observedAt: string,
  ): Promise<GiftCheckoutRecord>;
  // Only CREATING may become UNKNOWN.
  markOutcomeUnknown(
    identity: GiftCheckoutIdentity,
    observedAt: string,
  ): Promise<void>;
  // Pagar.me refused the creating call (4xx): no order exists.
  markProviderRejected(
    identity: GiftCheckoutIdentity,
    observedAt: string,
  ): Promise<void>;
  loadBinding(identity: {
    siteId: string;
    attemptId: string;
  }): Promise<GiftCheckoutOrderBinding | null>;
}

export interface GiftCheckoutServiceDependencies {
  revalidateQuote?(snapshot: GiftQuoteSnapshot): Promise<boolean>;
  repository: GiftCheckoutRepository;
  loadReceivingContext(
    siteId: string,
  ): Promise<GiftQuoteReceivingContext | null>;
  findPublishedGift?(
    siteId: string,
    giftId: string,
  ): Promise<StoredGiftForQuote | null>;
  orders: Pick<PagarmeOrderClient, "createOrder">;
  platformRecipientId: string;
  /**
   * Applies the order returned by the creating POST (a card is usually paid
   * or failed synchronously). Webhooks and reconciliation cover any failure.
   */
  applyOrder?(
    binding: GiftCheckoutOrderBinding,
    order: PagarmeOrderObservation,
  ): Promise<void>;
  now(): Date;
  generateId(kind: "order" | "attempt"): string;
  /** Structured, sanitized operational events (never buyer or card data). */
  observe?(event: Record<string, string>): void;
}

type CheckoutErrorCode =
  | "QUOTE_INVALID"
  | "QUOTE_EXPIRED"
  | "QUOTE_MISMATCH"
  | "INSTALLMENTS_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "REQUEST_CONFLICT"
  | "CHECKOUT_CONFIGURATION_INVALID"
  | "EXTERNAL_OUTCOME_UNKNOWN"
  | "PIX_UNAVAILABLE"
  | "PAYMENT_METHOD_UNAVAILABLE";

export class GiftCheckoutServiceError extends Error {
  readonly status: 400 | 409 | 422 | 503;
  readonly title: string;

  constructor(readonly code: CheckoutErrorCode) {
    const title = {
      QUOTE_INVALID: "Gift checkout input is invalid",
      QUOTE_EXPIRED: "Gift quote has expired",
      QUOTE_MISMATCH: "Payment method or installments differ from the quote",
      INSTALLMENTS_UNAVAILABLE: "These installments are unavailable",
      PROVIDER_UNAVAILABLE: "The quote belongs to another payment provider",
      REQUEST_CONFLICT: "Gift checkout request is unavailable",
      CHECKOUT_CONFIGURATION_INVALID:
        "Gift checkout configuration is unavailable",
      EXTERNAL_OUTCOME_UNKNOWN: "Gift checkout outcome is unresolved",
      PIX_UNAVAILABLE: "Pix is unavailable for this gift",
      PAYMENT_METHOD_UNAVAILABLE: "This payment method is unavailable",
    }[code];
    super(title);
    this.name = "GiftCheckoutServiceError";
    this.title = title;
    this.status =
      code === "QUOTE_INVALID"
        ? 400
        : code === "CHECKOUT_CONFIGURATION_INVALID"
          ? 503
          : [
                "PIX_UNAVAILABLE",
                "PAYMENT_METHOD_UNAVAILABLE",
                "QUOTE_MISMATCH",
                "INSTALLMENTS_UNAVAILABLE",
              ].includes(code)
            ? 422
            : 409;
  }
}

function fail(code: CheckoutErrorCode): never {
  throw new GiftCheckoutServiceError(code);
}

function sanitized(error: unknown): never {
  if (
    error instanceof GiftCheckoutServiceError ||
    error instanceof ReceivingReadinessServiceError
  ) {
    throw error;
  }
  return fail("EXTERNAL_OUTCOME_UNKNOWN");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function clock(dependencies: GiftCheckoutServiceDependencies): Date {
  const date = dependencies.now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return fail("QUOTE_INVALID");
  }
  const copy = new Date(date.getTime());
  if (!giftQuoteSchema.shape.expiresAt.safeParse(copy.toISOString()).success) {
    return fail("QUOTE_INVALID");
  }
  return copy;
}

function authorizedRecord(
  record: GiftCheckoutRecord,
  siteId: string,
  quoteId: string,
  requestId: string,
  tokenHash: Buffer,
) {
  const validHash =
    typeof record.recoveryTokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.recoveryTokenHash);
  const matches = timingSafeEqual(
    validHash ? Buffer.from(record.recoveryTokenHash, "hex") : Buffer.alloc(32),
    tokenHash,
  );
  if (
    !validHash ||
    !matches ||
    record.siteId !== siteId ||
    record.quoteId !== quoteId ||
    record.requestId !== requestId
  ) {
    return fail("REQUEST_CONFLICT");
  }
}

function nonempty(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 512
  );
}

function sameBinding(
  left: GiftQuoteSnapshot["receiving"],
  right: GiftQuoteReceivingContext["providerBinding"],
) {
  return (
    right !== null &&
    left.siteId === right.siteId &&
    left.provider === right.provider &&
    left.operatorReference === right.operatorReference &&
    left.accountReference === right.accountReference &&
    left.recipientReference === right.recipientReference &&
    left.bankReference === right.bankReference &&
    left.destinationVersion === right.destinationVersion &&
    left.environment === right.environment
  );
}

export function readGiftQuoteSnapshot(
  loaded: GiftQuoteSnapshot,
): GiftQuoteSnapshot {
  const value = structuredClone(loaded);
  const quote = giftQuoteSchema.safeParse(value.quote);
  const gift = publicGiftItemSchema.safeParse(value.gift);
  const binding = value.receiving;
  const pricing = value.pricing;
  const settings = value.pricingSettings;
  if (
    settings &&
    (!Number.isSafeInteger(settings.revision) ||
      settings.revision < 0 ||
      settings.feeAllocation !== quote.data?.feeAllocation)
  )
    return fail("QUOTE_INVALID");
  const time = giftQuoteSchema.shape.expiresAt;
  if (
    !quote.success ||
    !gift.success ||
    quote.data.mode === "disabled" ||
    gift.data.id !== quote.data.giftId ||
    gift.data.siteId !== quote.data.siteId ||
    gift.data.title !== quote.data.title ||
    gift.data.nominalCents !== quote.data.nominalCents ||
    !binding ||
    binding.siteId !== quote.data.siteId ||
    binding.environment !== quote.data.mode ||
    !nonempty(binding.provider) ||
    !nonempty(binding.operatorReference) ||
    !nonempty(binding.accountReference) ||
    !nonempty(binding.recipientReference) ||
    !nonempty(binding.bankReference) ||
    !Number.isSafeInteger(binding.destinationVersion) ||
    binding.destinationVersion <= 0 ||
    !pricing ||
    !pricing.policy ||
    quote.data.feeAllocation !== pricing.policy.feeAllocation ||
    !sameBinding(binding, pricing) ||
    pricing.verification !== "verified" ||
    !["provider", "local-test", "platform-tariff-table"].includes(
      pricing.provenance,
    ) ||
    (pricing.provenance === "platform-tariff-table") !==
      (pricing.policy.feeBasis === "PLATFORM_TARIFF_TABLE") ||
    (binding.environment === "live" &&
      pricing.provenance !== "provider" &&
      pricing.provenance !== "platform-tariff-table") ||
    !time.safeParse(value.createdAt).success ||
    !time.safeParse(value.expiresAt).success ||
    !time.safeParse(pricing.observedAt).success ||
    !time.safeParse(pricing.expiresAt).success ||
    value.expiresAt !== quote.data.expiresAt ||
    Date.parse(value.createdAt) >= Date.parse(value.expiresAt) ||
    Date.parse(pricing.observedAt) > Date.parse(value.createdAt) ||
    Date.parse(value.expiresAt) > Date.parse(pricing.expiresAt)
  )
    return fail("QUOTE_INVALID");
  const input = {
    nominalCents: quote.data.nominalCents,
    method: quote.data.method,
    policy: pricing.policy,
  };
  const amounts = quote.data.settlementVersion
    ? quoteGiftPurchaseAmounts(input, quote.data.installmentCount)
    : quoteGiftAmounts(input);
  if (
    Object.entries(amounts).some(
      ([key, amount]) =>
        !isDeepStrictEqual(quote.data[key as keyof typeof amounts], amount),
    )
  )
    return fail("QUOTE_INVALID");
  let settlement: ReturnType<typeof readGiftV2Settlement>;
  try {
    settlement = readGiftV2Settlement(quote.data, value.settlement);
  } catch {
    return fail("QUOTE_INVALID");
  }
  const receiving = {
    siteId: binding.siteId,
    provider: binding.provider,
    operatorReference: binding.operatorReference,
    environment: binding.environment,
    accountReference: binding.accountReference,
    recipientReference: binding.recipientReference,
    destinationVersion: binding.destinationVersion,
    bankReference: binding.bankReference,
  };
  return freeze({
    ...(settings ? { pricingSettings: settings } : {}),
    quote: quote.data,
    gift: gift.data,
    receiving,
    pricing: {
      ...receiving,
      verification: pricing.verification,
      provenance: pricing.provenance,
      observedAt: pricing.observedAt,
      expiresAt: pricing.expiresAt,
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
        ...(pricing.policy.feeAllocation
          ? { feeAllocation: pricing.policy.feeAllocation }
          : {}),
        ...(pricing.policy.cardInstallmentBasisPoints
          ? {
              cardInstallmentBasisPoints: {
                ...(pricing.policy.cardInstallmentBasisPoints.upToSix !==
                undefined
                  ? {
                      upToSix:
                        pricing.policy.cardInstallmentBasisPoints.upToSix,
                    }
                  : {}),
              },
            }
          : {}),
      },
    },
    ...(settlement ? { settlement } : {}),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  });
}

export function projectGiftCheckoutStatus(
  record: GiftCheckoutRecord,
): GiftCheckoutStatus {
  const result = giftCheckoutStatusSchema.safeParse({
    siteId: record.siteId,
    quoteId: record.quoteId,
    requestId: record.requestId,
    checkoutId: record.attemptId,
    method: record.quoteSnapshot.quote.method,
    mode: record.quoteSnapshot.quote.mode,
    state: record.state,
    observedAt: record.observedAt,
    closedReason: record.closedReason,
    mayStartNewAttempt: record.state === "CLOSED_UNPAID",
    pix:
      record.state === "AWAITING_PAYMENT" &&
      record.quoteSnapshot.quote.method === "PIX"
        ? record.pix
        : null,
  });
  if (!result.success) return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return result.data;
}

function createResult(record: GiftCheckoutRecord): GiftCheckoutCreateResult {
  const status = projectGiftCheckoutStatus(record);
  return {
    checkoutId: status.checkoutId,
    status: status.state,
    ...(status.pix ? { pix: status.pix } : {}),
  };
}

function assertEligible(
  snapshot: GiftQuoteSnapshot,
  context: GiftQuoteReceivingContext | null,
  siteId: string,
  quoteId: string,
  now: Date,
  platformRecipientId: string,
  gift?: StoredGiftForQuote | null,
) {
  const quote = giftQuoteSchema.safeParse(snapshot.quote);
  if (
    !quote.success ||
    quote.data.siteId !== siteId ||
    quote.data.id !== quoteId
  ) {
    return fail("QUOTE_INVALID");
  }
  if (Date.parse(snapshot.createdAt) > now.getTime())
    return fail("QUOTE_INVALID");
  if (Date.parse(quote.data.expiresAt) <= now.getTime())
    return fail("QUOTE_EXPIRED");
  if (!context) throw new ReceivingReadinessServiceError();
  assertReceivingReady(evaluateReceivingReadiness({ ...context, siteId, now }));
  const recipient = snapshot.receiving.recipientReference;
  if (
    !sameBinding(snapshot.receiving, context.providerBinding) ||
    context.mode !== quote.data.mode ||
    !/^rp_[A-Za-z0-9]{1,128}$/.test(recipient) ||
    recipient === platformRecipientId
  )
    throw new ReceivingReadinessServiceError();
  if (
    gift !== undefined &&
    (gift?.publicationState !== "PUBLISHED" ||
      gift.siteActive !== true ||
      gift.gift.id !== quote.data.giftId ||
      gift.gift.siteId !== siteId)
  )
    return fail("QUOTE_INVALID");
  if (
    gift &&
    (gift.gift.nominalCents !== quote.data.nominalCents ||
      gift.gift.title !== quote.data.title ||
      (gift.pricingSettings &&
        gift.pricingSettings.revision !==
          (snapshot.pricingSettings?.revision ?? 0)))
  )
    return fail("QUOTE_EXPIRED");
}

/** The frozen order terms of a V2 Pagar.me quote. */
export function giftCheckoutOrderBinding(
  record: Pick<
    GiftCheckoutRecord,
    "siteId" | "quoteId" | "orderId" | "attemptId" | "quoteSnapshot"
  > & {
    accountId: string;
    providerOrderId: string | null;
    pixExpiresAt: string | null;
  },
): GiftCheckoutOrderBinding {
  const { quote, settlement, receiving } = record.quoteSnapshot;
  if (!settlement || !receiving.recipientReference)
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return freeze({
    siteId: record.siteId,
    accountId: record.accountId,
    environment: receiving.environment,
    orderId: record.orderId,
    attemptId: record.attemptId,
    quoteId: record.quoteId,
    providerOrderId: record.providerOrderId,
    method: quote.method,
    installments: quote.installmentCount ?? 1,
    totalCents: quote.totalCents,
    nominalCents: quote.nominalCents,
    commissionCents: quote.commissionCents,
    coupleSplitCents: settlement.coupleSplitCents,
    coupleRecipientId: receiving.recipientReference,
    quoteExpiresAt: record.quoteSnapshot.expiresAt,
    pixExpiresAt: record.pixExpiresAt,
  });
}

export function createGiftCheckoutService(
  dependencies: GiftCheckoutServiceDependencies,
) {
  return {
    async createCheckout(
      siteId: unknown,
      input: unknown,
    ): Promise<GiftCheckoutCreateResult> {
      try {
        const site = giftQuoteSchema.shape.siteId.safeParse(siteId);
        // More than 6x is a clear 422, not a malformed request (D7).
        const requested =
          input && typeof input === "object" && "installments" in input
            ? input.installments
            : undefined;
        if (
          Number.isSafeInteger(requested) &&
          (requested as number) > GIFT_PLATFORM_TARIFFS.maxInstallments
        )
          return fail("INSTALLMENTS_UNAVAILABLE");
        const body = giftCheckoutCreateInputSchema.safeParse(input);
        if (!site.success || !body.success) return fail("QUOTE_INVALID");
        const tokenHash = createHash("sha256")
          .update(body.data.recoveryToken, "utf8")
          .digest();
        const existing = await dependencies.repository.findByRequest(
          site.data,
          body.data.requestId,
        );
        if (existing !== null) {
          authorizedRecord(
            existing,
            site.data,
            body.data.quoteId,
            body.data.requestId,
            tokenHash,
          );
          return createResult(existing);
        }
        const loaded = await dependencies.repository.findQuote(
          site.data,
          body.data.quoteId,
        );
        if (!loaded) return fail("QUOTE_INVALID");
        const quoteSnapshot = readGiftQuoteSnapshot(loaded);
        const quote = quoteSnapshot.quote;
        if (
          quoteSnapshot.receiving.provider !== GIFT_CHECKOUT_PROVIDER ||
          !isPlatformAccountSplit(quoteSnapshot) ||
          !quoteSnapshot.settlement
        )
          return fail("PROVIDER_UNAVAILABLE");
        if (
          quote.method !== body.data.method ||
          (quote.installmentCount ?? 1) !== body.data.installments
        )
          return fail("QUOTE_MISMATCH");
        const context = structuredClone(
          await dependencies.loadReceivingContext(site.data),
        );
        const gift = dependencies.findPublishedGift
          ? structuredClone(
              await dependencies.findPublishedGift(site.data, quote.giftId),
            )
          : undefined;
        assertEligible(
          quoteSnapshot,
          context,
          site.data,
          body.data.quoteId,
          clock(dependencies),
          dependencies.platformRecipientId,
          gift,
        );
        if (
          dependencies.revalidateQuote &&
          !(await dependencies.revalidateQuote(quoteSnapshot))
        )
          return fail("QUOTE_EXPIRED");
        const now = clock(dependencies);
        const reservation = freeze({
          siteId: site.data,
          quoteId: body.data.quoteId,
          requestId: body.data.requestId,
          orderId: dependencies.generateId("order"),
          attemptId: dependencies.generateId("attempt"),
          recoveryTokenHash: tokenHash.toString("hex"),
          quoteSnapshot,
          createdAt: now.toISOString(),
        });
        if (
          !giftQuoteSchema.shape.id.safeParse(reservation.orderId).success ||
          !giftQuoteSchema.shape.id.safeParse(reservation.attemptId).success
        )
          return fail("QUOTE_INVALID");
        let eligibilityChecked = false;
        const reserved = await dependencies.repository.reserve(
          reservation,
          (locked) => {
            const lockedSnapshot = readGiftQuoteSnapshot(locked.quoteSnapshot);
            if (
              !locked.gift ||
              JSON.stringify(lockedSnapshot) !== JSON.stringify(quoteSnapshot)
            )
              return fail("QUOTE_INVALID");
            assertEligible(
              lockedSnapshot,
              structuredClone(locked.receivingContext),
              site.data,
              body.data.quoteId,
              clock(dependencies),
              dependencies.platformRecipientId,
              structuredClone(locked.gift),
            );
            eligibilityChecked = true;
          },
        );
        const record = reserved.record;
        authorizedRecord(
          record,
          site.data,
          body.data.quoteId,
          body.data.requestId,
          tokenHash,
        );
        if (!reserved.created) return createResult(record);
        if (
          !eligibilityChecked ||
          record.state !== "CREATING" ||
          record.orderId !== reservation.orderId ||
          record.attemptId !== reservation.attemptId
        )
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        const identity = {
          siteId: record.siteId,
          requestId: record.requestId,
          quoteId: record.quoteId,
          orderId: record.orderId,
          attemptId: record.attemptId,
        };
        let order: PagarmeOrderObservation;
        try {
          const request = buildPagarmeOrderRequest({
            checkoutId: record.attemptId,
            giftId: quote.giftId,
            giftTitle: quote.title,
            method: quote.method,
            installments: quote.installmentCount ?? 1,
            totalCents: quote.totalCents,
            coupleSplitCents: quoteSnapshot.settlement.coupleSplitCents,
            ...(body.data.cardToken ? { cardToken: body.data.cardToken } : {}),
            quoteExpiresAt: new Date(quoteSnapshot.expiresAt),
            now: clock(dependencies),
            buyer: body.data.buyer,
            platformRecipientId: dependencies.platformRecipientId,
            coupleRecipientId: quoteSnapshot.receiving.recipientReference,
            splitMode: GIFT_PLATFORM_TARIFFS.couplesSplitMode,
          });
          order = await dependencies.orders.createOrder(request);
        } catch (error) {
          const observedAt = clock(dependencies).toISOString();
          if (
            error instanceof PagarmeRejectedError ||
            error instanceof RangeError
          ) {
            // 4xx (or a payload we refused to send): no order exists.
            await dependencies.repository
              .markProviderRejected(identity, observedAt)
              .catch(() => {});
            try {
              dependencies.observe?.({
                level: "warn",
                event: "gift_checkout.provider_rejected",
                siteId: record.siteId,
                checkoutId: record.attemptId,
                paymentMethod: quote.method,
                errorCode:
                  error instanceof PagarmeRejectedError
                    ? String(error.status)
                    : "PAYLOAD",
              });
            } catch {}
            return fail(
              quote.method === "PIX"
                ? "PIX_UNAVAILABLE"
                : "PAYMENT_METHOD_UNAVAILABLE",
            );
          }
          if (!(error instanceof PagarmeUnknownOutcomeError))
            throw new PagarmeUnknownOutcomeError("network");
          await dependencies.repository
            .markOutcomeUnknown(identity, observedAt)
            .catch(() => {});
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        }
        let saved = await dependencies.repository.saveOrder(
          identity,
          order,
          clock(dependencies).toISOString(),
        );
        authorizedRecord(
          saved,
          site.data,
          body.data.quoteId,
          body.data.requestId,
          tokenHash,
        );
        if (dependencies.applyOrder && order.status !== "pending") {
          try {
            const binding = await dependencies.repository.loadBinding({
              siteId: record.siteId,
              attemptId: record.attemptId,
            });
            if (binding) await dependencies.applyOrder(binding, order);
            saved =
              (await dependencies.repository.findByRequest(
                record.siteId,
                record.requestId,
              )) ?? saved;
          } catch {
            // The order.paid webhook and the reconciliation sweep post it.
          }
        }
        return createResult(saved);
      } catch (error) {
        return sanitized(error);
      }
    },

    async getStatus(
      siteId: unknown,
      input: unknown,
    ): Promise<GiftCheckoutStatus> {
      try {
        const site = giftQuoteSchema.shape.siteId.safeParse(siteId);
        const body = giftCheckoutStatusInputSchema.safeParse(input);
        if (!site.success || !body.success) return fail("QUOTE_INVALID");
        const tokenHash = createHash("sha256")
          .update(body.data.recoveryToken, "utf8")
          .digest();
        const record = await dependencies.repository.findByRequest(
          site.data,
          body.data.requestId,
        );
        if (!record) return fail("REQUEST_CONFLICT");
        authorizedRecord(
          record,
          site.data,
          body.data.quoteId,
          body.data.requestId,
          tokenHash,
        );
        return projectGiftCheckoutStatus(record);
      } catch (error) {
        return sanitized(error);
      }
    },
  };
}
