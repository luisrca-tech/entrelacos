import { createHash } from "node:crypto";
import {
  allocateGiftInstallmentCents,
  type GiftQuote,
  giftQuoteSchema,
} from "@entrelacos/contracts";
import { parseBrlCents } from "./giftMoney";
import { type GiftQuoteSnapshot, readGiftV2Settlement } from "./giftQuotes";

/** Payment events the receipt worker claims for every settlement version. */
export const giftPaymentInboxEvents = [
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_SPLIT_DONE",
] as const;

/** Platform-account (V2) events the receipt worker also claims for V2 attempts. */
export const giftPaymentV2OnlyInboxEvents = [
  "PAYMENT_ANTICIPATED",
  "PAYMENT_SPLIT_CANCELLED",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
  "RECEIVABLE_ANTICIPATION_CREDITED",
  "RECEIVABLE_ANTICIPATION_DENIED",
  "RECEIVABLE_ANTICIPATION_CANCELLED",
] as const;

export interface StoredGiftPaymentCheckoutBinding {
  siteId: string;
  accountId: string;
  orderId: string;
  attemptId: string;
  providerCheckoutReference: string;
  accountReference: string;
  environment: "sandbox" | "live";
}

// This port receives authenticated server fetch results, never browser claims.
// The future adapter must establish credential/account/environment binding first.
export interface GiftProviderPaymentObservation {
  source: "provider";
  provider: "ASAAS";
  siteId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  currency: "BRL";
  observedAt: Date;
  payment: unknown;
}

// Loaded from verified persisted state; a reversal requires separate authoritative proof.
export interface GiftPaymentTerminalEvidence {
  providerPaymentReference: string;
  state: "REFUNDED" | "DISPUTED" | "CANCELLED";
  observedAt: Date;
}

export interface GiftPaymentReconciliationInput {
  quoteSnapshot: GiftQuoteSnapshot;
  checkout: StoredGiftPaymentCheckoutBinding;
  platformWalletId: string;
  observation: GiftProviderPaymentObservation;
  now: Date;
  existingTerminal?: GiftPaymentTerminalEvidence;
}

export interface ObservedGiftPaymentRecord {
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  orderId: string;
  attemptId: string;
  providerPaymentReference: string;
  providerStatus: string;
  // VERIFIED describes the trusted observation; outcome/effect determine receipt.
  verificationStatus: "VERIFIED";
  observedAt: Date;
  currency: "BRL";
  grossCents: number;
  processingCents: number | null;
  commissionCents: number | null;
  recipientNetCents: number | null;
  splitProviderReference: string | null;
  splitFixedCents: number | null;
  providerInstallmentReference?: string;
  installmentNumber?: number;
}

export interface GiftReceiptEffect {
  effectKey: string;
  kind: "GIFT_RECEIVED";
  direction: "CREDIT";
  currency: "BRL";
  amountCents: number;
}

export type GiftPaymentReconciliationResult =
  | {
      outcome: "RECEIVED";
      reason: null;
      payment: ObservedGiftPaymentRecord;
      effect: GiftReceiptEffect;
      platformAdjustmentCents?: number;
    }
  | {
      outcome: "NOT_RECEIVED" | "SPLIT_PENDING" | "DIVERGENT";
      reason:
        | "PAYMENT_NOT_RECEIVED"
        | "PAYMENT_RESTRICTED"
        | "SPLIT_NOT_SETTLED"
        | "SPLIT_MISMATCH"
        | "ALLOCATION_MISMATCH";
      payment: ObservedGiftPaymentRecord;
      effect: null;
    }
  | {
      outcome: "NO_REGRESSION";
      reason: "TERMINAL_PAYMENT";
      payment: null;
      effect: null;
    };

export class GiftPaymentReconciliationServiceError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code:
      | "PAYMENT_OBSERVATION_INVALID"
      | "PAYMENT_BINDING_MISMATCH"
      | "PAYMENT_QUOTE_INVALID",
  ) {
    super("Payment observation cannot be reconciled");
    this.name = "GiftPaymentReconciliationServiceError";
  }
}

function invalid(): never {
  throw new GiftPaymentReconciliationServiceError(
    400,
    "PAYMENT_OBSERVATION_INVALID",
  );
}

function bindingMismatch(): never {
  throw new GiftPaymentReconciliationServiceError(
    409,
    "PAYMENT_BINDING_MISMATCH",
  );
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function localId(value: unknown): boolean {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}

function providerStatus(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value))
    return invalid();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (!isReference(value)) return invalid();
  return value;
}

function cents(value: unknown): number {
  if (
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    return invalid();
  if (String(value).length > 32 || Object.is(value, -0)) return invalid();
  return parseBrlCents(String(value));
}

function observationTime(value: Date, now: Date): number {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  const current = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(time) || !Number.isFinite(current) || time > current)
    return invalid();
  return time;
}

// This namespace matches the checkout SQL repository's canonical payment effect.
export function giftReceivedEffectKey(
  providerPaymentReference: string,
): string {
  return `GIFT_RECEIVED:${createHash("sha256").update(reference(providerPaymentReference), "utf8").digest("hex")}`;
}

export function isGiftReceiptEvent(eventType: unknown): boolean {
  return eventType === "PAYMENT_RECEIVED" || eventType === "PAYMENT_SPLIT_DONE";
}

export function giftPaymentTerms(
  quote: Pick<GiftQuote, "totalCents" | "nominalCents" | "commissionCents"> & {
    installmentCount?: number;
    installmentCents?: number[];
  },
  installmentNumber: unknown,
): {
  grossCents: number;
  nominalCents: number;
  commissionCents: number;
} | null {
  const count = quote.installmentCount ?? 1;
  const { totalCents, nominalCents, commissionCents } = quote;
  if (count === 1)
    return installmentNumber == null
      ? { grossCents: totalCents, nominalCents, commissionCents }
      : null;
  if (
    typeof installmentNumber !== "number" ||
    !Number.isInteger(installmentNumber) ||
    installmentNumber < 1 ||
    installmentNumber > count
  )
    return null;
  // Asaas distributes a fixed total across the plan and applies rounding to its last charge.
  const share = (amount: number) =>
    allocateGiftInstallmentCents(amount, count)[installmentNumber - 1];
  const grossCents = quote.installmentCents?.[installmentNumber - 1];
  return grossCents === undefined
    ? null
    : {
        grossCents,
        nominalCents: share(nominalCents),
        commissionCents: share(commissionCents),
      };
}

export function reconcileGiftPaymentObservation(
  input: GiftPaymentReconciliationInput,
): GiftPaymentReconciliationResult {
  try {
    const quoted = giftQuoteSchema.safeParse(input.quoteSnapshot.quote);
    const created = giftQuoteSchema.shape.expiresAt.safeParse(
      input.quoteSnapshot.createdAt,
    );
    if (!quoted.success || !created.success)
      throw new GiftPaymentReconciliationServiceError(
        409,
        "PAYMENT_QUOTE_INVALID",
      );
    const quote = quoted.data;
    const binding = input.checkout;
    const receiving = input.quoteSnapshot.receiving;
    const observation = input.observation;
    if (
      ![
        binding.siteId,
        binding.accountId,
        binding.orderId,
        binding.attemptId,
      ].every(localId) ||
      ![
        binding.providerCheckoutReference,
        binding.accountReference,
        input.platformWalletId,
      ].every(isReference) ||
      (binding.environment !== "sandbox" && binding.environment !== "live") ||
      quote.siteId !== binding.siteId ||
      quote.mode !== binding.environment ||
      receiving.siteId !== binding.siteId ||
      receiving.environment !== binding.environment ||
      receiving.provider !== "ASAAS" ||
      receiving.accountReference !== binding.accountReference ||
      !isReference(receiving.recipientReference) ||
      input.platformWalletId === receiving.recipientReference ||
      observation.source !== "provider" ||
      observation.provider !== "ASAAS" ||
      observation.currency !== "BRL" ||
      observation.siteId !== binding.siteId ||
      observation.accountReference !== binding.accountReference ||
      observation.environment !== binding.environment
    )
      return bindingMismatch();
    const observed = observationTime(observation.observedAt, input.now);
    if (observed < new Date(created.data).getTime()) return invalid();
    const raw = record(input.observation.payment);
    const paymentReference = reference(raw.id);
    const status = providerStatus(raw.status);
    const installmentCount = quote.installmentCount ?? 1;
    const installment =
      installmentCount > 1 ? reference(raw.installment) : null;
    const installmentNumber =
      installmentCount > 1 ? raw.installmentNumber : null;
    const terms = giftPaymentTerms(quote, installmentNumber);
    if (
      !terms ||
      (quote.settlementVersion !== undefined &&
        installment === null &&
        raw.installmentNumber != null &&
        raw.installmentNumber !== 1)
    )
      return bindingMismatch();
    const checkoutReference = installment ?? reference(raw.checkoutSession);
    const method = reference(raw.billingType);
    if (
      raw.externalReference !== undefined &&
      raw.externalReference !== null &&
      !localId(raw.externalReference)
    )
      return invalid();
    if (
      checkoutReference !== binding.providerCheckoutReference ||
      (installment !== null &&
        (raw.checkoutSession != null ||
          raw.externalReference !== binding.attemptId)) ||
      method !== quote.method ||
      (raw.currency !== undefined && raw.currency !== "BRL") ||
      (raw.externalReference !== undefined &&
        raw.externalReference !== null &&
        raw.externalReference !== binding.attemptId)
    )
      return bindingMismatch();
    if (input.existingTerminal !== undefined) {
      const terminal = input.existingTerminal;
      if (
        !terminal ||
        !["REFUNDED", "DISPUTED", "CANCELLED"].includes(terminal.state)
      )
        return invalid();
      if (terminal.providerPaymentReference !== paymentReference)
        return bindingMismatch();
      observationTime(terminal.observedAt, input.now);
      // No reversal is inferred here; terminal evidence fences every proposed write.
      return {
        outcome: "NO_REGRESSION",
        reason: "TERMINAL_PAYMENT",
        payment: null,
        effect: null,
      };
    }
    const gross = cents(raw.value);
    const net =
      raw.netValue === undefined || raw.netValue === null
        ? null
        : cents(raw.netValue);
    if (gross === 0 || (net !== null && net > gross)) return invalid();
    const payment: ObservedGiftPaymentRecord = {
      siteId: binding.siteId,
      accountId: binding.accountId,
      environment: binding.environment,
      orderId: binding.orderId,
      attemptId: binding.attemptId,
      providerPaymentReference: paymentReference,
      providerStatus: status,
      verificationStatus: "VERIFIED",
      observedAt: new Date(observed),
      currency: "BRL",
      grossCents: gross,
      processingCents:
        net === null ? null : Number(BigInt(gross) - BigInt(net)),
      commissionCents: null,
      recipientNetCents: null,
      splitProviderReference: null,
      splitFixedCents: null,
      ...(installment === null
        ? {}
        : {
            providerInstallmentReference: installment,
            installmentNumber: installmentNumber as number,
          }),
    };
    if (
      status === "CONFIRMED" &&
      gross === terms.grossCents &&
      net !== null &&
      (raw.deleted == null || raw.deleted === false) &&
      raw.chargeback == null &&
      raw.custody == null &&
      (raw.refunds == null ||
        (Array.isArray(raw.refunds) && raw.refunds.length === 0)) &&
      Array.isArray(raw.split)
    ) {
      // A configured split can establish an allocation awaiting release, never a settled commission.
      const split = raw.split.length === 1 ? record(raw.split[0]) : null;
      const zero = terms.commissionCents === 0 && raw.split.length === 0;
      const matching =
        split &&
        split.walletId === input.platformWalletId &&
        isReference(split.id) &&
        split.percentualValue == null &&
        split.fixedValue != null &&
        cents(split.fixedValue) === terms.commissionCents &&
        (split.totalValue == null
          ? split.status !== "DONE"
          : cents(split.totalValue) === terms.commissionCents ||
            (split.status !== "DONE" && cents(split.totalValue) === 0)) &&
        ["PENDING", "PROCESSING", "AWAITING_CREDIT", "DONE"].includes(
          String(split.status),
        );
      if ((zero || matching) && net > terms.commissionCents) {
        payment.splitProviderReference = split ? reference(split.id) : null;
        payment.splitFixedCents = terms.commissionCents;
        payment.recipientNetCents = net - terms.commissionCents;
      }
    }
    if (status !== "RECEIVED")
      return {
        outcome: "NOT_RECEIVED",
        reason: "PAYMENT_NOT_RECEIVED",
        payment,
        effect: null,
      };
    if (
      (raw.deleted !== undefined &&
        raw.deleted !== null &&
        typeof raw.deleted !== "boolean") ||
      (raw.refunds !== undefined &&
        raw.refunds !== null &&
        !Array.isArray(raw.refunds))
    )
      return invalid();
    if (
      raw.deleted === true ||
      (Array.isArray(raw.refunds) && raw.refunds.length > 0) ||
      (raw.chargeback !== undefined && raw.chargeback !== null) ||
      (raw.custody !== undefined && raw.custody !== null)
    ) {
      return {
        outcome: "NOT_RECEIVED",
        reason: "PAYMENT_RESTRICTED",
        payment,
        effect: null,
      };
    }
    if (raw.split === undefined || raw.split === null)
      return {
        outcome: "SPLIT_PENDING",
        reason: "SPLIT_NOT_SETTLED",
        payment,
        effect: null,
      };
    if (!Array.isArray(raw.split)) return invalid();
    const splits = raw.split;
    if (terms.commissionCents === 0 && splits.length === 0) {
      // An authoritative empty split has no outgoing platform transfer.
      payment.commissionCents = 0;
      payment.splitFixedCents = 0;
      payment.recipientNetCents = net;
    } else {
      if (splits.length !== 1)
        return {
          outcome: "DIVERGENT",
          reason: "SPLIT_MISMATCH",
          payment,
          effect: null,
        };
      const split = record(splits[0]);
      if (split.walletId !== input.platformWalletId)
        return {
          outcome: "DIVERGENT",
          reason: "SPLIT_MISMATCH",
          payment,
          effect: null,
        };
      payment.splitProviderReference = reference(split.id);
      payment.splitFixedCents =
        split.fixedValue === undefined || split.fixedValue === null
          ? null
          : cents(split.fixedValue);
      if (
        (split.percentualValue !== undefined &&
          split.percentualValue !== null) ||
        payment.splitFixedCents === null
      ) {
        return {
          outcome: "DIVERGENT",
          reason: "SPLIT_MISMATCH",
          payment,
          effect: null,
        };
      }
      if (split.status !== "DONE")
        return {
          outcome: "SPLIT_PENDING",
          reason: "SPLIT_NOT_SETTLED",
          payment,
          effect: null,
        };
      if (split.totalValue === undefined || split.totalValue === null)
        return {
          outcome: "SPLIT_PENDING",
          reason: "SPLIT_NOT_SETTLED",
          payment,
          effect: null,
        };
      payment.commissionCents = cents(split.totalValue);
      payment.recipientNetCents =
        net !== null && net >= payment.commissionCents
          ? Number(BigInt(net) - BigInt(payment.commissionCents))
          : null;
    }
    const { processingCents, commissionCents, recipientNetCents } = payment;
    if (
      processingCents === null ||
      commissionCents === null ||
      recipientNetCents === null ||
      payment.grossCents !== terms.grossCents ||
      commissionCents !== terms.commissionCents ||
      (quote.feeAllocation === "BUYER_GROSS_UP" &&
        quote.settlementVersion !== "PLATFORM_FEE_GUARANTEE_V1" &&
        processingCents !== quote.processingCents) ||
      payment.splitFixedCents !== terms.commissionCents ||
      recipientNetCents <= 0 ||
      BigInt(payment.grossCents) !==
        BigInt(processingCents) +
          BigInt(commissionCents) +
          BigInt(recipientNetCents)
    ) {
      return {
        outcome: "DIVERGENT",
        reason: "ALLOCATION_MISMATCH",
        payment,
        effect: null,
      };
    }
    return {
      outcome: "RECEIVED",
      reason: null,
      payment,
      ...(quote.settlementVersion === "PLATFORM_FEE_GUARANTEE_V1"
        ? {
            platformAdjustmentCents: Math.max(
              0,
              terms.nominalCents - recipientNetCents,
            ),
          }
        : {}),
      effect: {
        effectKey: giftReceivedEffectKey(payment.providerPaymentReference),
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        currency: "BRL",
        amountCents: recipientNetCents,
      },
    };
  } catch (error) {
    if (error instanceof GiftPaymentReconciliationServiceError) throw error;
    return invalid();
  }
}

// ---------------------------------------------------------------------------
// PLATFORM_ACCOUNT_SPLIT_V2: the platform account charges the buyer and a fixed
// split per charge pays the couple wallet. Only PAYMENT_SPLIT_DONE credits.

export type GiftOperatorAlertKindV2 =
  | "SPLIT_DIVERGENCE_BLOCK"
  | "SPLIT_CANCELLED"
  | "ANTICIPATION_DENIED"
  | "PAYMENT_RESTRICTION";

export interface GiftOperatorAlertEffect {
  kind: GiftOperatorAlertKindV2;
  severity: "warning" | "critical";
  details: Record<string, string | number | boolean | null>;
}

export interface ObservedGiftPaymentRecordV2 extends ObservedGiftPaymentRecord {
  platformNetCents: number | null;
  anticipationCents: number | null;
  anticipationReference: string | null;
  splitDivergenceBlocked: boolean;
}

export interface GiftPaymentReconciliationV2Input
  extends GiftPaymentReconciliationInput {
  eventType: string;
  /** Set by the divergence fix: the part of the split moved to a platform top-up. */
  splitTopUpCents?: number | null;
}

export type GiftPaymentReconciliationV2Reason =
  | "PAYMENT_NOT_RECEIVED"
  | "PAYMENT_RESTRICTED"
  | "SPLIT_NOT_SETTLED"
  | "SPLIT_MISMATCH"
  | "ALLOCATION_MISMATCH";

export type GiftPaymentReconciliationV2Result =
  | {
      // Only PAYMENT_SPLIT_DONE with a settled couple split of the frozen value.
      outcome: "RECEIVED";
      reason: null;
      payment: ObservedGiftPaymentRecordV2;
      effect: GiftReceiptEffect;
      alert: null;
    }
  | {
      // Recorded; the event completes without a credit.
      outcome: "OBSERVED";
      reason: null;
      payment: ObservedGiftPaymentRecordV2;
      effect: null;
      alert: GiftOperatorAlertEffect | null;
    }
  | {
      // A receipt event the provider state does not honour (yet); retried.
      outcome: "PENDING";
      reason: GiftPaymentReconciliationV2Reason;
      payment: ObservedGiftPaymentRecordV2;
      effect: null;
      alert: GiftOperatorAlertEffect | null;
    }
  | {
      outcome: "NO_REGRESSION";
      reason: "TERMINAL_PAYMENT";
      payment: null;
      effect: null;
      alert: null;
    };

const restrictedV2Status =
  /^(REFUND|CHARGEBACK)|^(DELETED|DISPUTED|AWAITING_CHARGEBACK_REVERSAL)$/;

export function reconcileGiftPaymentObservationV2(
  input: GiftPaymentReconciliationV2Input,
): GiftPaymentReconciliationV2Result {
  try {
    const quoted = giftQuoteSchema.safeParse(input.quoteSnapshot.quote);
    const created = giftQuoteSchema.shape.expiresAt.safeParse(
      input.quoteSnapshot.createdAt,
    );
    if (
      !quoted.success ||
      !created.success ||
      quoted.data.settlementVersion !== "PLATFORM_ACCOUNT_SPLIT_V2"
    )
      throw new GiftPaymentReconciliationServiceError(
        409,
        "PAYMENT_QUOTE_INVALID",
      );
    const quote = quoted.data;
    let recipientSplitCents: readonly number[] = [];
    try {
      recipientSplitCents =
        readGiftV2Settlement(quote, input.quoteSnapshot.settlement)
          ?.recipientSplitCents ?? [];
    } catch {
      recipientSplitCents = [];
    }
    if (!recipientSplitCents.length)
      throw new GiftPaymentReconciliationServiceError(
        409,
        "PAYMENT_QUOTE_INVALID",
      );
    const binding = input.checkout;
    const receiving = input.quoteSnapshot.receiving;
    const observation = input.observation;
    const coupleWallet = receiving.recipientReference;
    if (
      ![
        binding.siteId,
        binding.accountId,
        binding.orderId,
        binding.attemptId,
      ].every(localId) ||
      ![
        binding.providerCheckoutReference,
        binding.accountReference,
        input.platformWalletId,
      ].every(isReference) ||
      (binding.environment !== "sandbox" && binding.environment !== "live") ||
      quote.siteId !== binding.siteId ||
      quote.mode !== binding.environment ||
      receiving.siteId !== binding.siteId ||
      receiving.environment !== binding.environment ||
      receiving.provider !== "ASAAS" ||
      receiving.accountReference !== binding.accountReference ||
      !isReference(coupleWallet) ||
      input.platformWalletId === coupleWallet ||
      observation.source !== "provider" ||
      observation.provider !== "ASAAS" ||
      observation.currency !== "BRL" ||
      observation.siteId !== binding.siteId ||
      observation.accountReference !== binding.accountReference ||
      observation.environment !== binding.environment ||
      typeof input.eventType !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.eventType)
    )
      return bindingMismatch();
    const observed = observationTime(observation.observedAt, input.now);
    if (observed < new Date(created.data).getTime()) return invalid();
    const raw = record(observation.payment);
    const paymentReference = reference(raw.id);
    const status = providerStatus(raw.status);
    const installmentCount = quote.installmentCount ?? 1;
    const installment =
      installmentCount > 1 ? reference(raw.installment) : null;
    const installmentNumber =
      installmentCount > 1 ? raw.installmentNumber : null;
    const terms = giftPaymentTerms(quote, installmentNumber);
    const splitCents =
      recipientSplitCents[
        typeof installmentNumber === "number" ? installmentNumber - 1 : 0
      ];
    if (
      !terms ||
      splitCents === undefined ||
      recipientSplitCents.length !== installmentCount ||
      (installment === null &&
        raw.installmentNumber != null &&
        raw.installmentNumber !== 1)
    )
      return bindingMismatch();
    const checkoutReference = installment ?? reference(raw.checkoutSession);
    if (
      raw.externalReference !== undefined &&
      raw.externalReference !== null &&
      !localId(raw.externalReference)
    )
      return invalid();
    if (
      checkoutReference !== binding.providerCheckoutReference ||
      (installment !== null &&
        (raw.checkoutSession != null ||
          raw.externalReference !== binding.attemptId)) ||
      reference(raw.billingType) !== quote.method ||
      (raw.currency !== undefined && raw.currency !== "BRL") ||
      (raw.externalReference !== undefined &&
        raw.externalReference !== null &&
        raw.externalReference !== binding.attemptId)
    )
      return bindingMismatch();
    if (input.existingTerminal !== undefined) {
      const terminal = input.existingTerminal;
      if (
        !terminal ||
        !["REFUNDED", "DISPUTED", "CANCELLED"].includes(terminal.state)
      )
        return invalid();
      if (terminal.providerPaymentReference !== paymentReference)
        return bindingMismatch();
      observationTime(terminal.observedAt, input.now);
      return {
        outcome: "NO_REGRESSION",
        reason: "TERMINAL_PAYMENT",
        payment: null,
        effect: null,
        alert: null,
      };
    }
    const topUp = input.splitTopUpCents ?? 0;
    if (!Number.isSafeInteger(topUp) || topUp < 0 || topUp >= splitCents)
      return invalid();
    // A divergence fix lowers the couple split; the platform tops up the rest.
    const coupleSplitCents = splitCents - topUp;
    const gross = cents(raw.value);
    const net =
      raw.netValue === undefined || raw.netValue === null
        ? null
        : cents(raw.netValue);
    if (gross === 0 || (net !== null && net > gross)) return invalid();
    if (
      (raw.deleted !== undefined &&
        raw.deleted !== null &&
        typeof raw.deleted !== "boolean") ||
      (raw.refunds !== undefined &&
        raw.refunds !== null &&
        !Array.isArray(raw.refunds)) ||
      (raw.split !== undefined &&
        raw.split !== null &&
        !Array.isArray(raw.split))
    )
      return invalid();
    const payment: ObservedGiftPaymentRecordV2 = {
      siteId: binding.siteId,
      accountId: binding.accountId,
      environment: binding.environment,
      orderId: binding.orderId,
      attemptId: binding.attemptId,
      providerPaymentReference: paymentReference,
      providerStatus: status,
      verificationStatus: "VERIFIED",
      observedAt: new Date(observed),
      currency: "BRL",
      grossCents: gross,
      processingCents:
        net === null ? null : Number(BigInt(gross) - BigInt(net)),
      commissionCents: null,
      recipientNetCents: null,
      splitProviderReference: null,
      splitFixedCents: null,
      platformNetCents: null,
      anticipationCents: null,
      anticipationReference: null,
      splitDivergenceBlocked: false,
      ...(installment === null
        ? {}
        : {
            providerInstallmentReference: installment,
            installmentNumber: installmentNumber as number,
          }),
    };
    const details = {
      eventType: input.eventType,
      providerStatus: status,
      installmentNumber: payment.installmentNumber ?? null,
      splitCents,
    };

    // Anticipation is reconciliation data only; it never changes the couple split.
    const anticipation =
      raw.anticipation === undefined || raw.anticipation === null
        ? null
        : record(raw.anticipation);
    if (anticipation?.status === "CREDITED") {
      payment.anticipationReference = reference(anticipation.id);
      payment.anticipationCents = cents(anticipation.fee);
    }

    const splits = Array.isArray(raw.split) ? raw.split.map(record) : [];
    const couple = splits.filter((split) => split.walletId === coupleWallet);
    const split = splits.length === 1 && couple.length === 1 ? couple[0] : null;
    const splitStatus = couple.length === 1 ? String(couple[0].status) : null;
    if (split && isReference(split.id)) {
      payment.splitProviderReference = split.id;
      if (split.fixedValue != null)
        payment.splitFixedCents = cents(split.fixedValue);
    }
    const settled =
      split !== null &&
      splitStatus === "DONE" &&
      split.percentualValue == null &&
      split.totalValue != null &&
      cents(split.totalValue) === coupleSplitCents &&
      (split.fixedValue == null ||
        cents(split.fixedValue) === coupleSplitCents);
    if (settled && net !== null && net >= coupleSplitCents) {
      payment.recipientNetCents = coupleSplitCents;
      payment.platformNetCents = net - coupleSplitCents;
      payment.commissionCents = net - coupleSplitCents;
    }

    const restricted =
      raw.deleted === true ||
      (Array.isArray(raw.refunds) && raw.refunds.length > 0) ||
      raw.chargeback != null ||
      raw.custody != null ||
      restrictedV2Status.test(status);
    let alert: GiftOperatorAlertEffect | null = null;
    if (restricted)
      alert = { kind: "PAYMENT_RESTRICTION", severity: "critical", details };
    else if (
      input.eventType === "PAYMENT_SPLIT_DIVERGENCE_BLOCK" ||
      splitStatus === "BLOCKED_BY_VALUE_DIVERGENCE"
    ) {
      payment.splitDivergenceBlocked = true;
      alert = {
        kind: "SPLIT_DIVERGENCE_BLOCK",
        severity: "critical",
        details: { ...details, netCents: net },
      };
    } else if (
      input.eventType === "PAYMENT_SPLIT_CANCELLED" ||
      input.eventType === "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED" ||
      splitStatus === "CANCELLED" ||
      splitStatus === "REFUSED"
    )
      alert = {
        kind: "SPLIT_CANCELLED",
        severity: "critical",
        details: { ...details, splitStatus },
      };
    else if (
      input.eventType === "RECEIVABLE_ANTICIPATION_DENIED" ||
      input.eventType === "RECEIVABLE_ANTICIPATION_CANCELLED"
    )
      alert = {
        kind: "ANTICIPATION_DENIED",
        severity: "warning",
        details: {
          ...details,
          anticipationStatus:
            anticipation === null ? null : String(anticipation.status),
        },
      };

    // A paid charge whose split matches the frozen amount is awaiting release:
    // the couple's share is known before Asaas settles it. Only the ledger
    // credit (PAYMENT_SPLIT_DONE + RECEIVED) makes it available.
    if (
      payment.recipientNetCents === null &&
      alert === null &&
      split !== null &&
      split.percentualValue == null &&
      payment.splitFixedCents === coupleSplitCents &&
      (status === "CONFIRMED" || status === "RECEIVED")
    )
      payment.recipientNetCents = coupleSplitCents;

    if (input.eventType !== "PAYMENT_SPLIT_DONE")
      return {
        outcome: "OBSERVED",
        reason: null,
        payment,
        effect: null,
        alert,
      };
    const pending = (
      reason: GiftPaymentReconciliationV2Reason,
    ): GiftPaymentReconciliationV2Result => ({
      outcome: "PENDING",
      reason,
      payment,
      effect: null,
      alert,
    });
    if (restricted) return pending("PAYMENT_RESTRICTED");
    // Without anticipation the split is credited per charge only once Asaas
    // releases it; a CONFIRMED card charge has not been received yet.
    if (status !== "RECEIVED") return pending("PAYMENT_NOT_RECEIVED");
    if (split === null) return pending("SPLIT_MISMATCH");
    if (splitStatus !== "DONE" || split.totalValue == null)
      return pending("SPLIT_NOT_SETTLED");
    if (!settled) return pending("SPLIT_MISMATCH");
    const { processingCents, commissionCents, recipientNetCents } = payment;
    if (
      processingCents === null ||
      commissionCents === null ||
      recipientNetCents === null ||
      gross !== terms.grossCents ||
      recipientNetCents <= 0 ||
      BigInt(gross) !==
        BigInt(processingCents) +
          BigInt(commissionCents) +
          BigInt(recipientNetCents)
    )
      return pending("ALLOCATION_MISMATCH");
    return {
      outcome: "RECEIVED",
      reason: null,
      payment,
      alert: null,
      effect: {
        effectKey: giftReceivedEffectKey(paymentReference),
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        currency: "BRL",
        amountCents: recipientNetCents,
      },
    };
  } catch (error) {
    if (error instanceof GiftPaymentReconciliationServiceError) throw error;
    return invalid();
  }
}
