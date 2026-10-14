import { isDeepStrictEqual } from "node:util";
import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftCheckoutAttempt,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { readGiftQuoteSnapshot } from "./giftCheckouts";
import {
  type GiftPaymentReconciliationResult,
  type GiftPaymentTerminalEvidence,
  type GiftProviderPaymentObservation,
  giftReceivedEffectKey,
  type ObservedGiftPaymentRecord,
  reconcileGiftPaymentObservation,
  type StoredGiftPaymentCheckoutBinding,
} from "./giftPaymentReconciliation";
import type { GiftQuoteSnapshot } from "./giftQuotes";

export interface GiftPaymentPostingClaim {
  eventId: string;
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  leaseOwner: string;
  leaseToken: string;
}

// Server-only observations come from an authenticated fetch using this stored account.
export interface GiftPaymentPostingInput {
  claim: GiftPaymentPostingClaim;
  checkout: StoredGiftPaymentCheckoutBinding;
  observation: GiftProviderPaymentObservation;
}

export interface GiftPaymentPostingOptions {
  environment: "sandbox" | "live";
  platformWalletId: string;
  retryDelayMs: number;
  now(): Date;
  generateId(kind: "payment" | "ledger"): string;
}

export interface GiftPaymentPostingResult {
  outcome: "POSTED" | "OBSERVED" | "DUPLICATE" | "NO_REGRESSION";
  paymentId: string | null;
  ledgerEntryId: string | null;
}

export interface GiftPaymentPostingRepository {
  postReceivedPayment(
    input: GiftPaymentPostingInput,
  ): Promise<GiftPaymentPostingResult>;
}

export type GiftPaymentPostingDatabase = Pick<
  DatabaseConnection["db"],
  "transaction"
>;
type Transaction = Parameters<
  Parameters<GiftPaymentPostingDatabase["transaction"]>[0]
>[0];
type Inbox = typeof financialEventInbox.$inferSelect;
type Payment = typeof giftPaymentRecord.$inferSelect;
type Ledger = typeof financialLedgerEntry.$inferSelect;
type RetryReason =
  | Exclude<GiftPaymentReconciliationResult["reason"], null>
  | "PAYMENT_RECEIPT_MISMATCH"
  | "PAYMENT_OBSERVATION_STALE";
interface BindingRow extends StoredGiftPaymentCheckoutBinding {
  quoteId: string;
  operationId: string;
  operationKind: string;
  operationState: string;
  providerOperationReference: string | null;
  provider: string;
  snapshot: Record<string, unknown>;
  orderCreatedAt: Date;
  quoteCreatedAt: Date;
  quoteExpiresAt: Date;
  giftId: string;
  destinationVersion: number;
  method: string;
  currency: string;
  nominalCents: number;
  commissionBasisPoints: number;
  commissionCents: number;
  processingCents: number;
  totalCents: number;
  policyVersion: string;
}

export class GiftPaymentPostingRepositoryError extends Error {
  readonly status = 503;
  readonly code = "PAYMENT_POSTING_UNAVAILABLE";
  constructor() {
    super("Payment posting unavailable");
    this.name = "GiftPaymentPostingRepositoryError";
  }
}
function unavailable(): never {
  throw new GiftPaymentPostingRepositoryError();
}
function validId(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function reference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function eventReference(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value);
}
function date(value: Date): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    return unavailable();
  return readDatabaseTimestamp(value);
}
function microseconds(value: Date): bigint {
  return databaseTimestampEpochMicroseconds(date(value));
}
function storedRow<T>(value: unknown, fields: string[]): T {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const row = value as Record<string, unknown>;
  return {
    ...row,
    ...Object.fromEntries(
      fields.map((field) => [
        field,
        row[field] === null ? null : readDatabaseTimestamp(row[field]),
      ]),
    ),
  } as T;
}
function sameScope(
  left: { siteId: string; accountId: string; environment: string },
  right: GiftPaymentPostingClaim,
) {
  return (
    left.siteId === right.siteId &&
    left.accountId === right.accountId &&
    left.environment === right.environment
  );
}

async function readBinding(
  tx: Transaction,
  input: GiftPaymentPostingInput,
): Promise<{
  row: BindingRow;
  snapshot: GiftQuoteSnapshot;
  checkout: StoredGiftPaymentCheckoutBinding;
}> {
  const claim = input.claim;
  const locked =
    await tx.execute(sql`SELECT o.id AS "orderId", o.site_id AS "siteId", o.account_id AS "accountId", o.environment
    FROM ${giftOrder} o WHERE o.id = ${input.checkout.orderId} AND o.site_id = ${claim.siteId}
      AND o.account_id = ${claim.accountId} AND o.environment = ${claim.environment} FOR UPDATE OF o`);
  const order = locked.rows[0];
  if (
    locked.rows.length !== 1 ||
    !order ||
    order.orderId !== input.checkout.orderId ||
    !sameScope(order as unknown as BindingRow, claim)
  )
    return unavailable();
  const result =
    await tx.execute(sql`SELECT o.id AS "orderId", o.site_id AS "siteId", o.account_id AS "accountId", o.environment,
    o.quote_id AS "quoteId", o.created_at AS "orderCreatedAt", a.id AS "attemptId", a.operation_id AS "operationId",
    a.provider_reference AS "providerCheckoutReference", op.kind AS "operationKind", op.state AS "operationState",
    op.provider_operation_reference AS "providerOperationReference", account.provider, account.account_reference AS "accountReference",
    q.snapshot, q.created_at AS "quoteCreatedAt", q.expires_at AS "quoteExpiresAt", q.destination_version AS "destinationVersion",
    q.gift_id AS "giftId", q.method, q.currency, q.nominal_cents AS "nominalCents", q.commission_basis_points AS "commissionBasisPoints",
    q.commission_cents AS "commissionCents", q.processing_cents AS "processingCents", q.total_cents AS "totalCents", q.policy_version AS "policyVersion"
    FROM ${giftOrder} o INNER JOIN ${giftQuoteRecord} q ON q.id = o.quote_id AND q.site_id = o.site_id AND q.account_id = o.account_id AND q.environment = o.environment
    INNER JOIN ${giftCheckoutAttempt} a ON a.order_id = o.id AND a.site_id = o.site_id AND a.account_id = o.account_id AND a.environment = o.environment
    INNER JOIN ${financialOperation} op ON op.id = a.operation_id AND op.site_id = a.site_id AND op.account_id = a.account_id AND op.environment = a.environment
      AND op.order_id = o.id AND op.kind = a.operation_kind AND op.kind = 'CHECKOUT_CREATE'
    INNER JOIN ${receivingAccount} account ON account.id = o.account_id AND account.site_id = o.site_id AND account.environment = o.environment
    WHERE o.id = ${input.checkout.orderId} AND o.site_id = ${claim.siteId} AND o.account_id = ${claim.accountId}
      AND o.environment = ${claim.environment} AND a.id = ${input.checkout.attemptId}`);
  const row = storedRow<BindingRow>(result.rows[0], [
    "orderCreatedAt",
    "quoteCreatedAt",
    "quoteExpiresAt",
  ]);
  if (
    result.rows.length !== 1 ||
    !row ||
    !sameScope(row, claim) ||
    row.operationKind !== "CHECKOUT_CREATE" ||
    row.operationState !== "SUCCEEDED" ||
    row.operationId !== row.attemptId ||
    row.provider !== "ASAAS" ||
    !reference(row.providerCheckoutReference) ||
    row.providerCheckoutReference !== row.providerOperationReference
  )
    return unavailable();
  const snapshot = readGiftQuoteSnapshot(
    row.snapshot as unknown as GiftQuoteSnapshot,
  );
  const checkout: StoredGiftPaymentCheckoutBinding = {
    siteId: row.siteId,
    accountId: row.accountId,
    environment: row.environment,
    orderId: row.orderId,
    attemptId: row.attemptId,
    accountReference: row.accountReference,
    providerCheckoutReference: row.providerCheckoutReference,
  };
  if (
    !isDeepStrictEqual(input.checkout, checkout) ||
    snapshot.quote.id !== row.quoteId ||
    snapshot.quote.siteId !== row.siteId ||
    snapshot.quote.mode !== row.environment ||
    snapshot.receiving.accountReference !== row.accountReference ||
    snapshot.receiving.destinationVersion !== row.destinationVersion ||
    microseconds(new Date(snapshot.createdAt)) !==
      microseconds(row.quoteCreatedAt) ||
    microseconds(new Date(snapshot.expiresAt)) !==
      microseconds(row.quoteExpiresAt) ||
    [
      "giftId",
      "method",
      "currency",
      "nominalCents",
      "commissionBasisPoints",
      "commissionCents",
      "processingCents",
      "totalCents",
      "policyVersion",
    ].some(
      (key) =>
        snapshot.quote[key as keyof typeof snapshot.quote] !==
        row[key as keyof BindingRow],
    )
  )
    return unavailable();
  return { row, snapshot, checkout };
}

async function readEvent(
  tx: Transaction,
  claim: GiftPaymentPostingClaim,
  binding: BindingRow,
  observation: GiftProviderPaymentObservation,
  clock: Date,
) {
  const result =
    await tx.execute(sql`SELECT e.id, e.site_id AS "siteId", e.account_id AS "accountId", e.environment, e.provider_event_reference AS "providerEventReference",
    e.event_type AS "eventType", e.payload_hash AS "payloadHash", e.payload, e.received_at AS "receivedAt", e.authenticated_at AS "authenticatedAt",
    e.payment_id AS "paymentId", e.state, e.lease_owner AS "leaseOwner", e.lease_token AS "leaseToken", e.lease_expires_at AS "leaseExpiresAt", e.processed_at AS "processedAt",
    e.next_attempt_at AS "nextAttemptAt", e.last_error_code AS "lastErrorCode"
    FROM ${financialEventInbox} e WHERE e.id = ${claim.eventId} AND e.site_id = ${claim.siteId}
      AND e.account_id = ${claim.accountId} AND e.environment = ${claim.environment} FOR UPDATE OF e`);
  const event = storedRow<Inbox>(result.rows[0], [
    "receivedAt",
    "authenticatedAt",
    "leaseExpiresAt",
    "processedAt",
    "nextAttemptAt",
  ]);
  const raw = observation.payment as Record<string, unknown>;
  if (
    result.rows.length !== 1 ||
    !event ||
    !sameScope(event, claim) ||
    event.id !== claim.eventId ||
    event.eventType !== "PAYMENT_RECEIVED" ||
    event.leaseOwner !== claim.leaseOwner ||
    event.leaseToken !== claim.leaseToken ||
    !["CLAIMED", "RETRY", "PROCESSED"].includes(event.state) ||
    (event.state === "CLAIMED" &&
      microseconds(event.leaseExpiresAt as Date) < microseconds(clock)) ||
    microseconds(event.authenticatedAt) > microseconds(clock) ||
    microseconds(event.receivedAt) > microseconds(event.authenticatedAt) ||
    !eventReference(event.providerEventReference) ||
    !event.payload ||
    !raw ||
    !reference(event.payload.paymentId) ||
    event.payload.paymentId !== raw.id ||
    (event.payload.checkoutId !== undefined &&
      event.payload.checkoutId !== binding.providerCheckoutReference) ||
    (event.payload.externalReference !== undefined &&
      event.payload.externalReference !== binding.attemptId) ||
    Object.entries(event.payload).some(
      ([key, value]) =>
        !["paymentId", "checkoutId", "externalReference"].includes(key) ||
        !(key === "externalReference" ? validId(value) : reference(value)),
    ) ||
    event.payloadHash !==
      hashAsaasEventIdentity(
        event.providerEventReference,
        event.eventType,
        binding.accountReference,
        event.payload as Record<string, string>,
      )
  )
    return unavailable();
  return event;
}

async function completeEvent(
  tx: Transaction,
  claim: GiftPaymentPostingClaim,
  event: Inbox,
  paymentId: string,
  options: GiftPaymentPostingOptions,
  reason: RetryReason | null = null,
) {
  const clock = date(options.now());
  const retryAt = date(new Date(clock.getTime() + options.retryDelayMs));
  const completion =
    reason === null
      ? sql`state = 'PROCESSED', processed_at = ${clock.toISOString()}::timestamptz, last_error_code = NULL`
      : sql`state = 'RETRY', processed_at = NULL, next_attempt_at = ${retryAt.toISOString()}::timestamptz, last_error_code = ${reason}`;
  const result =
    await tx.execute(sql`UPDATE ${financialEventInbox} e SET ${completion}, payment_id = ${paymentId}
    WHERE e.id = ${claim.eventId} AND e.site_id = ${claim.siteId} AND e.account_id = ${claim.accountId} AND e.environment = ${claim.environment}
      AND e.state = 'CLAIMED' AND e.event_type = 'PAYMENT_RECEIVED' AND e.payload_hash = ${event.payloadHash}
      AND e.lease_owner = ${claim.leaseOwner} AND e.lease_token = ${claim.leaseToken}
      AND e.lease_expires_at >= ${clock.toISOString()}::timestamptz AND e.lease_expires_at >= clock_timestamp()
      AND e.authenticated_at <= ${clock.toISOString()}::timestamptz AND (e.payment_id IS NULL OR e.payment_id = ${paymentId}) RETURNING e.id`);
  if (result.rows.length !== 1 || result.rows[0]?.id !== claim.eventId)
    return unavailable();
}

async function currentPayment(
  tx: Transaction,
  claim: GiftPaymentPostingClaim,
  checkout: StoredGiftPaymentCheckoutBinding,
  providerReference: string,
  clock: Date,
) {
  const result =
    await tx.execute(sql`SELECT p.id, p.site_id AS "siteId", p.account_id AS "accountId", p.environment, p.order_id AS "orderId", p.attempt_id AS "attemptId",
    p.provider_payment_reference AS "providerPaymentReference", p.provider_status AS "providerStatus", p.verification_status AS "verificationStatus", p.observed_at AS "observedAt",
    p.currency, p.gross_cents AS "grossCents", p.processing_cents AS "processingCents", p.commission_cents AS "commissionCents", p.recipient_net_cents AS "recipientNetCents",
    p.split_provider_reference AS "splitProviderReference", p.split_fixed_cents AS "splitFixedCents"
    FROM ${giftPaymentRecord} p WHERE p.site_id = ${claim.siteId} AND p.account_id = ${claim.accountId} AND p.environment = ${claim.environment}
      AND p.provider_payment_reference = ${providerReference} FOR UPDATE OF p`);
  if (result.rows.length === 0) return null;
  const payment = storedRow<Payment>(result.rows[0], ["observedAt"]);
  if (
    result.rows.length !== 1 ||
    !sameScope(payment, claim) ||
    !validId(payment.id) ||
    payment.orderId !== checkout.orderId ||
    payment.attemptId !== checkout.attemptId ||
    payment.providerPaymentReference !== providerReference ||
    payment.currency !== "BRL" ||
    !["VERIFIED", "UNVERIFIED"].includes(payment.verificationStatus) ||
    (payment.observedAt !== null &&
      microseconds(payment.observedAt) > microseconds(clock)) ||
    (payment.verificationStatus === "VERIFIED" &&
      (!reference(payment.providerStatus) ||
        payment.observedAt === null ||
        !Number.isSafeInteger(payment.grossCents) ||
        (payment.grossCents as number) <= 0))
  )
    return unavailable();
  return payment;
}

async function currentReceipt(
  tx: Transaction,
  claim: GiftPaymentPostingClaim,
  binding: BindingRow,
  payment: Payment,
  snapshot: GiftQuoteSnapshot,
  clock: Date,
) {
  const result =
    await tx.execute(sql`SELECT l.id, l.site_id AS "siteId", l.account_id AS "accountId", l.environment, l.effect_key AS "effectKey", l.kind,
    l.direction, l.currency, l.amount_cents AS "amountCents", l.payment_id AS "paymentId", l.operation_id AS "operationId", l.event_id AS "eventId", l.compensates_entry_id AS "compensatesEntryId"
    FROM ${financialLedgerEntry} l WHERE l.site_id = ${claim.siteId} AND l.account_id = ${claim.accountId} AND l.environment = ${claim.environment}
      AND (l.payment_id = ${payment.id} OR l.compensates_entry_id IN (SELECT original.id FROM ${financialLedgerEntry} original
        WHERE original.site_id = ${claim.siteId} AND original.account_id = ${claim.accountId} AND original.environment = ${claim.environment} AND original.payment_id = ${payment.id}))`);
  if (result.rows.length === 0) return null;
  const ledger = result.rows[0] as unknown as Ledger;
  if (
    result.rows.length !== 1 ||
    !sameScope(ledger, claim) ||
    !validId(ledger.id) ||
    ledger.paymentId !== payment.id ||
    ledger.kind !== "GIFT_RECEIVED" ||
    ledger.direction !== "CREDIT" ||
    ledger.currency !== "BRL" ||
    ledger.amountCents !== snapshot.quote.nominalCents ||
    ledger.effectKey !==
      giftReceivedEffectKey(payment.providerPaymentReference) ||
    ledger.compensatesEntryId !== null ||
    (ledger.operationId !== null && ledger.operationId !== binding.operationId)
  )
    return unavailable();
  const quote = snapshot.quote;
  if (
    payment.providerStatus === "RECEIVED" &&
    (payment.verificationStatus !== "VERIFIED" ||
      payment.observedAt === null ||
      microseconds(payment.observedAt) < microseconds(binding.orderCreatedAt) ||
      payment.grossCents !== quote.totalCents ||
      payment.processingCents !== quote.processingCents ||
      payment.commissionCents !== quote.commissionCents ||
      payment.recipientNetCents !== quote.nominalCents ||
      payment.splitFixedCents !== quote.commissionCents ||
      (quote.commissionCents > 0 && !reference(payment.splitProviderReference)))
  )
    return unavailable();
  if (ledger.eventId !== null) {
    const events =
      await tx.execute(sql`SELECT e.id, e.site_id AS "siteId", e.account_id AS "accountId", e.environment, e.event_type AS "eventType",
      e.payment_id AS "paymentId", e.state, e.authenticated_at AS "authenticatedAt", e.processed_at AS "processedAt", e.payload,
      e.provider_event_reference AS "providerEventReference", e.payload_hash AS "payloadHash"
      FROM ${financialEventInbox} e WHERE e.id = ${ledger.eventId} AND e.site_id = ${claim.siteId} AND e.account_id = ${claim.accountId} AND e.environment = ${claim.environment}`);
    const event = storedRow<Inbox>(events.rows[0], [
      "authenticatedAt",
      "processedAt",
    ]);
    if (
      events.rows.length !== 1 ||
      !event ||
      !sameScope(event, claim) ||
      event.id !== ledger.eventId ||
      event.eventType !== "PAYMENT_RECEIVED" ||
      event.paymentId !== payment.id ||
      event.state !== "PROCESSED" ||
      microseconds(event.authenticatedAt) > microseconds(clock) ||
      microseconds(event.processedAt as Date) > microseconds(clock) ||
      microseconds(event.processedAt as Date) <
        microseconds(event.authenticatedAt) ||
      event.payload.paymentId !== payment.providerPaymentReference ||
      !eventReference(event.providerEventReference) ||
      (event.payload.checkoutId !== undefined &&
        event.payload.checkoutId !== binding.providerCheckoutReference) ||
      (event.payload.externalReference !== undefined &&
        event.payload.externalReference !== binding.attemptId) ||
      event.payloadHash !==
        hashAsaasEventIdentity(
          event.providerEventReference,
          event.eventType,
          binding.accountReference,
          event.payload as Record<string, string>,
        )
    )
      return unavailable();
  }
  return ledger;
}

function paymentFields(payment: ObservedGiftPaymentRecord | Payment) {
  return {
    siteId: payment.siteId,
    accountId: payment.accountId,
    environment: payment.environment,
    orderId: payment.orderId,
    attemptId: payment.attemptId,
    providerPaymentReference: payment.providerPaymentReference,
    providerStatus: payment.providerStatus,
    verificationStatus: payment.verificationStatus,
    currency: payment.currency,
    grossCents: payment.grossCents,
    processingCents: payment.processingCents,
    commissionCents: payment.commissionCents,
    recipientNetCents: payment.recipientNetCents,
    splitProviderReference: payment.splitProviderReference,
    splitFixedCents: payment.splitFixedCents,
  };
}

function terminalEvidence(
  payment: Payment | null,
): GiftPaymentTerminalEvidence | undefined {
  if (payment?.verificationStatus !== "VERIFIED" || payment.observedAt === null)
    return undefined;
  const state = payment.providerStatus;
  if (state !== "REFUNDED" && state !== "DISPUTED" && state !== "CANCELLED")
    return undefined;
  return {
    providerPaymentReference: payment.providerPaymentReference,
    state,
    observedAt: date(payment.observedAt),
  };
}

async function writePayment(
  tx: Transaction,
  payment: ObservedGiftPaymentRecord,
  existing: Payment | null,
  options: GiftPaymentPostingOptions,
): Promise<string> {
  if (existing) {
    const result =
      await tx.execute(sql`UPDATE ${giftPaymentRecord} p SET provider_status = ${payment.providerStatus}, verification_status = ${payment.verificationStatus},
      observed_at = ${payment.observedAt.toISOString()}::timestamptz, currency = ${payment.currency}, gross_cents = ${payment.grossCents}, processing_cents = ${payment.processingCents},
      commission_cents = ${payment.commissionCents}, recipient_net_cents = ${payment.recipientNetCents}, split_provider_reference = ${payment.splitProviderReference}, split_fixed_cents = ${payment.splitFixedCents}
      WHERE p.id = ${existing.id} AND p.site_id = ${payment.siteId} AND p.account_id = ${payment.accountId} AND p.environment = ${payment.environment}
        AND p.order_id = ${payment.orderId} AND p.attempt_id = ${payment.attemptId} AND p.provider_payment_reference = ${payment.providerPaymentReference}
        AND (p.observed_at IS NULL OR p.observed_at <= ${payment.observedAt.toISOString()}::timestamptz)
        AND (p.provider_status IS NULL OR p.provider_status NOT IN ('REFUNDED', 'DISPUTED', 'CANCELLED')) RETURNING p.id`);
    if (result.rows.length !== 1 || result.rows[0]?.id !== existing.id)
      return unavailable();
    return existing.id;
  }
  const id = options.generateId("payment");
  if (!validId(id)) return unavailable();
  const result =
    await tx.execute(sql`INSERT INTO ${giftPaymentRecord} (id, site_id, account_id, environment, order_id, attempt_id, provider_payment_reference,
    provider_status, verification_status, observed_at, currency, gross_cents, processing_cents, commission_cents, recipient_net_cents, split_provider_reference, split_fixed_cents, created_at)
    VALUES (${id}, ${payment.siteId}, ${payment.accountId}, ${payment.environment}, ${payment.orderId}, ${payment.attemptId}, ${payment.providerPaymentReference},
      ${payment.providerStatus}, ${payment.verificationStatus}, ${payment.observedAt.toISOString()}::timestamptz, ${payment.currency}, ${payment.grossCents}, ${payment.processingCents},
      ${payment.commissionCents}, ${payment.recipientNetCents}, ${payment.splitProviderReference}, ${payment.splitFixedCents}, ${date(options.now()).toISOString()}::timestamptz)
    ON CONFLICT (site_id, account_id, environment, provider_payment_reference) DO NOTHING RETURNING id`);
  if (result.rows.length !== 1 || result.rows[0]?.id !== id)
    return unavailable();
  return id;
}

export function createGiftPaymentPostingRepository(
  db: GiftPaymentPostingDatabase,
  options: GiftPaymentPostingOptions,
): GiftPaymentPostingRepository {
  if (
    !["sandbox", "live"].includes(options.environment) ||
    !reference(options.platformWalletId) ||
    typeof options.now !== "function" ||
    typeof options.generateId !== "function" ||
    !Number.isSafeInteger(options.retryDelayMs) ||
    options.retryDelayMs <= 0 ||
    options.retryDelayMs > 300_000
  )
    return unavailable();
  options = Object.freeze({ ...options });
  return {
    async postReceivedPayment(
      input: GiftPaymentPostingInput,
    ): Promise<GiftPaymentPostingResult> {
      try {
        const value = structuredClone(input);
        const claim = value.claim;
        if (
          !claim ||
          Object.keys(value).some(
            (key) => !["claim", "checkout", "observation"].includes(key),
          ) ||
          ![
            claim.eventId,
            claim.siteId,
            claim.accountId,
            claim.leaseOwner,
            claim.leaseToken,
          ].every(validId) ||
          claim.environment !== options.environment
        )
          return unavailable();
        return await db.transaction<GiftPaymentPostingResult>(
          async (tx) => {
            const binding = await readBinding(tx, value);
            const event = await readEvent(
              tx,
              claim,
              binding.row,
              value.observation,
              date(options.now()),
            );
            const raw = value.observation.payment as Record<string, unknown>;
            if (!raw || !reference(raw.id)) return unavailable();
            const existing = await currentPayment(
              tx,
              claim,
              binding.checkout,
              raw.id,
              date(options.now()),
            );
            const receipt = existing
              ? await currentReceipt(
                  tx,
                  claim,
                  binding.row,
                  existing,
                  binding.snapshot,
                  date(options.now()),
                )
              : null;
            const decision = reconcileGiftPaymentObservation({
              quoteSnapshot: binding.snapshot,
              checkout: binding.checkout,
              platformWalletId: options.platformWalletId,
              observation: value.observation,
              now: date(options.now()),
              existingTerminal: terminalEvidence(existing),
            });
            if (decision.outcome === "NO_REGRESSION") {
              if (!existing) return unavailable();
              if (event.state === "CLAIMED")
                await completeEvent(tx, claim, event, existing.id, options);
              else if (
                event.state !== "PROCESSED" ||
                event.paymentId !== existing.id ||
                microseconds(event.processedAt as Date) >
                  microseconds(options.now())
              )
                return unavailable();
              return {
                outcome: "NO_REGRESSION",
                paymentId: existing.id,
                ledgerEntryId: receipt?.id ?? null,
              };
            }
            const payment = decision.payment;
            if (
              microseconds(payment.observedAt) <
              microseconds(binding.row.orderCreatedAt)
            )
              return unavailable();
            const matches =
              existing !== null &&
              isDeepStrictEqual(
                paymentFields(existing),
                paymentFields(payment),
              );
            const stale =
              existing?.observedAt !== null &&
              existing?.observedAt !== undefined &&
              microseconds(existing.observedAt) >
                microseconds(payment.observedAt);
            const reversal =
              typeof existing?.providerStatus === "string" &&
              /^(REFUND|CHARGEBACK)|^(CANCELED|CANCELLED|DISPUTED)$/.test(
                existing.providerStatus,
              );
            let reason: RetryReason | null = decision.reason;
            if (receipt && (!decision.effect || !matches))
              reason ??= "PAYMENT_RECEIPT_MISMATCH";
            if (!receipt && stale) reason = "PAYMENT_OBSERVATION_STALE";
            if (reversal) reason = "PAYMENT_RESTRICTED";
            if (event.state !== "CLAIMED") {
              if (!existing || event.paymentId !== existing.id)
                return unavailable();
              if (event.state === "RETRY") {
                const next = microseconds(event.nextAttemptAt);
                if (
                  reason === null ||
                  event.lastErrorCode !== reason ||
                  event.processedAt !== null ||
                  (!receipt && !matches && !stale && !reversal) ||
                  next < microseconds(event.authenticatedAt) ||
                  next >
                    microseconds(event.leaseExpiresAt as Date) +
                      BigInt(options.retryDelayMs) * 1000n
                )
                  return unavailable();
                return {
                  outcome: "OBSERVED",
                  paymentId: existing.id,
                  ledgerEntryId: receipt?.id ?? null,
                };
              }
              if (
                reason !== null ||
                !receipt ||
                !matches ||
                microseconds(event.processedAt as Date) >
                  microseconds(options.now())
              )
                return unavailable();
              return {
                outcome: "DUPLICATE",
                paymentId: existing.id,
                ledgerEntryId: receipt.id,
              };
            }
            if (receipt || stale || reversal) {
              if (!existing) return unavailable();
              await completeEvent(
                tx,
                claim,
                event,
                existing.id,
                options,
                reason,
              );
              return {
                outcome: reason === null ? "DUPLICATE" : "OBSERVED",
                paymentId: existing.id,
                ledgerEntryId: receipt?.id ?? null,
              };
            }
            const paymentId = await writePayment(
              tx,
              payment,
              existing,
              options,
            );
            let ledgerEntryId: string | null = null;
            if (decision.effect) {
              ledgerEntryId = options.generateId("ledger");
              if (!validId(ledgerEntryId)) return unavailable();
              const effect = decision.effect;
              const ledger =
                await tx.execute(sql`INSERT INTO ${financialLedgerEntry} (id, site_id, account_id, environment, effect_key, kind, direction, currency, amount_cents,
              payment_id, operation_id, event_id, created_at) VALUES (${ledgerEntryId}, ${claim.siteId}, ${claim.accountId}, ${claim.environment}, ${effect.effectKey},
                ${effect.kind}, ${effect.direction}, ${effect.currency}, ${effect.amountCents}, ${paymentId}, ${binding.row.operationId}, ${claim.eventId}, ${date(options.now()).toISOString()}::timestamptz)
              ON CONFLICT (site_id, account_id, environment, effect_key) DO NOTHING RETURNING id`);
              if (
                ledger.rows.length !== 1 ||
                ledger.rows[0]?.id !== ledgerEntryId
              )
                return unavailable();
            }
            await completeEvent(tx, claim, event, paymentId, options, reason);
            return {
              outcome: decision.effect ? "POSTED" : "OBSERVED",
              paymentId,
              ledgerEntryId,
            };
          },
          { isolationLevel: "read committed" },
        );
      } catch {
        return unavailable();
      }
    },
  };
}
