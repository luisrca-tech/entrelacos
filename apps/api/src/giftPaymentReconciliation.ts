import { createHash } from "node:crypto";
import { giftQuoteSchema } from "@entrelacos/contracts";
import { parseBrlCents } from "./giftMoney";
import type { GiftQuoteSnapshot } from "./giftQuotes";

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
    const checkoutReference = reference(raw.checkoutSession);
    const method = reference(raw.billingType);
    if (
      raw.externalReference !== undefined &&
      raw.externalReference !== null &&
      !localId(raw.externalReference)
    )
      return invalid();
    if (
      checkoutReference !== binding.providerCheckoutReference ||
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
    };
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
    if (quote.commissionCents === 0 && splits.length === 0) {
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
      payment.grossCents !== quote.totalCents ||
      processingCents !== quote.processingCents ||
      commissionCents !== quote.commissionCents ||
      payment.splitFixedCents !== quote.commissionCents ||
      recipientNetCents !== quote.nominalCents ||
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
