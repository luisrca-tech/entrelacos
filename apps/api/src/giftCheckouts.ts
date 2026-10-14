import { createHash, timingSafeEqual } from "node:crypto";
import {
  type CheckoutResult,
  type CheckoutStatus,
  checkoutCreateInputSchema,
  checkoutResultSchema,
  checkoutStatusInputSchema,
  checkoutStatusSchema,
  giftQuoteSchema,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import { quoteGiftAmounts } from "./giftMoney";
import type {
  GiftQuoteReceivingContext,
  GiftQuoteSnapshot,
  StoredGiftForQuote,
} from "./giftQuotes";
import {
  assertReceivingReady,
  evaluateReceivingReadiness,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";

export interface GiftCheckoutIdentity {
  siteId: string;
  quoteId: string;
  requestId: string;
  orderId: string;
  attemptId: string;
}

// Provider evidence and money states require verified observations and posted ledger rows.
// A durable backend seal can prove that a request never dispatched. Request bodies
// never supply either proof; the repository must enforce their references atomically.
interface GiftCheckoutEvidenceBinding {
  source: "provider";
  siteId: string;
  orderId: string;
  attemptId: string;
  provider: string;
  accountReference: string;
  environment: "sandbox" | "live";
  providerCheckoutReference: string;
  observedAt: string;
}

export type GiftCheckoutEvidence =
  | (GiftCheckoutEvidenceBinding &
      (
        | { kind: "HOSTED_CHECKOUT" }
        | {
            kind: "SETTLEMENT";
            providerPaymentReference: string;
            ledgerEntryId: string;
          }
        | {
            kind: "CLOSED_UNPAID";
            noOutstandingPayment: true;
            closedReason: NonNullable<CheckoutStatus["closedReason"]>;
          }
        | {
            kind: "REFUND";
            providerPaymentReference: string;
            providerRefundReference: string;
            ledgerEntryId: string;
          }
      ))
  | (GiftCheckoutIdentity & {
      source: "backend";
      kind: "PRE_DISPATCH_REJECTION";
      recoveryTokenHash: string;
      observedAt: string;
      noProviderCall: true;
      closedReason: "EXPIRED" | "CANCELED";
      providerCheckoutReference?: never;
    });

export interface GiftCheckoutReservation extends GiftCheckoutIdentity {
  recoveryTokenHash: string;
  quoteSnapshot: GiftQuoteSnapshot;
  createdAt: string;
}

export interface GiftCheckoutRecord extends GiftCheckoutReservation {
  state: CheckoutStatus["state"];
  observedAt: string | null;
  closedReason: CheckoutStatus["closedReason"];
  checkout: CheckoutResult | null;
  evidence: GiftCheckoutEvidence | null;
}

export interface GiftCheckoutEligibility {
  quoteSnapshot: GiftQuoteSnapshot;
  receivingContext: GiftQuoteReceivingContext | null;
  gift: StoredGiftForQuote | null;
}

export interface GiftHostedCheckout {
  providerReference: string;
  checkout: CheckoutResult;
}

export interface GiftCheckoutHostedOutcome
  extends GiftCheckoutIdentity,
    GiftHostedCheckout {
  observedAt: string;
}

export interface GiftCheckoutProviderCommand
  extends Omit<GiftCheckoutIdentity, "quoteId"> {
  quoteSnapshot: GiftQuoteSnapshot;
}

export interface GiftCheckoutRepository {
  findByRequest(
    siteId: string,
    requestId: string,
  ): Promise<GiftCheckoutRecord | null>;
  findQuote(siteId: string, quoteId: string): Promise<GiftQuoteSnapshot | null>;
  // Under the same locks as reserve, return an existing commitment or persist a
  // never-dispatched cancellation. Every later reserve must return that sealed row.
  // A missing row alone is not evidence that an in-flight request cannot dispatch.
  sealUncreatedRequest(
    reservation: GiftCheckoutReservation,
  ): Promise<GiftCheckoutRecord>;
  // Atomically enforce unique(site, request), one order per quote, immutable hash/snapshot,
  // and a single creator. Run this callback with locked, freshly read stored eligibility
  // before insertion; losers return the existing row. Never call the PSP in this transaction.
  reserve(
    reservation: GiftCheckoutReservation,
    assertLockedEligibility: (eligibility: GiftCheckoutEligibility) => void,
  ): Promise<{ created: boolean; record: GiftCheckoutRecord }>;
  // Persist creation evidence with a compare-and-set; never overwrite terminal evidence.
  saveHostedCheckout(
    outcome: GiftCheckoutHostedOutcome,
  ): Promise<GiftCheckoutRecord>;
  // Keep the commitment; only CREATING may become UNKNOWN, with no terminal regression.
  markOutcomeUnknown(
    identity: GiftCheckoutIdentity,
    observedAt: string,
  ): Promise<void>;
}

export interface GiftCheckoutServiceDependencies {
  repository: GiftCheckoutRepository;
  loadReceivingContext(
    siteId: string,
  ): Promise<GiftQuoteReceivingContext | null>;
  findPublishedGift?(
    siteId: string,
    giftId: string,
  ): Promise<StoredGiftForQuote | null>;
  createHostedCheckout(
    command: GiftCheckoutProviderCommand,
  ): Promise<GiftHostedCheckout>;
  now(): Date;
  generateId(kind: "order" | "attempt"): string;
}

type CheckoutErrorCode =
  | "QUOTE_INVALID"
  | "QUOTE_EXPIRED"
  | "REQUEST_CONFLICT"
  | "EXTERNAL_OUTCOME_UNKNOWN";

export class GiftCheckoutServiceError extends Error {
  readonly status: 400 | 409;
  readonly title: string;

  constructor(readonly code: CheckoutErrorCode) {
    const title = {
      QUOTE_INVALID: "Gift checkout input is invalid",
      QUOTE_EXPIRED: "Gift quote has expired",
      REQUEST_CONFLICT: "Gift checkout request is unavailable",
      EXTERNAL_OUTCOME_UNKNOWN: "Gift checkout outcome is unresolved",
    }[code];
    super(title);
    this.name = "GiftCheckoutServiceError";
    this.title = title;
    this.status = code === "QUOTE_INVALID" ? 400 : 409;
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
    !sameBinding(binding, pricing) ||
    pricing.verification !== "verified" ||
    !["provider", "local-test"].includes(pricing.provenance) ||
    (binding.environment === "live" && pricing.provenance !== "provider") ||
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
  const amounts = quoteGiftAmounts({
    nominalCents: quote.data.nominalCents,
    method: quote.data.method,
    policy: pricing.policy,
  });
  if (
    Object.entries(amounts).some(
      ([key, amount]) => quote.data[key as keyof typeof amounts] !== amount,
    )
  )
    return fail("QUOTE_INVALID");
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
      },
    },
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  });
}

function readRecord(loaded: GiftCheckoutRecord): GiftCheckoutRecord {
  try {
    const value = structuredClone(loaded);
    value.quoteSnapshot = readGiftQuoteSnapshot(value.quoteSnapshot);
    if (value.checkout !== null)
      value.checkout = checkoutResultSchema.parse(value.checkout);
    if (
      value.quoteSnapshot.quote.id !== value.quoteId ||
      value.quoteSnapshot.quote.siteId !== value.siteId ||
      !checkoutResultSchema.shape.orderId.safeParse(value.orderId).success ||
      !checkoutResultSchema.shape.attemptId.safeParse(value.attemptId)
        .success ||
      !giftQuoteSchema.shape.expiresAt.safeParse(value.createdAt).success
    )
      return fail("EXTERNAL_OUTCOME_UNKNOWN");
    return value;
  } catch {
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  }
}

function projectStatus(record: GiftCheckoutRecord, now: Date): CheckoutStatus {
  const result = checkoutStatusSchema.safeParse({
    siteId: record.siteId,
    quoteId: record.quoteId,
    requestId: record.requestId,
    orderId: record.orderId,
    attemptId: record.attemptId,
    method: record.quoteSnapshot.quote.method,
    mode: record.quoteSnapshot.quote.mode,
    state: record.state,
    observedAt: record.observedAt,
    closedReason: record.closedReason,
    mayStartNewAttempt: record.state === "CLOSED_UNPAID",
    checkout: record.checkout,
  });
  if (!result.success) return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (
    record.observedAt !== null &&
    Date.parse(record.observedAt) > now.getTime()
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const evidence = record.evidence;
  if (record.state === "CREATING" || record.state === "OUTCOME_UNKNOWN") {
    if (evidence !== null) return fail("EXTERNAL_OUTCOME_UNKNOWN");
    return result.data;
  }
  if (evidence?.source === "backend") {
    const expectedReason =
      Date.parse(record.quoteSnapshot.expiresAt) <= Date.parse(record.createdAt)
        ? "EXPIRED"
        : "CANCELED";
    if (
      record.state !== "CLOSED_UNPAID" ||
      record.checkout !== null ||
      evidence.kind !== "PRE_DISPATCH_REJECTION" ||
      evidence.noProviderCall !== true ||
      evidence.siteId !== record.siteId ||
      evidence.quoteId !== record.quoteId ||
      evidence.requestId !== record.requestId ||
      evidence.orderId !== record.orderId ||
      evidence.attemptId !== record.attemptId ||
      evidence.recoveryTokenHash !== record.recoveryTokenHash ||
      evidence.observedAt !== record.observedAt ||
      record.observedAt !== record.createdAt ||
      evidence.closedReason !== record.closedReason ||
      record.closedReason !== expectedReason ||
      evidence.providerCheckoutReference !== undefined ||
      Date.parse(record.createdAt) < Date.parse(record.quoteSnapshot.createdAt)
    )
      return fail("EXTERNAL_OUTCOME_UNKNOWN");
    return result.data;
  }
  const binding = record.quoteSnapshot.receiving;
  if (
    evidence?.source !== "provider" ||
    evidence.siteId !== record.siteId ||
    evidence.orderId !== record.orderId ||
    evidence.attemptId !== record.attemptId ||
    evidence.provider !== binding.provider ||
    evidence.accountReference !== binding.accountReference ||
    evidence.environment !== binding.environment ||
    evidence.observedAt !== record.observedAt ||
    !nonempty(evidence.providerCheckoutReference)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (
    record.state === "AWAITING_PAYMENT" &&
    evidence.kind !== "HOSTED_CHECKOUT"
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (
    record.state === "RECEIVED" &&
    (evidence.kind !== "SETTLEMENT" ||
      !nonempty(evidence.providerPaymentReference) ||
      !checkoutResultSchema.shape.orderId.safeParse(evidence.ledgerEntryId)
        .success)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (
    record.state === "CLOSED_UNPAID" &&
    (evidence.kind !== "CLOSED_UNPAID" ||
      evidence.noOutstandingPayment !== true ||
      evidence.closedReason !== record.closedReason)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (
    record.state === "REFUNDED" &&
    (evidence.kind !== "REFUND" ||
      !nonempty(evidence.providerPaymentReference) ||
      !nonempty(evidence.providerRefundReference) ||
      !checkoutResultSchema.shape.orderId.safeParse(evidence.ledgerEntryId)
        .success)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return result.data;
}

export function isSafeCheckoutContinuation(
  hostedUrl: string,
  recoveryToken: string,
): boolean {
  try {
    if (hostedUrl.length > 2048) return false;
    const protectedValues = [
      recoveryToken,
      createHash("sha256").update(recoveryToken, "utf8").digest("hex"),
    ];
    let value = hostedUrl;
    for (let depth = 0; depth < 4; depth++) {
      if (protectedValues.some((secret) => value.includes(secret)))
        return false;
      const decoded = decodeURIComponent(value);
      if (decoded === value) return true;
      value = decoded;
    }
    return false;
  } catch {
    return false;
  }
}

function continuation(
  record: GiftCheckoutRecord,
  now: Date,
  recoveryToken: string,
): CheckoutResult {
  const status = projectStatus(record, now);
  if (
    status.checkout &&
    !isSafeCheckoutContinuation(status.checkout.hostedUrl, recoveryToken)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  if (status.state === "AWAITING_PAYMENT" && status.checkout)
    return status.checkout;
  if (status.state === "CREATING" || status.state === "OUTCOME_UNKNOWN") {
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  }
  return fail("REQUEST_CONFLICT");
}

function assertEligible(
  snapshot: GiftQuoteSnapshot,
  context: GiftQuoteReceivingContext | null,
  siteId: string,
  quoteId: string,
  now: Date,
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
  if (
    !sameBinding(snapshot.receiving, context.providerBinding) ||
    context.mode !== quote.data.mode
  )
    throw new ReceivingReadinessServiceError();
  if (
    snapshot.pricing.provenance === "local-test" &&
    (!context.isDemo ||
      context.environment === "production" ||
      quote.data.mode !== "sandbox")
  )
    return fail("QUOTE_INVALID");
  if (
    gift !== undefined &&
    (gift?.publicationState !== "PUBLISHED" ||
      gift.siteActive !== true ||
      gift.gift.id !== quote.data.giftId ||
      gift.gift.siteId !== siteId)
  )
    return fail("QUOTE_INVALID");
}

export function createGiftCheckoutService(
  dependencies: GiftCheckoutServiceDependencies,
) {
  return {
    async createCheckout(
      siteId: unknown,
      input: unknown,
    ): Promise<CheckoutResult> {
      try {
        const site = giftQuoteSchema.shape.siteId.safeParse(siteId);
        const body = checkoutCreateInputSchema.safeParse(input);
        if (!site.success || !body.success) return fail("QUOTE_INVALID");
        const tokenHash = createHash("sha256")
          .update(body.data.recoveryToken, "utf8")
          .digest();
        const existing = await dependencies.repository.findByRequest(
          site.data,
          body.data.requestId,
        );
        if (existing !== null) {
          const record = readRecord(existing);
          authorizedRecord(
            record,
            site.data,
            body.data.quoteId,
            body.data.requestId,
            tokenHash,
          );
          return continuation(
            record,
            clock(dependencies),
            body.data.recoveryToken,
          );
        }
        const loaded = await dependencies.repository.findQuote(
          site.data,
          body.data.quoteId,
        );
        if (!loaded) return fail("QUOTE_INVALID");
        const quoteSnapshot = readGiftQuoteSnapshot(loaded);
        const context = structuredClone(
          await dependencies.loadReceivingContext(site.data),
        );
        const gift = dependencies.findPublishedGift
          ? structuredClone(
              await dependencies.findPublishedGift(
                site.data,
                quoteSnapshot.quote.giftId,
              ),
            )
          : undefined;
        const now = clock(dependencies);
        assertEligible(
          quoteSnapshot,
          context,
          site.data,
          body.data.quoteId,
          now,
          gift,
        );
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
          !checkoutResultSchema.shape.orderId.safeParse(reservation.orderId)
            .success ||
          !checkoutResultSchema.shape.attemptId.safeParse(reservation.attemptId)
            .success
        )
          return fail("QUOTE_INVALID");
        let lockedContext: GiftQuoteReceivingContext | null = null;
        let eligibilityChecked = false;
        const reserved = await dependencies.repository.reserve(
          reservation,
          (locked) => {
            lockedContext = structuredClone(locked.receivingContext);
            const lockedSnapshot = readGiftQuoteSnapshot(locked.quoteSnapshot);
            if (
              !locked.gift ||
              JSON.stringify(lockedSnapshot) !== JSON.stringify(quoteSnapshot)
            )
              return fail("QUOTE_INVALID");
            assertEligible(
              lockedSnapshot,
              lockedContext,
              site.data,
              body.data.quoteId,
              clock(dependencies),
              structuredClone(locked.gift),
            );
            eligibilityChecked = true;
          },
        );
        const record = readRecord(reserved.record);
        authorizedRecord(
          record,
          site.data,
          body.data.quoteId,
          body.data.requestId,
          tokenHash,
        );
        if (typeof reserved.created !== "boolean")
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        if (!reserved.created)
          return continuation(
            record,
            clock(dependencies),
            body.data.recoveryToken,
          );
        if (
          !eligibilityChecked ||
          record.state !== "CREATING" ||
          record.orderId !== reservation.orderId ||
          record.attemptId !== reservation.attemptId ||
          record.createdAt !== reservation.createdAt ||
          JSON.stringify(record.quoteSnapshot) !== JSON.stringify(quoteSnapshot)
        )
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        projectStatus(record, clock(dependencies));
        try {
          assertEligible(
            record.quoteSnapshot,
            lockedContext,
            site.data,
            body.data.quoteId,
            clock(dependencies),
          );
          const command = freeze({
            siteId: record.siteId,
            requestId: record.requestId,
            orderId: record.orderId,
            attemptId: record.attemptId,
            quoteSnapshot: record.quoteSnapshot,
          });
          const hosted = structuredClone(
            await dependencies.createHostedCheckout(command),
          );
          const parsedCheckout = checkoutResultSchema.safeParse(
            hosted.checkout,
          );
          if (!parsedCheckout.success || !nonempty(hosted.providerReference))
            return fail("EXTERNAL_OUTCOME_UNKNOWN");
          const checkout = parsedCheckout.data;
          if (
            checkout.orderId !== record.orderId ||
            checkout.attemptId !== record.attemptId ||
            checkout.quoteId !== record.quoteId ||
            checkout.method !== record.quoteSnapshot.quote.method ||
            checkout.mode !== record.quoteSnapshot.quote.mode ||
            !isSafeCheckoutContinuation(
              checkout.hostedUrl,
              body.data.recoveryToken,
            )
          )
            return fail("EXTERNAL_OUTCOME_UNKNOWN");
          const saved = await dependencies.repository.saveHostedCheckout({
            siteId: record.siteId,
            quoteId: record.quoteId,
            requestId: record.requestId,
            orderId: record.orderId,
            attemptId: record.attemptId,
            providerReference: hosted.providerReference,
            checkout,
            observedAt: clock(dependencies).toISOString(),
          });
          const confirmed = readRecord(saved);
          authorizedRecord(
            confirmed,
            site.data,
            body.data.quoteId,
            body.data.requestId,
            tokenHash,
          );
          if (
            confirmed.orderId !== record.orderId ||
            confirmed.attemptId !== record.attemptId ||
            JSON.stringify(confirmed.quoteSnapshot) !==
              JSON.stringify(record.quoteSnapshot) ||
            confirmed.evidence?.providerCheckoutReference !==
              hosted.providerReference ||
            (confirmed.state === "AWAITING_PAYMENT" &&
              JSON.stringify(confirmed.checkout) !== JSON.stringify(checkout))
          )
            return fail("EXTERNAL_OUTCOME_UNKNOWN");
          return continuation(
            confirmed,
            clock(dependencies),
            body.data.recoveryToken,
          );
        } catch {
          let observedAt = record.createdAt;
          try {
            observedAt = clock(dependencies).toISOString();
          } catch {}
          await dependencies.repository
            .markOutcomeUnknown(
              {
                siteId: record.siteId,
                requestId: record.requestId,
                quoteId: record.quoteId,
                orderId: record.orderId,
                attemptId: record.attemptId,
              },
              observedAt,
            )
            .catch(() => {});
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        }
      } catch (error) {
        return sanitized(error);
      }
    },

    async getStatus(siteId: unknown, input: unknown): Promise<CheckoutStatus> {
      try {
        const site = giftQuoteSchema.shape.siteId.safeParse(siteId);
        const body = checkoutStatusInputSchema.safeParse(input);
        if (!site.success || !body.success) return fail("QUOTE_INVALID");
        const tokenHash = createHash("sha256")
          .update(body.data.recoveryToken, "utf8")
          .digest();
        let loaded = await dependencies.repository.findByRequest(
          site.data,
          body.data.requestId,
        );
        if (!loaded) {
          const quote = await dependencies.repository.findQuote(
            site.data,
            body.data.quoteId,
          );
          if (!quote) return fail("REQUEST_CONFLICT");
          const quoteSnapshot = readGiftQuoteSnapshot(quote);
          const now = clock(dependencies);
          if (
            quoteSnapshot.quote.siteId !== site.data ||
            quoteSnapshot.quote.id !== body.data.quoteId ||
            Date.parse(quoteSnapshot.createdAt) > now.getTime()
          )
            return fail("REQUEST_CONFLICT");
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
            !checkoutResultSchema.shape.orderId.safeParse(reservation.orderId)
              .success ||
            !checkoutResultSchema.shape.attemptId.safeParse(
              reservation.attemptId,
            ).success
          )
            return fail("QUOTE_INVALID");
          loaded =
            await dependencies.repository.sealUncreatedRequest(reservation);
        }
        const record = readRecord(loaded);
        authorizedRecord(
          record,
          site.data,
          body.data.quoteId,
          body.data.requestId,
          tokenHash,
        );
        const status = projectStatus(record, clock(dependencies));
        if (
          status.checkout &&
          !isSafeCheckoutContinuation(
            status.checkout.hostedUrl,
            body.data.recoveryToken,
          )
        )
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        return status;
      } catch (error) {
        return sanitized(error);
      }
    },
  };
}
