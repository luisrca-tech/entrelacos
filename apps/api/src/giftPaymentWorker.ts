import { giftQuoteSchema } from "@entrelacos/contracts";
import type { AsaasPaymentObservation } from "./asaasHttpClient";
import type {
  GiftPaymentInboxClaim,
  GiftPaymentInboxClaimResult,
  GiftPaymentInboxDeferReason,
  GiftPaymentInboxDeferResult,
} from "./giftPaymentInboxRepository";
import type { GiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import type { StoredGiftPaymentCheckoutBinding } from "./giftPaymentReconciliation";

export type GiftPaymentWorkerDeferralReason = GiftPaymentInboxDeferReason;

export interface GiftPaymentWorkerInboxPort {
  claimNextReceivedPayment(): Promise<GiftPaymentInboxClaimResult>;
  deferClaim(
    claim: GiftPaymentInboxClaim,
    reason: GiftPaymentWorkerDeferralReason,
  ): Promise<GiftPaymentInboxDeferResult>;
}

// Ports are selected by the server from persisted account/lease bindings.
// No default clients, browser evidence or scheduler are created by this worker.
export interface GiftPaymentWorkerOptions {
  environment: "sandbox" | "live";
  inbox: GiftPaymentWorkerInboxPort;
  loadCheckout(
    claim: GiftPaymentInboxClaim,
    observedCheckoutReference?: string,
  ): Promise<StoredGiftPaymentCheckoutBinding | null>;
  reader: {
    getPayment(claim: GiftPaymentInboxClaim): Promise<AsaasPaymentObservation>;
  };
  posting: GiftPaymentPostingRepository;
}

export interface GiftPaymentWorkerResult {
  kind:
    | "IDLE"
    | "DEAD_LETTER"
    | "POSTED"
    | "OBSERVED"
    | "DUPLICATE"
    | "NO_REGRESSION"
    | "RETRY"
    | "UNRESOLVED";
}

export interface GiftPaymentWorker {
  processNextReceivedPayment(): Promise<GiftPaymentWorkerResult>;
}

export class GiftPaymentWorkerServiceError extends Error {
  readonly status = 503;
  readonly code = "PAYMENT_WORKER_UNAVAILABLE";
  readonly title = "Payment worker is unavailable";

  constructor() {
    super("Payment worker is unavailable");
    this.name = "GiftPaymentWorkerServiceError";
  }
}

function unavailable(): never {
  throw new GiftPaymentWorkerServiceError();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return unavailable();
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const raw = record(value);
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unavailable();
  return raw;
}

function id(value: unknown): string {
  const parsed = giftQuoteSchema.shape.siteId.safeParse(value);
  if (!parsed.success) return unavailable();
  return parsed.data;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}

function readClaim(
  value: unknown,
  environment: GiftPaymentWorkerOptions["environment"],
): GiftPaymentInboxClaim {
  const raw = exactRecord(value, [
    "eventId",
    "siteId",
    "accountId",
    "environment",
    "leaseOwner",
    "leaseToken",
    "paymentReference",
    "providerAccountReference",
    "attempts",
  ]);
  if (
    raw.environment !== environment ||
    typeof raw.attempts !== "number" ||
    !Number.isSafeInteger(raw.attempts) ||
    raw.attempts < 1
  )
    return unavailable();
  return Object.freeze({
    eventId: id(raw.eventId),
    siteId: id(raw.siteId),
    accountId: id(raw.accountId),
    environment,
    leaseOwner: id(raw.leaseOwner),
    leaseToken: id(raw.leaseToken),
    paymentReference: reference(raw.paymentReference),
    providerAccountReference: reference(raw.providerAccountReference),
    attempts: raw.attempts,
  });
}

function readCheckout(
  value: unknown,
  claim: GiftPaymentInboxClaim,
): StoredGiftPaymentCheckoutBinding {
  const raw = exactRecord(value, [
    "siteId",
    "accountId",
    "environment",
    "orderId",
    "attemptId",
    "providerCheckoutReference",
    "accountReference",
  ]);
  if (
    raw.siteId !== claim.siteId ||
    raw.accountId !== claim.accountId ||
    raw.environment !== claim.environment ||
    raw.accountReference !== claim.providerAccountReference
  )
    return unavailable();
  return Object.freeze({
    siteId: id(raw.siteId),
    accountId: id(raw.accountId),
    environment: claim.environment,
    orderId: id(raw.orderId),
    attemptId: id(raw.attemptId),
    providerCheckoutReference: reference(raw.providerCheckoutReference),
    accountReference: reference(raw.accountReference),
  });
}

function readObservation(
  value: unknown,
  claim: GiftPaymentInboxClaim,
  checkout?: StoredGiftPaymentCheckoutBinding,
): AsaasPaymentObservation {
  const copy: unknown = structuredClone(value);
  const raw = exactRecord(copy, [
    "source",
    "provider",
    "siteId",
    "accountReference",
    "environment",
    "currency",
    "observedAt",
    "payment",
  ]);
  const payment = record(raw.payment);
  if (
    raw.source !== "provider" ||
    raw.provider !== "ASAAS" ||
    raw.siteId !== claim.siteId ||
    raw.accountReference !== claim.providerAccountReference ||
    raw.environment !== claim.environment ||
    raw.currency !== "BRL" ||
    !(raw.observedAt instanceof Date) ||
    !Number.isFinite(raw.observedAt.getTime()) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(raw.observedAt.toISOString())
      .success ||
    reference(payment.id) !== claim.paymentReference ||
    !reference(payment.checkoutSession) ||
    (checkout !== undefined &&
      payment.checkoutSession !== checkout.providerCheckoutReference) ||
    (payment.externalReference !== undefined &&
      payment.externalReference !== null &&
      (!id(payment.externalReference) ||
        (checkout !== undefined &&
          payment.externalReference !== checkout.attemptId))) ||
    (payment.currency !== undefined && payment.currency !== "BRL")
  )
    return unavailable();
  // Posting owns money/status reconciliation and atomic lease/commit checks. In
  // particular, a received event does not mask a newer refund or pending split.
  return copy as AsaasPaymentObservation;
}

function postingOutcome(value: unknown): GiftPaymentWorkerResult {
  const raw = exactRecord(value, ["outcome", "paymentId", "ledgerEntryId"]);
  if (raw.paymentId !== null) id(raw.paymentId);
  if (raw.ledgerEntryId !== null) id(raw.ledgerEntryId);
  if (
    raw.outcome !== "POSTED" &&
    raw.outcome !== "OBSERVED" &&
    raw.outcome !== "DUPLICATE" &&
    raw.outcome !== "NO_REGRESSION"
  )
    return unavailable();
  return { kind: raw.outcome };
}

export function createGiftPaymentWorker(
  options: GiftPaymentWorkerOptions,
): GiftPaymentWorker {
  try {
    const environment = options.environment;
    if (
      (environment !== "sandbox" && environment !== "live") ||
      typeof options.inbox?.claimNextReceivedPayment !== "function" ||
      typeof options.inbox?.deferClaim !== "function" ||
      typeof options.loadCheckout !== "function" ||
      typeof options.reader?.getPayment !== "function" ||
      typeof options.posting?.postReceivedPayment !== "function"
    )
      return unavailable();
    const claimNextReceivedPayment =
      options.inbox.claimNextReceivedPayment.bind(options.inbox);
    const deferClaim = options.inbox.deferClaim.bind(options.inbox);
    const loadCheckout = options.loadCheckout.bind(options);
    const getPayment = options.reader.getPayment.bind(options.reader);
    const postReceivedPayment = options.posting.postReceivedPayment.bind(
      options.posting,
    );

    async function defer(
      claim: GiftPaymentInboxClaim,
      reason: GiftPaymentWorkerDeferralReason,
    ): Promise<GiftPaymentWorkerResult> {
      try {
        const result = exactRecord(await deferClaim(claim, reason), ["kind"]);
        if (result.kind !== "RETRY" && result.kind !== "DEAD_LETTER")
          return { kind: "UNRESOLVED" };
        return { kind: result.kind };
      } catch {
        // A failed or lost defer acknowledgment never proves a durable retry.
        return { kind: "UNRESOLVED" };
      }
    }

    return {
      async processNextReceivedPayment() {
        let claim: GiftPaymentInboxClaim;
        try {
          const result = await claimNextReceivedPayment();
          if (result === null) return { kind: "IDLE" };
          const raw = record(result);
          if (raw.kind === "DEAD_LETTER") {
            const result = exactRecord(raw, ["kind", "eventId", "errorCode"]);
            id(result.eventId);
            if (
              result.errorCode !== "FINANCIAL_ATTEMPT_LIMIT" &&
              result.errorCode !== "PAYMENT_CORRELATION_INVALID"
            )
              return unavailable();
            return { kind: "DEAD_LETTER" };
          }
          const claimed = exactRecord(raw, ["kind", "claim"]);
          if (claimed.kind !== "CLAIMED") return unavailable();
          claim = readClaim(claimed.claim, environment);
        } catch {
          return unavailable();
        }
        let checkout: StoredGiftPaymentCheckoutBinding | null;
        try {
          const stored = await loadCheckout(claim);
          checkout = stored === null ? null : readCheckout(stored, claim);
        } catch {
          return defer(claim, "CHECKOUT_BINDING_UNAVAILABLE");
        }
        let observation: AsaasPaymentObservation;
        try {
          observation = readObservation(
            await getPayment(claim),
            claim,
            checkout ?? undefined,
          );
        } catch {
          return defer(claim, "PROVIDER_READ_UNAVAILABLE");
        }
        if (checkout === null) {
          // Hosted payments can omit externalReference; recheck the lease and
          // stored checkout using the session returned by the scoped provider GET.
          try {
            checkout = readCheckout(
              await loadCheckout(
                claim,
                reference(observation.payment.checkoutSession),
              ),
              claim,
            );
          } catch {
            return defer(claim, "CHECKOUT_BINDING_UNAVAILABLE");
          }
          try {
            observation = readObservation(observation, claim, checkout);
          } catch {
            return defer(claim, "PROVIDER_READ_UNAVAILABLE");
          }
        }
        try {
          return postingOutcome(
            await postReceivedPayment({
              claim: {
                eventId: claim.eventId,
                siteId: claim.siteId,
                accountId: claim.accountId,
                environment: claim.environment,
                leaseOwner: claim.leaseOwner,
                leaseToken: claim.leaseToken,
              },
              checkout,
              observation,
            }),
          );
        } catch {
          return defer(claim, "PAYMENT_POSTING_UNAVAILABLE");
        }
      },
    };
  } catch {
    return unavailable();
  }
}
