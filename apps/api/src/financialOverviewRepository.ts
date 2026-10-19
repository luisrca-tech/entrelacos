import {
  giftCentsSchema,
  giftQuoteSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
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
  site,
  withdrawalIntent,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type {
  FinancialAccountBinding,
  FinancialOverviewRepository,
  StoredFinancialTotals,
} from "./financialOverview";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  type WithdrawalCompletionProof,
  withdrawalCompletedEffectKey,
} from "./withdrawalExecution";

export type FinancialOverviewRepositoryDatabase = Pick<
  DatabaseConnection["db"],
  "transaction"
>;
export interface FinancialOverviewRepositoryOptions {
  loadWithdrawalCompletionProofInTransaction?(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
  ): Promise<WithdrawalCompletionProof | null>;
  environment: "sandbox" | "live";
  now(): Date;
}
export class FinancialOverviewRepositoryError extends Error {
  readonly status = 503;
  readonly code = "FINANCIAL_OVERVIEW_REPOSITORY_UNAVAILABLE";
  constructor() {
    super("Stored financial totals are unavailable");
    this.name = "FinancialOverviewRepositoryError";
  }
}
type Transaction = Parameters<
  Parameters<FinancialOverviewRepositoryDatabase["transaction"]>[0]
>[0];
type Row = Record<string, unknown>;
interface Facts {
  payments: Row[];
  ledgers: Row[];
  events: Row[];
  withdrawals: Row[];
  operations: Row[];
}
const totalsKeys = [
  "nominalReceivedCents",
  "netReceivedCents",
  "processingCents",
  "commissionCents",
  "awaitingReleaseCents",
  "pendingCommitmentsCents",
  "withdrawnCents",
  "refundedCents",
] as const;
const inboxStates = [
  "RECEIVED",
  "CLAIMED",
  "PROCESSED",
  "RETRY",
  "DEAD_LETTER",
];
const operationStates = [
  "REQUESTED",
  "CLAIMED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
];
const heldStates = [
  "REQUESTED",
  "AWAITING_AUTHORIZATION",
  "PROCESSING",
  "UNKNOWN",
];
const restrictiveStatus =
  /^(REFUND|CHARGEBACK)|^(CANCELED|CANCELLED|DISPUTED|DELETED)$/;
const pendingPaymentStates = [
  "PENDING",
  "OVERDUE",
  "AWAITING_RISK_ANALYSIS",
  "DUNNING_REQUESTED",
];
const unsupportedReversalEvent =
  /^(REFUND|TRANSFER)_|^PAYMENT_(REFUND|CHARGEBACK)/;

function unavailable(): never {
  throw new FinancialOverviewRepositoryError();
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  return value as Row;
}
function localId(value: unknown): string {
  const parsed = giftQuoteSchema.shape.siteId.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}
function optionalReference(value: unknown): string | null {
  return value === null ? null : reference(value);
}
function cents(value: unknown, positive = false): number {
  const parsed = giftCentsSchema.safeParse(value);
  if (!parsed.success || (positive && parsed.data < 1)) return unavailable();
  return parsed.data;
}
function nativeTime(value: unknown): Date {
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    !/^\d{4}-/.test(value.toISOString())
  )
    return unavailable();
  return new Date(value.getTime());
}
function storedTime(value: unknown, observedAt: Date): Date {
  const parsed = readDatabaseTimestamp(value);
  if (compareDatabaseTimestamps(parsed, observedAt) > 0) return unavailable();
  return parsed;
}
function after(left: Date, right: Date): void {
  if (compareDatabaseTimestamps(left, right) < 0) unavailable();
}
function bindingInput(
  value: FinancialAccountBinding,
  environment: string,
): FinancialAccountBinding {
  const raw = object(value);
  if (
    Object.keys(raw).sort().join(",") !==
      "accountBindingId,accountReference,environment,provider,siteId" ||
    raw.provider !== "ASAAS" ||
    raw.environment !== environment
  )
    return unavailable();
  const storedSite = siteIdSchema.safeParse(raw.siteId);
  if (!storedSite.success) return unavailable();
  return {
    provider: "ASAAS",
    siteId: storedSite.data,
    accountBindingId: localId(raw.accountBindingId),
    accountReference: reference(raw.accountReference),
    environment: environment as "sandbox" | "live",
  };
}
function scoped(
  rows: Row[],
  binding: FinancialAccountBinding,
): Map<string, Row> {
  const found = new Map<string, Row>();
  for (const row of rows) {
    const id = localId(row.id);
    if (
      row.siteId !== binding.siteId ||
      row.accountId !== binding.accountBindingId ||
      row.environment !== binding.environment ||
      found.has(id)
    )
      return unavailable();
    found.set(id, row);
  }
  return found;
}
async function rows(
  tx: Transaction,
  statement: ReturnType<typeof sql>,
): Promise<Row[]> {
  const result = await tx.execute(statement);
  if (!Array.isArray(result.rows)) return unavailable();
  return result.rows.map(object);
}
async function loadBinding(
  tx: Transaction,
  binding: FinancialAccountBinding,
): Promise<Date | null> {
  const loaded = await rows(
    tx,
    sql`SELECT a.id AS "accountBindingId", a.site_id AS "siteId", a.environment AS "environment", a.provider AS "provider", a.account_reference AS "accountReference", st.is_demo AS "isDemo", clock_timestamp() AS "observedAt"
    FROM ${receivingAccount} a INNER JOIN ${site} st ON st.id = a.site_id
    WHERE a.id = ${binding.accountBindingId} AND a.site_id = ${binding.siteId} AND a.environment = ${binding.environment}`,
  );
  if (loaded.length === 0) return null;
  const row = loaded[0];
  if (
    loaded.length !== 1 ||
    row.provider !== binding.provider ||
    row.siteId !== binding.siteId ||
    row.accountBindingId !== binding.accountBindingId ||
    row.environment !== binding.environment ||
    row.accountReference !== binding.accountReference ||
    typeof row.isDemo !== "boolean" ||
    (binding.environment === "live" && row.isDemo)
  )
    return unavailable();
  return readDatabaseTimestamp(row.observedAt);
}
async function loadFacts(
  tx: Transaction,
  b: FinancialAccountBinding,
): Promise<Facts> {
  const [payments, ledgers, events, withdrawals, operations] =
    await Promise.all([
      rows(
        tx,
        sql`SELECT p.id AS "id", p.site_id AS "siteId", p.account_id AS "accountId", p.environment AS "environment", p.order_id AS "orderId", p.attempt_id AS "attemptId", p.provider_payment_reference AS "providerPaymentReference", p.provider_status AS "providerStatus", p.verification_status AS "verificationStatus", p.observed_at AS "observedAt", p.created_at AS "createdAt", p.currency AS "currency", p.gross_cents AS "grossCents", p.processing_cents AS "processingCents", p.commission_cents AS "commissionCents", p.recipient_net_cents AS "recipientNetCents", p.split_provider_reference AS "splitProviderReference", p.split_fixed_cents AS "splitFixedCents",
      o.id AS "storedOrderId", o.quote_id AS "orderQuoteId", o.created_at AS "orderCreatedAt", q.id AS "quoteId", q.currency AS "quoteCurrency", q.nominal_cents AS "quoteNominalCents", q.commission_basis_points AS "quoteCommissionBasisPoints", q.commission_cents AS "quoteCommissionCents", q.processing_cents AS "quoteProcessingCents", q.total_cents AS "quoteTotalCents", q.snapshot AS "quoteSnapshot", q.snapshot->'receiving'->>'accountReference' AS "quoteAccountReference", q.snapshot->'receiving'->>'siteId' AS "quoteSiteId", q.snapshot->'receiving'->>'environment' AS "quoteEnvironment", q.snapshot->'receiving'->>'provider' AS "quoteProvider",
      a.id AS "storedAttemptId", a.order_id AS "attemptOrderId", a.operation_id AS "attemptOperationId", a.provider_reference AS "providerCheckoutReference", op.id AS "operationId", op.kind AS "operationKind", op.state AS "operationState", op.provider_operation_reference AS "providerOperationReference"
      FROM ${giftPaymentRecord} p
      LEFT JOIN ${giftOrder} o ON o.id = p.order_id AND o.site_id = p.site_id AND o.account_id = p.account_id AND o.environment = p.environment
      LEFT JOIN ${giftQuoteRecord} q ON q.id = o.quote_id AND q.site_id = o.site_id AND q.account_id = o.account_id AND q.environment = o.environment
      LEFT JOIN ${giftCheckoutAttempt} a ON a.id = p.attempt_id AND a.order_id = p.order_id AND a.site_id = p.site_id AND a.account_id = p.account_id AND a.environment = p.environment
      LEFT JOIN ${financialOperation} op ON op.id = a.operation_id AND op.order_id = a.order_id AND op.kind = a.operation_kind AND op.site_id = a.site_id AND op.account_id = a.account_id AND op.environment = a.environment
      WHERE p.site_id = ${b.siteId} AND p.account_id = ${b.accountBindingId} AND p.environment = ${b.environment}`,
      ),
      rows(
        tx,
        sql`SELECT l.id AS "id", l.site_id AS "siteId", l.account_id AS "accountId", l.environment AS "environment", l.effect_key AS "effectKey", l.kind AS "kind", l.direction AS "direction", l.currency AS "currency", l.amount_cents AS "amountCents", l.payment_id AS "paymentId", l.withdrawal_intent_id AS "withdrawalIntentId", l.operation_id AS "operationId", l.event_id AS "eventId", l.compensates_entry_id AS "compensatesEntryId", l.created_at AS "createdAt"
      FROM ${financialLedgerEntry} l WHERE l.site_id = ${b.siteId} AND l.account_id = ${b.accountBindingId} AND l.environment = ${b.environment}`,
      ),
      rows(
        tx,
        sql`SELECT e.id AS "id", e.site_id AS "siteId", e.account_id AS "accountId", e.environment AS "environment", e.provider_event_reference AS "providerEventReference", e.event_type AS "eventType", e.payload_hash AS "payloadHash", e.payload AS "payload", e.payment_id AS "paymentId", e.state AS "state", e.received_at AS "receivedAt", e.authenticated_at AS "authenticatedAt", e.processed_at AS "processedAt"
      FROM ${financialEventInbox} e WHERE e.site_id = ${b.siteId} AND e.account_id = ${b.accountBindingId} AND e.environment = ${b.environment}`,
      ),
      rows(
        tx,
        sql`SELECT w.id AS "id", w.site_id AS "siteId", w.account_id AS "accountId", w.environment AS "environment", w.amount_cents AS "amountCents", w.fee_cents AS "feeCents", w.net_cents AS "netCents", w.currency AS "currency", w.destination_version AS "destinationVersion", w.state AS "state", w.reservation_state AS "reservationState", w.reserved_cents AS "reservedCents", w.provider_reference AS "providerReference", w.receipt_reference AS "receiptReference", w.resolution_observed_at AS "resolutionObservedAt", w.created_at AS "createdAt", w.updated_at AS "updatedAt"
      FROM ${withdrawalIntent} w WHERE w.site_id = ${b.siteId} AND w.account_id = ${b.accountBindingId} AND w.environment = ${b.environment}`,
      ),
      rows(
        tx,
        sql`SELECT op.id AS "id", op.site_id AS "siteId", op.account_id AS "accountId", op.environment AS "environment", op.kind AS "kind", op.state AS "state", op.order_id AS "orderId", op.withdrawal_intent_id AS "withdrawalIntentId", op.payment_id AS "paymentId", op.provider_operation_reference AS "providerOperationReference", op.created_at AS "createdAt", op.updated_at AS "updatedAt"
      FROM ${financialOperation} op WHERE op.site_id = ${b.siteId} AND op.account_id = ${b.accountBindingId} AND op.environment = ${b.environment}`,
      ),
    ]);
  return { payments, ledgers, events, withdrawals, operations };
}
function eventPayload(
  event: Row,
  binding: FinancialAccountBinding,
  observedAt: Date,
): Record<string, string> {
  if (
    !inboxStates.includes(String(event.state)) ||
    typeof event.eventType !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(event.eventType) ||
    typeof event.providerEventReference !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(event.providerEventReference)
  )
    return unavailable();
  const payload = object(event.payload);
  const allowed = [
    "paymentId",
    "checkoutId",
    "transferId",
    "refundId",
    "accountId",
    "externalReference",
    "accessTokenId",
  ];
  for (const [key, value] of Object.entries(payload)) {
    if (
      !allowed.includes(key) ||
      typeof value !== "string" ||
      !new RegExp(
        `^[\\x21-\\x7e]{1,${key === "externalReference" ? 200 : 256}}$`,
      ).test(value)
    )
      return unavailable();
  }
  if (
    event.payloadHash !==
      hashAsaasEventIdentity(
        event.providerEventReference,
        event.eventType,
        binding.accountReference,
        payload as Record<string, string>,
      ) ||
    (payload.accountId !== undefined &&
      payload.accountId !== binding.accountReference)
  )
    return unavailable();
  const authenticated = storedTime(event.authenticatedAt, observedAt);
  const received = storedTime(event.receivedAt, observedAt);
  after(authenticated, received);
  if (event.paymentId !== null) localId(event.paymentId);
  if (event.state === "PROCESSED") {
    const processed = storedTime(event.processedAt, observedAt);
    after(processed, authenticated);
    after(processed, received);
  } else if (event.processedAt !== null) return unavailable();
  return payload as Record<string, string>;
}
function operation(row: Row, observedAt: Date): void {
  if (!operationStates.includes(String(row.state))) unavailable();
  const created = storedTime(row.createdAt, observedAt);
  after(storedTime(row.updatedAt, observedAt), created);
  optionalReference(row.providerOperationReference);
  const order = row.orderId === null ? null : localId(row.orderId);
  const payment = row.paymentId === null ? null : localId(row.paymentId);
  const withdrawal =
    row.withdrawalIntentId === null ? null : localId(row.withdrawalIntentId);
  if (
    !(
      (row.kind === "ACCOUNT_CREATE" &&
        order === null &&
        payment === null &&
        withdrawal === null) ||
      (row.kind === "CHECKOUT_CREATE" &&
        order !== null &&
        payment === null &&
        withdrawal === null) ||
      (row.kind === "WITHDRAWAL" &&
        order === null &&
        payment === null &&
        withdrawal !== null) ||
      (row.kind === "REFUND" &&
        order !== null &&
        payment !== null &&
        withdrawal === null)
    )
  )
    unavailable();
}
function withdrawal(row: Row, observedAt: Date): void {
  const amount = cents(row.amountCents, true);
  const fee = cents(row.feeCents);
  const net = cents(row.netCents, true);
  if (
    row.currency !== "BRL" ||
    BigInt(amount) !== BigInt(fee) + BigInt(net) ||
    !Number.isSafeInteger(row.destinationVersion) ||
    Number(row.destinationVersion) < 1
  )
    unavailable();
  const created = storedTime(row.createdAt, observedAt);
  after(storedTime(row.updatedAt, observedAt), created);
  optionalReference(row.providerReference);
  optionalReference(row.receiptReference);
  if (heldStates.includes(String(row.state))) {
    if (
      row.reservationState !== "HELD" ||
      cents(row.reservedCents) !== amount ||
      row.resolutionObservedAt !== null
    )
      unavailable();
  } else if (["COMPLETED", "FAILED", "CANCELLED"].includes(String(row.state))) {
    if (
      row.reservationState !==
        (row.state === "COMPLETED" ? "CONSUMED" : "RELEASED") ||
      cents(row.reservedCents) !== 0
    )
      unavailable();
    after(storedTime(row.resolutionObservedAt, observedAt), created);
  } else unavailable();
}
function payment(
  row: Row,
  binding: FinancialAccountBinding,
  observedAt: Date,
): void {
  reference(row.providerPaymentReference);
  const orderId = localId(row.orderId);
  const attemptId = localId(row.attemptId);
  localId(row.quoteId);
  localId(row.operationId);
  const checkoutRef = reference(row.providerCheckoutReference);
  if (
    row.storedOrderId !== orderId ||
    row.orderQuoteId !== row.quoteId ||
    row.storedAttemptId !== attemptId ||
    row.attemptOrderId !== orderId ||
    row.attemptOperationId !== row.operationId ||
    row.operationKind !== "CHECKOUT_CREATE" ||
    row.operationState !== "SUCCEEDED" ||
    row.providerOperationReference !== checkoutRef ||
    row.quoteAccountReference !== binding.accountReference ||
    row.quoteSiteId !== binding.siteId ||
    row.quoteEnvironment !== binding.environment ||
    row.quoteProvider !== "ASAAS" ||
    row.currency !== "BRL" ||
    row.quoteCurrency !== "BRL" ||
    row.verificationStatus !== "VERIFIED" ||
    typeof row.providerStatus !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(row.providerStatus)
  )
    unavailable();
  const orderCreated = storedTime(row.orderCreatedAt, observedAt);
  after(storedTime(row.createdAt, observedAt), orderCreated);
  after(storedTime(row.observedAt, observedAt), orderCreated);
  const nominal = cents(row.quoteNominalCents, true);
  const commission = cents(row.quoteCommissionCents);
  const processing = cents(row.quoteProcessingCents);
  const total = cents(row.quoteTotalCents, true);
  const actualProcessing = cents(row.processingCents);
  const recipientNet = cents(row.recipientNetCents, true);
  const snapshot = object(row.quoteSnapshot);
  const quote = snapshot.quote === undefined ? {} : object(snapshot.quote);
  const pricing =
    snapshot.pricing === undefined ? {} : object(snapshot.pricing);
  const policy = pricing.policy === undefined ? {} : object(pricing.policy);
  const allocation = giftQuoteSchema.shape.feeAllocation.safeParse(
    quote.feeAllocation,
  );
  if (!allocation.success || quote.feeAllocation !== policy.feeAllocation)
    unavailable();
  const quoteAllocated =
    allocation.data === "RECIPIENT_DEDUCTED"
      ? total === nominal &&
        BigInt(total) > BigInt(commission) + BigInt(processing)
      : BigInt(total) ===
        BigInt(nominal) + BigInt(commission) + BigInt(processing);
  if (
    row.quoteCommissionBasisPoints !== 200 ||
    BigInt(commission) !== (BigInt(nominal) * 200n + 5000n) / 10000n ||
    !quoteAllocated ||
    cents(row.grossCents, true) !== total ||
    BigInt(total) !==
      BigInt(actualProcessing) + BigInt(commission) + BigInt(recipientNet) ||
    (!(row.providerStatus === "CONFIRMED" && row.commissionCents === null) &&
      cents(row.commissionCents) !== commission) ||
    cents(row.splitFixedCents) !== commission ||
    (commission > 0 && optionalReference(row.splitProviderReference) === null)
  )
    unavailable();
  optionalReference(row.splitProviderReference);
}
function ledger(row: Row, observedAt: Date): void {
  cents(row.amountCents, true);
  if (
    row.currency !== "BRL" ||
    !["CREDIT", "DEBIT"].includes(String(row.direction)) ||
    typeof row.kind !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(row.kind) ||
    typeof row.effectKey !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(row.effectKey)
  )
    unavailable();
  for (const key of [
    "paymentId",
    "withdrawalIntentId",
    "operationId",
    "eventId",
    "compensatesEntryId",
  ])
    if (row[key] !== null) localId(row[key]);
  storedTime(row.createdAt, observedAt);
}
function indexed(
  facts: Facts,
  binding: FinancialAccountBinding,
  observedAt: Date,
) {
  const maps = {
    payments: scoped(facts.payments, binding),
    ledgers: scoped(facts.ledgers, binding),
    events: scoped(facts.events, binding),
    withdrawals: scoped(facts.withdrawals, binding),
    operations: scoped(facts.operations, binding),
  };
  const providerPayments = new Set<string>();
  for (const row of maps.payments.values()) {
    payment(row, binding, observedAt);
    if (providerPayments.has(String(row.providerPaymentReference)))
      return unavailable();
    providerPayments.add(String(row.providerPaymentReference));
    const op = maps.operations.get(String(row.operationId));
    if (
      !op ||
      op.kind !== row.operationKind ||
      op.state !== row.operationState ||
      op.orderId !== row.orderId ||
      op.providerOperationReference !== row.providerOperationReference
    )
      return unavailable();
  }
  const providerEvents = new Set<string>();
  const payloads = new Map<string, Record<string, string>>();
  for (const row of maps.events.values()) {
    payloads.set(String(row.id), eventPayload(row, binding, observedAt));
    if (providerEvents.has(String(row.providerEventReference)))
      return unavailable();
    providerEvents.add(String(row.providerEventReference));
    if (row.paymentId !== null && !maps.payments.has(String(row.paymentId)))
      return unavailable();
  }
  for (const row of maps.operations.values()) {
    operation(row, observedAt);
    if (
      row.kind === "WITHDRAWAL" &&
      !maps.withdrawals.has(String(row.withdrawalIntentId))
    )
      return unavailable();
    if (row.kind === "REFUND") {
      const p = maps.payments.get(String(row.paymentId));
      if (!p || p.orderId !== row.orderId || row.state === "SUCCEEDED")
        return unavailable();
    }
  }
  for (const row of maps.withdrawals.values()) withdrawal(row, observedAt);
  const effects = new Set<string>();
  for (const row of maps.ledgers.values()) {
    ledger(row, observedAt);
    if (
      (row.paymentId === null &&
        row.withdrawalIntentId === null &&
        row.compensatesEntryId === null) ||
      (row.paymentId !== null && !maps.payments.has(String(row.paymentId))) ||
      (row.withdrawalIntentId !== null &&
        !maps.withdrawals.has(String(row.withdrawalIntentId))) ||
      (row.operationId !== null &&
        !maps.operations.has(String(row.operationId))) ||
      (row.eventId !== null && !maps.events.has(String(row.eventId))) ||
      (row.compensatesEntryId !== null &&
        (!maps.ledgers.has(String(row.compensatesEntryId)) ||
          row.compensatesEntryId === row.id))
    )
      return unavailable();
    if (effects.has(String(row.effectKey))) return unavailable();
    effects.add(String(row.effectKey));
  }
  return { ...maps, payloads };
}
function unresolved(data: ReturnType<typeof indexed>): number {
  let count = 0;
  // Count unresolved facts, not deduplicated monetary actions. Any positive count
  // denies availability; processed reversals lack a reviewed compensation writer.
  for (const row of data.events.values())
    if (
      (row.state !== "PROCESSED" &&
        /^(PAYMENT|CHECKOUT|TRANSFER|REFUND)_/.test(String(row.eventType))) ||
      (row.state === "PROCESSED" &&
        unsupportedReversalEvent.test(String(row.eventType)))
    )
      count++;
  for (const row of data.operations.values())
    if (row.state === "UNKNOWN" || row.kind === "REFUND") count++;
  for (const row of data.payments.values())
    if (
      restrictiveStatus.test(String(row.providerStatus)) ||
      !["RECEIVED", "CONFIRMED", ...pendingPaymentStates].includes(
        String(row.providerStatus),
      )
    )
      count++;
  for (const row of data.withdrawals.values())
    if (row.state === "UNKNOWN") count++;
  if (!Number.isSafeInteger(count)) return unavailable();
  return count;
}
function aggregate(
  data: ReturnType<typeof indexed>,
  observedAt: Date,
): StoredFinancialTotals {
  const sums = Object.fromEntries(totalsKeys.map((key) => [key, 0n])) as Record<
    (typeof totalsKeys)[number],
    bigint
  >;
  const credited = new Set<string>();
  const completedWithdrawals = new Set<string>();
  for (const op of data.operations.values())
    if (op.kind === "REFUND") return unavailable();
  for (const event of data.events.values())
    if (
      event.state === "PROCESSED" &&
      unsupportedReversalEvent.test(String(event.eventType))
    )
      return unavailable();
  // These are cumulative historical receipt allocations, never a pool balance.
  // Only a verified actual recipient net matching its conserved allocation counts.
  for (const entry of data.ledgers.values()) {
    if (entry.kind === "WITHDRAWAL_COMPLETED") {
      const w = data.withdrawals.get(String(entry.withdrawalIntentId));
      const op = data.operations.get(String(entry.operationId));
      const proof = w?.completionProof as WithdrawalCompletionProof | null;
      const c = proof?.correlation;
      if (
        !w ||
        !op ||
        !proof ||
        !c ||
        completedWithdrawals.has(String(w.id)) ||
        w.state !== "COMPLETED" ||
        op.kind !== "WITHDRAWAL" ||
        op.state !== "SUCCEEDED" ||
        op.withdrawalIntentId !== w.id ||
        proof.outcome !== "COMPLETED" ||
        proof.custody !== "immutable-durable" ||
        proof.verification !== "verified" ||
        proof.provenance !== "provider" ||
        proof.bankCompleted !== true ||
        proof.currency !== "BRL" ||
        c.siteId !== w.siteId ||
        c.accountId !== w.accountId ||
        c.environment !== w.environment ||
        c.withdrawalId !== w.id ||
        c.operationId !== op.id ||
        c.amountCents !== w.amountCents ||
        c.feeCents !== w.feeCents ||
        c.netCents !== w.netCents ||
        proof.proofReference !== w.receiptReference ||
        proof.receiptReference !== w.receiptReference ||
        proof.providerReference !== w.providerReference ||
        op.providerOperationReference !== w.providerReference ||
        entry.direction !== "DEBIT" ||
        entry.currency !== "BRL" ||
        entry.paymentId !== null ||
        entry.eventId !== null ||
        entry.compensatesEntryId !== null ||
        entry.effectKey !== withdrawalCompletedEffectKey(c) ||
        cents(entry.amountCents, true) !== cents(proof.totalDebitCents, true) ||
        proof.totalDebitCents !== proof.netCents + proof.feeCents ||
        proof.netCents !== w.netCents ||
        cents(proof.feeCents) > Number(w.feeCents) ||
        proof.totalDebitCents > Number(w.amountCents)
      )
        return unavailable();
      const completed = storedTime(proof.observedAt, observedAt);
      const recorded = storedTime(proof.recordedAt, observedAt);
      after(recorded, completed);
      after(storedTime(entry.createdAt, observedAt), recorded);
      if (
        compareDatabaseTimestamps(
          completed,
          storedTime(w.resolutionObservedAt, observedAt),
        ) !== 0
      )
        return unavailable();
      completedWithdrawals.add(String(w.id));
      sums.withdrawnCents += BigInt(proof.totalDebitCents);
      continue;
    }
    const p = data.payments.get(String(entry.paymentId));
    const e = data.events.get(String(entry.eventId));
    const payload = data.payloads.get(String(entry.eventId));
    if (
      !p ||
      !e ||
      !payload ||
      entry.kind !== "GIFT_RECEIVED" ||
      entry.direction !== "CREDIT" ||
      entry.amountCents !== p.recipientNetCents ||
      entry.effectKey !==
        giftReceivedEffectKey(String(p.providerPaymentReference)) ||
      entry.withdrawalIntentId !== null ||
      entry.compensatesEntryId !== null ||
      entry.operationId !== p.operationId ||
      e.state !== "PROCESSED" ||
      e.eventType !== "PAYMENT_RECEIVED" ||
      e.paymentId !== p.id ||
      payload.paymentId !== p.providerPaymentReference ||
      (payload.externalReference !== undefined &&
        payload.externalReference !== p.attemptId) ||
      (payload.checkoutId !== undefined &&
        payload.checkoutId !== p.providerCheckoutReference) ||
      credited.has(String(p.id)) ||
      p.providerStatus === "REFUNDED" ||
      (p.providerStatus !== "RECEIVED" &&
        !restrictiveStatus.test(String(p.providerStatus)))
    )
      return unavailable();
    const created = storedTime(entry.createdAt, observedAt);
    after(created, storedTime(p.orderCreatedAt, observedAt));
    after(created, storedTime(e.authenticatedAt, observedAt));
    after(created, storedTime(e.receivedAt, observedAt));
    after(storedTime(e.processedAt, observedAt), created);
    credited.add(String(p.id));
    sums.nominalReceivedCents += BigInt(cents(p.quoteNominalCents));
    sums.netReceivedCents += BigInt(cents(p.recipientNetCents));
    sums.processingCents += BigInt(cents(p.processingCents));
    sums.commissionCents += BigInt(cents(p.commissionCents));
  }
  for (const p of data.payments.values()) {
    if (credited.has(String(p.id))) continue;
    if (p.providerStatus === "CONFIRMED")
      sums.awaitingReleaseCents += BigInt(cents(p.recipientNetCents));
    else if (
      p.providerStatus === "RECEIVED" ||
      restrictiveStatus.test(String(p.providerStatus))
    )
      return unavailable();
    else if (!pendingPaymentStates.includes(String(p.providerStatus)))
      return unavailable();
  }
  // Terminal withdrawals count only through the reviewed immutable provider proof.
  // Unproven terminal states and all refund compensation remain unavailable.
  for (const w of data.withdrawals.values()) {
    if (w.state === "COMPLETED" && completedWithdrawals.has(String(w.id)))
      continue;
    if (!heldStates.includes(String(w.state))) return unavailable();
    sums.pendingCommitmentsCents += BigInt(cents(w.reservedCents));
  }
  return Object.fromEntries(
    totalsKeys.map((key) => {
      if (sums[key] > 2147483647n) return unavailable();
      return [key, Number(sums[key])];
    }),
  ) as StoredFinancialTotals;
}
export function createFinancialOverviewRepository(
  db: FinancialOverviewRepositoryDatabase,
  options: FinancialOverviewRepositoryOptions,
): FinancialOverviewRepository {
  const environment = options.environment;
  const now = options.now;
  const transaction = db.transaction.bind(db);
  async function read<T>(
    input: FinancialAccountBinding,
    inspect: (
      data: ReturnType<typeof indexed>,
      binding: FinancialAccountBinding,
      observedAt: Date,
    ) => T,
  ): Promise<T | null> {
    try {
      if (
        !["sandbox", "live"].includes(environment) ||
        typeof now !== "function"
      )
        return unavailable();
      const binding = bindingInput(input, environment);
      const startedAt = nativeTime(now());
      return await transaction(
        async (tx) => {
          const observedAt = await loadBinding(tx, binding);
          if (observedAt === null) return null;
          const facts = await loadFacts(tx, binding);
          for (const withdrawal of facts.withdrawals) {
            if (
              withdrawal.state === "COMPLETED" &&
              options.loadWithdrawalCompletionProofInTransaction
            )
              withdrawal.completionProof =
                await options.loadWithdrawalCompletionProofInTransaction(
                  tx,
                  String(withdrawal.id),
                  String(withdrawal.receiptReference),
                );
          }
          const finishedAt = nativeTime(now());
          after(finishedAt, startedAt);
          after(finishedAt, observedAt);
          return inspect(
            indexed(facts, binding, observedAt),
            binding,
            observedAt,
          );
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch {
      return unavailable();
    }
  }
  return {
    async loadStoredTotals(binding) {
      return read(binding, (data, frozenBinding, observedAt) => ({
        binding: frozenBinding,
        currency: "BRL",
        totals: aggregate(data, observedAt),
        observedAt,
        lastBalanceObservation: null,
        unresolvedFinancialEventCount: unresolved(data),
      }));
    },
    async checkBalanceConsistency(binding, balanceObservedAt) {
      let bound: Date;
      try {
        bound = nativeTime(balanceObservedAt);
      } catch {
        return unavailable();
      }
      return read(binding, (data, frozenBinding, checkedAt) => {
        after(checkedAt, bound);
        let effects = 0;
        // Inclusive comparison covers effects committed at the GET's conservative
        // lower bound. This later snapshot is informational, not withdrawal authority.
        // Completed/debit markers conservatively block; they do not prove totals.
        for (const entry of data.ledgers.values())
          if (
            entry.direction === "DEBIT" &&
            compareDatabaseTimestamps(
              storedTime(entry.createdAt, checkedAt),
              bound,
            ) >= 0
          )
            effects++;
        for (const w of data.withdrawals.values())
          if (
            w.state === "COMPLETED" &&
            (compareDatabaseTimestamps(
              storedTime(w.updatedAt, checkedAt),
              bound,
            ) >= 0 ||
              compareDatabaseTimestamps(
                storedTime(w.resolutionObservedAt, checkedAt),
                bound,
              ) >= 0)
          )
            effects++;
        if (!Number.isSafeInteger(effects)) return unavailable();
        return {
          binding: frozenBinding,
          balanceObservedAt: bound,
          checkedAt,
          unresolvedFinancialEventCount: unresolved(data),
          balanceEffectsAfterObservationCount: effects,
        };
      });
    },
  };
}
