import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  checkoutResultSchema,
  giftCentsSchema,
  giftQuoteSchema,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftCheckoutAttempt,
  giftItem,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import {
  type GiftCheckoutEvidence,
  type GiftCheckoutHostedOutcome,
  type GiftCheckoutIdentity,
  type GiftCheckoutRecord,
  type GiftCheckoutRepository,
  type GiftCheckoutReservation,
  GiftCheckoutServiceError,
  isSafeCheckoutContinuation,
  readGiftQuoteSnapshot,
} from "./giftCheckouts";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import type {
  GiftQuoteReceivingContext,
  GiftQuoteSnapshot,
} from "./giftQuotes";
import {
  assertReceivingReady,
  evaluateReceivingReadiness,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";

export type GiftCheckoutDatabase = Pick<
  DatabaseConnection["db"],
  "execute" | "transaction"
>;
export type GiftCheckoutTransaction = Parameters<
  Parameters<GiftCheckoutDatabase["transaction"]>[0]
>[0];
type GiftCheckoutReader = Pick<GiftCheckoutDatabase, "execute">;
export interface GiftCheckoutAccountScope {
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
}

export interface GiftCheckoutRepositoryOptions {
  instanceId: string;
  leaseMs: number;
  now(): Date;
  // Stored reads using this transaction only; never a nested transaction or provider call.
  loadStoredReceivingContext(
    tx: GiftCheckoutTransaction,
    scope: GiftCheckoutAccountScope,
  ): Promise<GiftQuoteReceivingContext | null>;
}

interface QuoteRow extends GiftCheckoutAccountScope {
  quoteId: string;
  giftId: string;
  destinationVersion: number;
  method: GiftQuoteSnapshot["quote"]["method"];
  currency: string;
  nominalCents: number;
  commissionBasisPoints: number;
  commissionCents: number;
  processingCents: number;
  totalCents: number;
  policyVersion: string;
  snapshot: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

interface OrderRow extends QuoteRow {
  orderId: string;
  requestId: string;
  requestHash: string;
  recoveryTokenHash: string;
  orderCreatedAt: Date;
}

interface AttemptRow extends GiftCheckoutAccountScope {
  attemptId: string;
  orderId: string;
  operationId: string;
  operationKind: string;
  attemptNumber: number;
  providerReference: string | null;
  hostedUrl: string | null;
  expiresAt: Date | null;
  operationState: string;
  operationAttempts: number;
  operationRequestId: string;
  operationRequestHash: string;
  requestSnapshot: Record<string, unknown>;
  providerOperationReference: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

type PaymentRow = typeof giftPaymentRecord.$inferSelect;
type LedgerRow = typeof financialLedgerEntry.$inferSelect;
type EventRow = typeof financialEventInbox.$inferSelect;

const quoteColumns = sql`
  q.id AS "quoteId", q.site_id AS "siteId", q.account_id AS "accountId", q.environment,
  q.gift_id AS "giftId", q.destination_version AS "destinationVersion", q.method, q.currency, q.nominal_cents AS "nominalCents",
  q.commission_basis_points AS "commissionBasisPoints", q.commission_cents AS "commissionCents",
  q.processing_cents AS "processingCents", q.total_cents AS "totalCents",
  q.policy_version AS "policyVersion", q.snapshot, q.created_at AS "createdAt", q.expires_at AS "expiresAt"
`;

function fail(
  code: "QUOTE_INVALID" | "REQUEST_CONFLICT" | "EXTERNAL_OUTCOME_UNKNOWN",
): never {
  throw new GiftCheckoutServiceError(code);
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof GiftCheckoutServiceError ||
      error instanceof ReceivingReadinessServiceError
    )
      throw error;
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23505"
    )
      return fail("REQUEST_CONFLICT");
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  }
}

function instant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const result = value.toISOString();
  if (!giftQuoteSchema.shape.expiresAt.safeParse(result).success)
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return result;
}

function now(options: GiftCheckoutRepositoryOptions): Date {
  return new Date(instant(options.now()));
}

function scoped(
  row: GiftCheckoutAccountScope,
  scope: GiftCheckoutAccountScope,
) {
  return (
    row.siteId === scope.siteId &&
    row.accountId === scope.accountId &&
    row.environment === scope.environment
  );
}

function nonempty(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 512
  );
}

function validIdentity(identity: GiftCheckoutIdentity) {
  if (
    !identity ||
    !Object.values({
      siteId: identity.siteId,
      quoteId: identity.quoteId,
      requestId: identity.requestId,
      orderId: identity.orderId,
      attemptId: identity.attemptId,
    }).every((value) => giftQuoteSchema.shape.siteId.safeParse(value).success)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
}

function sameIdentity(left: GiftCheckoutIdentity, right: GiftCheckoutIdentity) {
  return (
    left.siteId === right.siteId &&
    left.quoteId === right.quoteId &&
    left.requestId === right.requestId &&
    left.orderId === right.orderId &&
    left.attemptId === right.attemptId
  );
}

function sameBinding(
  left: GiftQuoteSnapshot["receiving"],
  right: GiftQuoteReceivingContext["providerBinding"],
) {
  return (
    right !== null &&
    left.siteId === right.siteId &&
    left.environment === right.environment &&
    left.provider === right.provider &&
    left.operatorReference === right.operatorReference &&
    left.accountReference === right.accountReference &&
    left.recipientReference === right.recipientReference &&
    left.destinationVersion === right.destinationVersion &&
    left.bankReference === right.bankReference
  );
}

function operationSnapshot(
  row: GiftCheckoutAccountScope,
  identity: GiftCheckoutIdentity,
) {
  return {
    version: 1,
    siteId: row.siteId,
    accountId: row.accountId,
    environment: row.environment,
    quoteId: identity.quoteId,
    orderId: identity.orderId,
    attemptId: identity.attemptId,
    requestId: identity.requestId,
  };
}

function preDispatchRejection(
  identity: GiftCheckoutIdentity & {
    recoveryTokenHash: string;
    createdAt: string;
  },
  expiresAt: Date,
): Extract<GiftCheckoutEvidence, { source: "backend" }> {
  return {
    source: "backend",
    kind: "PRE_DISPATCH_REJECTION",
    siteId: identity.siteId,
    quoteId: identity.quoteId,
    requestId: identity.requestId,
    orderId: identity.orderId,
    attemptId: identity.attemptId,
    recoveryTokenHash: identity.recoveryTokenHash,
    observedAt: identity.createdAt,
    noProviderCall: true,
    closedReason:
      expiresAt.getTime() <= Date.parse(identity.createdAt)
        ? "EXPIRED"
        : "CANCELED",
  };
}

function requestHash(
  identity: Pick<
    GiftCheckoutReservation,
    "siteId" | "requestId" | "quoteId" | "recoveryTokenHash"
  >,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "gift-checkout-create-v1",
        identity.siteId,
        identity.requestId,
        identity.quoteId,
        identity.recoveryTokenHash,
      ]),
    )
    .digest("hex");
}

export function giftReceivedEffectKey(
  providerPaymentReference: string,
): string {
  return `GIFT_RECEIVED:${createHash("sha256").update(providerPaymentReference, "utf8").digest("hex")}`;
}

function snapshot(row: QuoteRow): GiftQuoteSnapshot {
  let value: GiftQuoteSnapshot;
  try {
    value = structuredClone(
      readGiftQuoteSnapshot(row.snapshot as unknown as GiftQuoteSnapshot),
    );
  } catch {
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  }
  const quote = value.quote;
  if (
    quote.id !== row.quoteId ||
    quote.siteId !== row.siteId ||
    quote.giftId !== row.giftId ||
    quote.mode !== row.environment ||
    quote.method !== row.method ||
    quote.currency !== row.currency ||
    quote.nominalCents !== row.nominalCents ||
    quote.commissionBasisPoints !== row.commissionBasisPoints ||
    quote.commissionCents !== row.commissionCents ||
    quote.processingCents !== row.processingCents ||
    quote.totalCents !== row.totalCents ||
    quote.policyVersion !== row.policyVersion ||
    compareDatabaseTimestamps(new Date(value.createdAt), row.createdAt) !== 0 ||
    compareDatabaseTimestamps(new Date(value.expiresAt), row.expiresAt) !== 0 ||
    value.receiving.destinationVersion !== row.destinationVersion
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return value;
}

async function quoteRow(
  tx: GiftCheckoutReader,
  siteId: string,
  quoteId: string,
  lock = false,
): Promise<QuoteRow | null> {
  const result =
    await tx.execute(sql`SELECT ${quoteColumns} FROM ${giftQuoteRecord} q
    WHERE q.site_id = ${siteId} AND q.id = ${quoteId} ${lock ? sql`FOR UPDATE OF q` : sql``}`);
  if (result.rows.length === 0) return null;
  const row = {
    ...result.rows[0],
    createdAt: readDatabaseTimestamp(result.rows[0].createdAt),
    expiresAt: readDatabaseTimestamp(result.rows[0].expiresAt),
  } as unknown as QuoteRow;
  if (
    result.rows.length !== 1 ||
    row.siteId !== siteId ||
    row.quoteId !== quoteId
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  snapshot(row);
  return row;
}

async function lockRequest(
  tx: GiftCheckoutReader,
  siteId: string,
  requestId: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["gift-checkout", siteId, requestId])}, 0))`,
  );
}

async function readRecord(
  tx: GiftCheckoutReader,
  siteId: string,
  requestId: string,
  options: GiftCheckoutRepositoryOptions,
): Promise<GiftCheckoutRecord | null> {
  const result =
    await tx.execute(sql`SELECT ${quoteColumns}, o.id AS "orderId", o.request_id AS "requestId",
    o.request_hash AS "requestHash", o.recovery_token_hash AS "recoveryTokenHash", o.created_at AS "orderCreatedAt"
    FROM ${giftOrder} o INNER JOIN ${giftQuoteRecord} q ON q.id = o.quote_id
      AND q.site_id = o.site_id AND q.account_id = o.account_id AND q.environment = o.environment
    WHERE o.site_id = ${siteId} AND o.request_id = ${requestId}`);
  if (result.rows.length === 0) return null;
  const row = {
    ...result.rows[0],
    createdAt: readDatabaseTimestamp(result.rows[0].createdAt),
    expiresAt: readDatabaseTimestamp(result.rows[0].expiresAt),
    orderCreatedAt: readDatabaseTimestamp(result.rows[0].orderCreatedAt),
  } as unknown as OrderRow;
  if (
    result.rows.length !== 1 ||
    row.siteId !== siteId ||
    row.requestId !== requestId ||
    !/^[a-f0-9]{64}$/.test(row.recoveryTokenHash) ||
    row.requestHash !== requestHash(row)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const quoteSnapshot = snapshot(row);
  const attempts =
    await tx.execute(sql`SELECT a.id AS "attemptId", a.site_id AS "siteId", a.account_id AS "accountId",
    a.environment, a.order_id AS "orderId", a.operation_id AS "operationId", a.attempt_number AS "attemptNumber",
    a.provider_reference AS "providerReference", a.hosted_url AS "hostedUrl", a.expires_at AS "expiresAt", op.kind AS "operationKind",
    op.state AS "operationState", op.attempts AS "operationAttempts", op.request_id AS "operationRequestId", op.request_hash AS "operationRequestHash",
    op.request_snapshot AS "requestSnapshot", op.provider_operation_reference AS "providerOperationReference",
    op.lease_owner AS "leaseOwner", op.lease_token AS "leaseToken", op.lease_expires_at AS "leaseExpiresAt", op.updated_at AS "updatedAt"
    FROM ${giftCheckoutAttempt} a INNER JOIN ${financialOperation} op ON op.id = a.operation_id
      AND op.site_id = a.site_id AND op.account_id = a.account_id AND op.environment = a.environment
      AND op.order_id = a.order_id AND op.kind = a.operation_kind AND op.kind = 'CHECKOUT_CREATE'
    WHERE a.site_id = ${siteId} AND a.account_id = ${row.accountId} AND a.environment = ${row.environment} AND a.order_id = ${row.orderId}
    ORDER BY a.attempt_number, a.id`);
  const attemptRows = attempts.rows.map((raw) => ({
    ...raw,
    updatedAt: readDatabaseTimestamp(raw.updatedAt),
    expiresAt:
      raw.expiresAt === null ? null : readDatabaseTimestamp(raw.expiresAt),
    leaseExpiresAt:
      raw.leaseExpiresAt === null
        ? null
        : readDatabaseTimestamp(raw.leaseExpiresAt),
  })) as unknown as AttemptRow[];
  const attempt = attemptRows[0];
  if (
    !attempt ||
    attemptRows.some((value) => {
      const identity = {
        siteId,
        requestId,
        quoteId: row.quoteId,
        orderId: row.orderId,
        attemptId: value.attemptId,
        recoveryTokenHash: row.recoveryTokenHash,
        createdAt: instant(row.orderCreatedAt),
      };
      const expected = operationSnapshot(row, identity);
      const sealed = value.requestSnapshot?.preDispatchRejection !== undefined;
      return (
        !scoped(value, row) ||
        value.orderId !== row.orderId ||
        value.operationId !== value.attemptId ||
        value.operationKind !== "CHECKOUT_CREATE" ||
        value.operationRequestId !== requestId ||
        value.operationRequestHash !== row.requestHash ||
        !isDeepStrictEqual(
          value.requestSnapshot,
          sealed
            ? {
                ...expected,
                preDispatchRejection: preDispatchRejection(
                  identity,
                  row.expiresAt,
                ),
              }
            : expected,
        )
      );
    })
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const record: GiftCheckoutRecord = {
    siteId,
    requestId,
    quoteId: row.quoteId,
    orderId: row.orderId,
    attemptId: attempt.attemptId,
    recoveryTokenHash: row.recoveryTokenHash,
    quoteSnapshot,
    createdAt: instant(row.orderCreatedAt),
    state: "OUTCOME_UNKNOWN",
    observedAt: instant(attempt.updatedAt),
    closedReason: null,
    checkout: null,
    evidence: null,
  };
  validIdentity(record);
  const payments =
    await tx.execute(sql`SELECT p.id, p.site_id AS "siteId", p.account_id AS "accountId", p.environment,
    p.order_id AS "orderId", p.attempt_id AS "attemptId", p.provider_payment_reference AS "providerPaymentReference",
    p.provider_status AS "providerStatus", p.verification_status AS "verificationStatus", p.observed_at AS "observedAt",
    p.currency, p.gross_cents AS "grossCents", p.processing_cents AS "processingCents", p.commission_cents AS "commissionCents",
    p.recipient_net_cents AS "recipientNetCents", p.split_provider_reference AS "splitProviderReference", p.split_fixed_cents AS "splitFixedCents"
    FROM ${giftPaymentRecord} p WHERE p.site_id = ${siteId} AND p.account_id = ${row.accountId}
      AND p.environment = ${row.environment} AND p.order_id = ${row.orderId} ORDER BY p.id`);
  const paymentRows = payments.rows.map((raw) => ({
    ...raw,
    observedAt: readDatabaseTimestamp(raw.observedAt),
  })) as unknown as PaymentRow[];
  const ledgers =
    await tx.execute(sql`SELECT l.id, l.site_id AS "siteId", l.account_id AS "accountId", l.environment,
    l.payment_id AS "paymentId", l.operation_id AS "operationId", l.event_id AS "eventId", l.compensates_entry_id AS "compensatesEntryId",
    l.kind, l.direction, l.currency, l.amount_cents AS "amountCents", l.effect_key AS "effectKey"
    FROM ${financialLedgerEntry} l WHERE l.site_id = ${siteId} AND l.account_id = ${row.accountId} AND l.environment = ${row.environment}
      AND (l.payment_id IN (SELECT p.id FROM ${giftPaymentRecord} p WHERE p.site_id = ${siteId} AND p.account_id = ${row.accountId}
        AND p.environment = ${row.environment} AND p.order_id = ${row.orderId})
        OR l.operation_id IN (SELECT op.id FROM ${financialOperation} op WHERE op.site_id = ${siteId} AND op.account_id = ${row.accountId}
          AND op.environment = ${row.environment} AND op.order_id = ${row.orderId})
        OR l.compensates_entry_id IN (SELECT original.id FROM ${financialLedgerEntry} original INNER JOIN ${giftPaymentRecord} p
          ON p.id = original.payment_id AND p.site_id = original.site_id AND p.account_id = original.account_id AND p.environment = original.environment
          WHERE p.site_id = ${siteId} AND p.account_id = ${row.accountId} AND p.environment = ${row.environment} AND p.order_id = ${row.orderId})) ORDER BY l.id`);
  const ledgerRows = ledgers.rows as unknown as LedgerRow[];
  if (
    paymentRows.some(
      (payment) =>
        !scoped(payment, row) ||
        payment.orderId !== row.orderId ||
        !attempts.rows.some((raw) => raw.attemptId === payment.attemptId),
    ) ||
    ledgerRows.some((ledger) => !scoped(ledger, row))
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const clock = now(options);
  const validTime = (date: Date | null): date is Date =>
    date instanceof Date &&
    Number.isFinite(date.getTime()) &&
    compareDatabaseTimestamps(date, row.orderCreatedAt) >= 0 &&
    compareDatabaseTimestamps(date, clock) <= 0;
  if (attempts.rows.length !== 1 || !validTime(attempt.updatedAt))
    return record;
  // A prior receipt cannot erase authenticated uncertainty or a reversal. Keep
  // public recovery locked until the correlated durable events are resolved.
  const unresolved =
    await tx.execute(sql`SELECT e.id FROM ${financialEventInbox} e
    WHERE e.site_id = ${siteId} AND e.account_id = ${row.accountId} AND e.environment = ${row.environment}
      AND e.authenticated_at IS NOT NULL AND e.state <> 'PROCESSED'
      AND (starts_with(e.event_type, 'PAYMENT_') OR starts_with(e.event_type, 'CHECKOUT_'))
      AND (e.payload->>'externalReference' = ${attempt.attemptId}
        OR (${attempt.providerReference}::text IS NOT NULL AND e.payload->>'checkoutId' = ${attempt.providerReference})
        OR EXISTS (SELECT 1 FROM ${giftPaymentRecord} related WHERE related.site_id = ${siteId}
          AND related.account_id = ${row.accountId} AND related.environment = ${row.environment} AND related.order_id = ${row.orderId}
          AND (e.payment_id = related.id OR e.payload->>'paymentId' = related.provider_payment_reference))) LIMIT 1`);
  if (unresolved.rows.length > 0) {
    const projectedAt = now(options);
    if (projectedAt.getTime() < clock.getTime())
      return fail("EXTERNAL_OUTCOME_UNKNOWN");
    return { ...record, observedAt: instant(projectedAt) };
  }
  if (attempt.requestSnapshot.preDispatchRejection !== undefined) {
    if (
      paymentRows.length === 0 &&
      ledgerRows.length === 0 &&
      attempt.attemptNumber === 1 &&
      attempt.operationAttempts === 0 &&
      ["CANCELLED", "FAILED"].includes(attempt.operationState) &&
      attempt.providerReference === null &&
      attempt.hostedUrl === null &&
      attempt.expiresAt === null &&
      attempt.providerOperationReference === null &&
      attempt.leaseOwner === null &&
      attempt.leaseToken === null &&
      attempt.leaseExpiresAt === null &&
      compareDatabaseTimestamps(attempt.updatedAt, row.orderCreatedAt) === 0 &&
      compareDatabaseTimestamps(row.orderCreatedAt, row.createdAt) >= 0
    ) {
      const evidence = preDispatchRejection(record, row.expiresAt);
      return {
        ...record,
        state: "CLOSED_UNPAID",
        closedReason: evidence.closedReason,
        observedAt: record.createdAt,
        evidence,
      };
    }
    return record;
  }
  const checkout = checkoutResultSchema.safeParse({
    orderId: row.orderId,
    attemptId: attempt.attemptId,
    quoteId: row.quoteId,
    method: row.method,
    mode: row.environment,
    hostedUrl: attempt.hostedUrl,
  });
  const hosted =
    attempt.operationState === "SUCCEEDED" &&
    nonempty(attempt.providerReference) &&
    attempt.providerReference === attempt.providerOperationReference &&
    checkout.success &&
    isSafeCheckoutContinuation(checkout.data.hostedUrl, row.recoveryTokenHash);
  if (!hosted || !checkout.success || !nonempty(attempt.providerReference)) {
    if (
      paymentRows.length === 0 &&
      ledgerRows.length === 0 &&
      attempt.operationState === "PROCESSING" &&
      attempt.operationAttempts === 1 &&
      attempt.attemptNumber === 1 &&
      attempt.providerReference === null &&
      attempt.hostedUrl === null &&
      attempt.providerOperationReference === null &&
      attempt.leaseToken === attempt.attemptId &&
      nonempty(attempt.leaseOwner) &&
      attempt.leaseExpiresAt instanceof Date &&
      compareDatabaseTimestamps(attempt.leaseExpiresAt, clock) >= 0
    ) {
      record.state = "CREATING";
      record.observedAt = null;
    }
    return record;
  }
  const evidence: GiftCheckoutEvidence = {
    kind: "HOSTED_CHECKOUT",
    source: "provider",
    siteId,
    orderId: row.orderId,
    attemptId: attempt.attemptId,
    provider: quoteSnapshot.receiving.provider,
    accountReference: quoteSnapshot.receiving.accountReference,
    environment: row.environment,
    providerCheckoutReference: attempt.providerReference,
    observedAt: instant(attempt.updatedAt),
  };
  const payment = paymentRows[0];
  const ledger = ledgerRows[0];
  const actualProcessing = giftCentsSchema.safeParse(payment?.processingCents);
  const recipientNet = giftCentsSchema.safeParse(payment?.recipientNetCents);
  if (
    paymentRows.length === 1 &&
    ledgerRows.length === 0 &&
    row.method === "CREDIT_CARD" &&
    payment &&
    payment.attemptId === attempt.attemptId &&
    nonempty(payment.providerPaymentReference) &&
    payment.providerStatus === "CONFIRMED" &&
    payment.verificationStatus === "VERIFIED" &&
    validTime(payment.observedAt) &&
    payment.currency === row.currency &&
    payment.grossCents === row.totalCents &&
    actualProcessing.success &&
    recipientNet.success &&
    recipientNet.data > 0 &&
    BigInt(row.totalCents) ===
      BigInt(actualProcessing.data) +
        BigInt(row.commissionCents) +
        BigInt(recipientNet.data) &&
    payment.commissionCents === null &&
    payment.splitFixedCents === row.commissionCents &&
    (row.commissionCents === 0 || nonempty(payment.splitProviderReference))
  ) {
    const events =
      await tx.execute(sql`SELECT e.id, e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
      e.payment_id AS "paymentId", e.event_type AS "eventType", e.state, e.payload, e.payload_hash AS "payloadHash",
      e.provider_event_reference AS "providerEventReference", e.authenticated_at AS "authenticatedAt",
      e.received_at AS "receivedAt", e.processed_at AS "processedAt"
      FROM ${financialEventInbox} e WHERE e.site_id = ${siteId} AND e.account_id = ${row.accountId} AND e.environment = ${row.environment}
        AND (starts_with(e.event_type, 'PAYMENT_') OR starts_with(e.event_type, 'CHECKOUT_'))
        AND (e.payment_id = ${payment.id} OR e.payload->>'paymentId' = ${payment.providerPaymentReference}
          OR e.payload->>'externalReference' = ${attempt.attemptId} OR e.payload->>'checkoutId' = ${attempt.providerReference})`);
    let confirmation: {
      eventId: string;
      providerEventReference: string;
    } | null = null;
    for (const event of events.rows) {
      const payload = event.payload as Record<string, string> | null;
      const authenticated =
        event.authenticatedAt === null
          ? null
          : readDatabaseTimestamp(event.authenticatedAt);
      const received =
        event.receivedAt === null
          ? null
          : readDatabaseTimestamp(event.receivedAt);
      const processed =
        event.processedAt === null
          ? null
          : readDatabaseTimestamp(event.processedAt);
      if (
        !scoped(event as unknown as GiftCheckoutAccountScope, row) ||
        !["PAYMENT_CONFIRMED", "CHECKOUT_CREATED", "CHECKOUT_PAID"].includes(
          String(event.eventType),
        ) ||
        event.state !== "PROCESSED" ||
        !giftQuoteSchema.shape.siteId.safeParse(event.id).success ||
        !nonempty(event.providerEventReference) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (payload.externalReference !== undefined &&
          payload.externalReference !== attempt.attemptId) ||
        (payload.checkoutId !== undefined &&
          payload.checkoutId !== attempt.providerReference) ||
        (payload.paymentId !== undefined &&
          payload.paymentId !== payment.providerPaymentReference) ||
        Object.entries(payload).some(
          ([key, value]) =>
            !["paymentId", "checkoutId", "externalReference"].includes(key) ||
            !nonempty(value),
        ) ||
        event.payloadHash !==
          hashAsaasEventIdentity(
            event.providerEventReference,
            String(event.eventType),
            quoteSnapshot.receiving.accountReference,
            payload,
          ) ||
        !validTime(authenticated) ||
        !validTime(received) ||
        !validTime(processed) ||
        compareDatabaseTimestamps(authenticated, received) < 0 ||
        compareDatabaseTimestamps(processed, authenticated) < 0
      )
        return record;
      if (event.eventType === "PAYMENT_CONFIRMED") {
        if (
          confirmation ||
          event.paymentId !== payment.id ||
          payload.paymentId !== payment.providerPaymentReference ||
          compareDatabaseTimestamps(payment.observedAt, authenticated) < 0 ||
          compareDatabaseTimestamps(payment.observedAt, processed) > 0
        )
          return record;
        confirmation = {
          eventId: event.id as string,
          providerEventReference: event.providerEventReference,
        };
      } else if (payload.checkoutId !== attempt.providerReference)
        return record;
    }
    if (confirmation)
      return {
        ...record,
        state: "CONFIRMED",
        observedAt: instant(payment.observedAt),
        evidence: {
          ...evidence,
          kind: "PAYMENT_CONFIRMATION",
          observedAt: instant(payment.observedAt),
          providerPaymentReference: payment.providerPaymentReference,
          ...confirmation,
        },
      };
  }
  if (
    paymentRows.length === 1 &&
    ledgerRows.length === 1 &&
    payment &&
    ledger &&
    payment.attemptId === attempt.attemptId &&
    nonempty(payment.providerPaymentReference) &&
    payment.providerStatus === "RECEIVED" &&
    payment.verificationStatus === "VERIFIED" &&
    validTime(payment.observedAt) &&
    payment.currency === row.currency &&
    payment.grossCents === row.totalCents &&
    actualProcessing.success &&
    recipientNet.success &&
    recipientNet.data > 0 &&
    BigInt(row.totalCents) ===
      BigInt(actualProcessing.data) +
        BigInt(row.commissionCents) +
        BigInt(recipientNet.data) &&
    payment.commissionCents === row.commissionCents &&
    payment.splitFixedCents === row.commissionCents &&
    (row.commissionCents === 0 || nonempty(payment.splitProviderReference)) &&
    ledger.paymentId === payment.id &&
    ledger.kind === "GIFT_RECEIVED" &&
    ledger.direction === "CREDIT" &&
    ledger.currency === row.currency &&
    ledger.amountCents === recipientNet.data &&
    ledger.effectKey ===
      giftReceivedEffectKey(payment.providerPaymentReference) &&
    ledger.compensatesEntryId === null &&
    (ledger.operationId === null || ledger.operationId === attempt.operationId)
  ) {
    let authenticated = ledger.eventId === null;
    if (ledger.eventId !== null) {
      const events =
        await tx.execute(sql`SELECT e.id, e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
        e.payment_id AS "paymentId", e.event_type AS "eventType", e.state, e.authenticated_at AS "authenticatedAt", e.processed_at AS "processedAt"
        FROM ${financialEventInbox} e WHERE e.site_id = ${siteId} AND e.account_id = ${row.accountId} AND e.environment = ${row.environment} AND e.id = ${ledger.eventId}`);
      const rawEvent = events.rows[0];
      const event = rawEvent
        ? ({
            ...rawEvent,
            authenticatedAt:
              rawEvent.authenticatedAt === null
                ? null
                : readDatabaseTimestamp(rawEvent.authenticatedAt),
            processedAt:
              rawEvent.processedAt === null
                ? null
                : readDatabaseTimestamp(rawEvent.processedAt),
          } as unknown as EventRow)
        : null;
      authenticated =
        events.rows.length === 1 &&
        event !== null &&
        event.id === ledger.eventId &&
        scoped(event, row) &&
        event.paymentId === payment.id &&
        event.eventType === "PAYMENT_RECEIVED" &&
        event.state === "PROCESSED" &&
        validTime(event.authenticatedAt) &&
        validTime(event.processedAt) &&
        compareDatabaseTimestamps(event.processedAt, event.authenticatedAt) >=
          0;
    }
    if (
      authenticated &&
      giftQuoteSchema.shape.siteId.safeParse(ledger.id).success
    )
      return {
        ...record,
        state: "RECEIVED",
        observedAt: instant(payment.observedAt),
        evidence: {
          ...evidence,
          kind: "SETTLEMENT",
          observedAt: instant(payment.observedAt),
          providerPaymentReference: payment.providerPaymentReference,
          ledgerEntryId: ledger.id,
        },
      };
  }
  const lifecycle =
    await tx.execute(sql`SELECT e.id, e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
    e.event_type AS "eventType", e.state, e.payload, e.payload_hash AS "payloadHash", e.provider_event_reference AS "providerEventReference",
    e.authenticated_at AS "authenticatedAt", e.received_at AS "receivedAt", e.processed_at AS "processedAt", e.last_error_code AS "lastErrorCode"
    FROM ${financialEventInbox} e WHERE e.site_id = ${siteId} AND e.account_id = ${row.accountId} AND e.environment = ${row.environment}
      AND e.state = 'PROCESSED' AND e.event_type IN ('CHECKOUT_PAID','CHECKOUT_CANCELED','CHECKOUT_EXPIRED')
      AND e.payload->>'checkoutId' = ${attempt.providerReference} ORDER BY e.processed_at DESC, e.id`);
  let closed:
    | { reason: "CANCELED" | "EXPIRED"; observedAt: string }
    | undefined;
  for (const event of lifecycle.rows) {
    if (
      !["CHECKOUT_PAID", "CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"].includes(
        String(event.eventType),
      )
    )
      continue;
    const payload = event.payload as Record<string, string> | null;
    const date = (value: unknown) => {
      try {
        return readDatabaseTimestamp(value);
      } catch {
        return null;
      }
    };
    const authenticated = date(event.authenticatedAt);
    const received = date(event.receivedAt);
    const processed = date(event.processedAt);
    if (
      !scoped(event as unknown as GiftCheckoutAccountScope, row) ||
      event.state !== "PROCESSED" ||
      !payload ||
      payload.checkoutId !== attempt.providerReference ||
      (payload.externalReference !== undefined &&
        payload.externalReference !== attempt.attemptId) ||
      Object.entries(payload).some(
        ([key, value]) =>
          !["checkoutId", "externalReference"].includes(key) ||
          !nonempty(value),
      ) ||
      typeof event.providerEventReference !== "string" ||
      event.payloadHash !==
        hashAsaasEventIdentity(
          event.providerEventReference,
          String(event.eventType),
          quoteSnapshot.receiving.accountReference,
          payload,
        ) ||
      !validTime(authenticated) ||
      !validTime(received) ||
      !validTime(processed) ||
      compareDatabaseTimestamps(authenticated, received) < 0 ||
      compareDatabaseTimestamps(processed, authenticated) < 0
    )
      return record;
    if (event.eventType === "CHECKOUT_PAID") return record;
    const reason =
      event.eventType === "CHECKOUT_CANCELED" ? "CANCELED" : "EXPIRED";
    if (event.lastErrorCode === `${event.eventType}_EMPTY` && !closed)
      closed = { reason, observedAt: instant(processed) };
  }
  if (closed && paymentRows.length === 0 && ledgerRows.length === 0)
    return {
      ...record,
      state: "CLOSED_UNPAID",
      closedReason: closed.reason,
      observedAt: closed.observedAt,
      evidence: {
        ...evidence,
        kind: "CLOSED_UNPAID",
        observedAt: closed.observedAt,
        noOutstandingPayment: true,
        closedReason: closed.reason,
      },
    };
  if (
    ledgerRows.length === 0 &&
    (paymentRows.length === 0 ||
      (paymentRows.length === 1 &&
        payment?.providerStatus === "PENDING" &&
        payment.verificationStatus === "VERIFIED" &&
        validTime(payment.observedAt))) &&
    (attempt.expiresAt === null ||
      (attempt.expiresAt instanceof Date &&
        compareDatabaseTimestamps(attempt.expiresAt, clock) > 0))
  ) {
    return {
      ...record,
      state: "AWAITING_PAYMENT",
      checkout: checkout.data,
      evidence,
    };
  }
  return record;
}

async function lockEligibility(
  tx: GiftCheckoutTransaction,
  row: QuoteRow,
  options: GiftCheckoutRepositoryOptions,
) {
  const accounts =
    await tx.execute(sql`SELECT id, site_id AS "siteId", environment, is_current AS "isCurrent",
    account_reference AS "accountReference", recipient_reference AS "recipientReference", operator_reference AS "operatorReference", provider FROM ${receivingAccount}
    WHERE site_id = ${row.siteId} AND environment = ${row.environment} FOR UPDATE`);
  if (
    !accounts.rows.some(
      (value) =>
        value.id === row.accountId &&
        value.siteId === row.siteId &&
        value.environment === row.environment &&
        value.isCurrent === true &&
        value.accountReference === snapshot(row).receiving.accountReference &&
        value.provider === snapshot(row).receiving.provider &&
        value.operatorReference === snapshot(row).receiving.operatorReference &&
        value.recipientReference === snapshot(row).receiving.recipientReference,
    )
  )
    throw new ReceivingReadinessServiceError();
  await tx.execute(sql`SELECT id FROM ${receivingDestination} WHERE site_id = ${row.siteId}
    AND account_id = ${row.accountId} AND environment = ${row.environment} FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM ${receivingVerificationEvidence} WHERE site_id = ${row.siteId}
    AND account_id = ${row.accountId} AND environment = ${row.environment} FOR UPDATE`);
  await tx.execute(
    sql`SELECT id FROM ${giftItem} WHERE site_id = ${row.siteId} AND id = ${row.giftId} FOR UPDATE`,
  );
  const scope: GiftCheckoutAccountScope = {
    siteId: row.siteId,
    accountId: row.accountId,
    environment: row.environment,
  };
  const receivingContext = structuredClone(
    await options.loadStoredReceivingContext(tx, scope),
  );
  if (!receivingContext) throw new ReceivingReadinessServiceError();
  assertReceivingReady(
    evaluateReceivingReadiness({
      ...receivingContext,
      siteId: row.siteId,
      now: now(options),
    }),
  );
  const gift = await findPublishedGiftForQuote(tx, row.siteId, row.giftId, {
    now: options.now,
    readReadiness: async () =>
      evaluateReceivingReadiness({
        ...receivingContext,
        siteId: row.siteId,
        now: now(options),
      }),
  });
  if (!sameBinding(snapshot(row).receiving, receivingContext.providerBinding))
    throw new ReceivingReadinessServiceError();
  assertReceivingReady(
    evaluateReceivingReadiness({
      ...receivingContext,
      siteId: row.siteId,
      now: now(options),
    }),
  );
  if (
    gift?.publicationState !== "PUBLISHED" ||
    gift.siteActive !== true ||
    gift.gift.id !== row.giftId ||
    gift.gift.siteId !== row.siteId ||
    !publicGiftItemSchema.safeParse(gift.gift).success ||
    (snapshot(row).pricing.provenance === "local-test" &&
      (!receivingContext.isDemo ||
        receivingContext.environment === "production" ||
        row.environment !== "sandbox"))
  )
    return fail("QUOTE_INVALID");
  return {
    quoteSnapshot: snapshot(row),
    receivingContext,
    gift: structuredClone(gift),
  };
}

async function lockedRecord(
  tx: GiftCheckoutReader,
  identity: GiftCheckoutIdentity,
  options: GiftCheckoutRepositoryOptions,
) {
  await lockRequest(tx, identity.siteId, identity.requestId);
  // Financial event writers must take this same order lock before posting payment effects.
  await tx.execute(
    sql`SELECT id FROM ${giftOrder} WHERE site_id = ${identity.siteId} AND id = ${identity.orderId} FOR UPDATE`,
  );
  const record = await readRecord(
    tx,
    identity.siteId,
    identity.requestId,
    options,
  );
  if (!record || !sameIdentity(record, identity))
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const row = await quoteRow(tx, record.siteId, record.quoteId);
  if (!row) return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return { record, row };
}

function noPaymentEffects(row: QuoteRow, identity: GiftCheckoutIdentity) {
  return sql`NOT EXISTS (SELECT 1 FROM ${giftPaymentRecord} p WHERE p.site_id = ${identity.siteId}
    AND p.account_id = ${row.accountId} AND p.environment = ${row.environment} AND p.order_id = ${identity.orderId})
    AND NOT EXISTS (SELECT 1 FROM ${financialLedgerEntry} l WHERE l.site_id = ${identity.siteId}
      AND l.account_id = ${row.accountId} AND l.environment = ${row.environment} AND l.operation_id = ${identity.attemptId})`;
}

function originalFence(
  row: QuoteRow,
  identity: GiftCheckoutRecord,
  options: GiftCheckoutRepositoryOptions,
) {
  return sql`op.id = ${identity.attemptId} AND op.site_id = ${identity.siteId} AND op.account_id = ${row.accountId}
    AND op.environment = ${row.environment} AND op.order_id = ${identity.orderId} AND op.request_id = ${identity.requestId}
    AND op.kind = 'CHECKOUT_CREATE' AND op.state = 'PROCESSING' AND op.request_hash = ${requestHash(identity)}
    AND op.lease_owner = ${options.instanceId} AND op.lease_token = ${identity.attemptId}
    AND EXISTS (SELECT 1 FROM ${giftOrder} o WHERE o.id = op.order_id AND o.site_id = op.site_id
      AND o.account_id = op.account_id AND o.environment = op.environment AND o.request_id = ${identity.requestId} AND o.quote_id = ${identity.quoteId})`;
}

function reservationInput(reservation: GiftCheckoutReservation) {
  const input = structuredClone(reservation);
  validIdentity(input);
  if (
    typeof input.recoveryTokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.recoveryTokenHash) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(input.createdAt).success
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return input;
}

function sameRequest(
  existing: GiftCheckoutRecord,
  input: GiftCheckoutReservation,
) {
  if (
    existing.quoteId !== input.quoteId ||
    !timingSafeEqual(
      Buffer.from(existing.recoveryTokenHash, "hex"),
      Buffer.from(input.recoveryTokenHash, "hex"),
    )
  )
    return fail("REQUEST_CONFLICT");
}

async function lockNewQuote(
  tx: GiftCheckoutTransaction,
  input: GiftCheckoutReservation,
) {
  const site = await tx.execute(
    sql`SELECT id FROM site WHERE id = ${input.siteId} FOR UPDATE`,
  );
  if (site.rows.length !== 1 || site.rows[0]?.id !== input.siteId)
    return fail("QUOTE_INVALID");
  const row = await quoteRow(tx, input.siteId, input.quoteId, true);
  if (!row || !isDeepStrictEqual(input.quoteSnapshot, snapshot(row)))
    return fail("QUOTE_INVALID");
  return row;
}

async function insertReservation(
  tx: GiftCheckoutTransaction,
  row: QuoteRow,
  input: GiftCheckoutReservation,
  options: GiftCheckoutRepositoryOptions,
  clock: Date,
  dispatch: boolean,
) {
  const createdAt = new Date(input.createdAt);
  if (
    compareDatabaseTimestamps(createdAt, row.createdAt) < 0 ||
    createdAt.getTime() > clock.getTime()
  )
    return fail("QUOTE_INVALID");
  const scope: GiftCheckoutAccountScope = {
    siteId: row.siteId,
    accountId: row.accountId,
    environment: row.environment,
  };
  const hash = requestHash(input);
  const requestSnapshot = operationSnapshot(scope, input);
  const leaseExpiresAt = dispatch
    ? new Date(clock.getTime() + options.leaseMs)
    : null;
  if (leaseExpiresAt) instant(leaseExpiresAt);
  await tx.insert(giftOrder).values({
    ...scope,
    id: input.orderId,
    quoteId: input.quoteId,
    requestId: input.requestId,
    requestHash: hash,
    recoveryTokenHash: input.recoveryTokenHash,
    createdAt,
  });
  await tx.insert(financialOperation).values({
    ...scope,
    id: input.attemptId,
    orderId: input.orderId,
    kind: "CHECKOUT_CREATE",
    state: dispatch ? "PROCESSING" : "CANCELLED",
    requestId: input.requestId,
    requestHash: hash,
    requestSnapshot: dispatch
      ? requestSnapshot
      : {
          ...requestSnapshot,
          preDispatchRejection: preDispatchRejection(input, row.expiresAt),
        },
    leaseOwner: dispatch ? options.instanceId : null,
    leaseToken: dispatch ? input.attemptId : null,
    leaseExpiresAt,
    attempts: dispatch ? 1 : 0,
    createdAt,
    updatedAt: dispatch ? clock : createdAt,
  });
  await tx.insert(giftCheckoutAttempt).values({
    ...scope,
    id: input.attemptId,
    orderId: input.orderId,
    operationId: input.attemptId,
    operationKind: "CHECKOUT_CREATE",
    attemptNumber: 1,
    createdAt,
  });
  const record = await readRecord(tx, input.siteId, input.requestId, options);
  if (
    !record ||
    (dispatch ? record.state !== "CREATING" : record.state !== "CLOSED_UNPAID")
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return record;
}

export function createGiftCheckoutRepository(
  db: GiftCheckoutDatabase,
  options: GiftCheckoutRepositoryOptions,
): GiftCheckoutRepository {
  if (
    !giftQuoteSchema.shape.siteId.safeParse(options.instanceId).success ||
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs <= 0 ||
    options.leaseMs > 300_000 ||
    typeof options.now !== "function" ||
    typeof options.loadStoredReceivingContext !== "function"
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  options = Object.freeze({ ...options });
  return {
    findQuote: (siteId, quoteId) =>
      guarded(async () => {
        const row = await quoteRow(db, siteId, quoteId);
        return row ? snapshot(row) : null;
      }),
    findByRequest: (siteId, requestId) =>
      guarded(() =>
        db.transaction((tx) => readRecord(tx, siteId, requestId, options), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }),
      ),
    sealUncreatedRequest: (reservation) =>
      guarded(async () => {
        const input = reservationInput(reservation);
        return db.transaction(
          async (tx) => {
            await lockRequest(tx, input.siteId, input.requestId);
            const existing = await readRecord(
              tx,
              input.siteId,
              input.requestId,
              options,
            );
            if (existing) {
              sameRequest(existing, input);
              return existing;
            }
            const row = await lockNewQuote(tx, input);
            return insertReservation(
              tx,
              row,
              input,
              options,
              now(options),
              false,
            );
          },
          { isolationLevel: "read committed" },
        );
      }),
    reserve: (reservation, validate) =>
      guarded(async () => {
        const input = reservationInput(reservation);
        if (typeof validate !== "function")
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        return db.transaction(
          async (tx) => {
            await lockRequest(tx, input.siteId, input.requestId);
            const existing = await readRecord(
              tx,
              input.siteId,
              input.requestId,
              options,
            );
            if (existing) {
              sameRequest(existing, input);
              return { created: false, record: existing };
            }
            const row = await lockNewQuote(tx, input);
            const eligibility = await lockEligibility(tx, row, options);
            const validation: unknown = validate(structuredClone(eligibility));
            // Validation is synchronous; contain a mistaken async callback's rejection.
            if (validation instanceof Promise) void validation.catch(() => {});
            if (validation !== undefined)
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            const clock = now(options);
            assertReceivingReady(
              evaluateReceivingReadiness({
                ...eligibility.receivingContext,
                siteId: row.siteId,
                now: clock,
              }),
            );
            if (compareDatabaseTimestamps(row.expiresAt, clock) <= 0)
              return fail("QUOTE_INVALID");
            const record = await insertReservation(
              tx,
              row,
              input,
              options,
              clock,
              true,
            );
            return { created: true, record };
          },
          { isolationLevel: "read committed" },
        );
      }),
    saveHostedCheckout: (outcome: GiftCheckoutHostedOutcome) =>
      guarded(async () => {
        const input = structuredClone(outcome);
        validIdentity(input);
        const parsed = checkoutResultSchema.safeParse(input.checkout);
        if (
          !parsed.success ||
          !nonempty(input.providerReference) ||
          !giftQuoteSchema.shape.expiresAt.safeParse(input.observedAt)
            .success ||
          parsed.data.orderId !== input.orderId ||
          parsed.data.attemptId !== input.attemptId ||
          parsed.data.quoteId !== input.quoteId
        )
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        return db.transaction(
          async (tx) => {
            const { record, row } = await lockedRecord(tx, input, options);
            const clock = now(options);
            if (
              parsed.data.method !== row.method ||
              parsed.data.mode !== row.environment ||
              !isSafeCheckoutContinuation(
                parsed.data.hostedUrl,
                record.recoveryTokenHash,
              ) ||
              Date.parse(input.observedAt) < Date.parse(record.createdAt) ||
              Date.parse(input.observedAt) > clock.getTime()
            )
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            if (
              record.state === "AWAITING_PAYMENT" &&
              isDeepStrictEqual(record.checkout, parsed.data) &&
              record.evidence?.providerCheckoutReference ===
                input.providerReference
            )
              return record;
            const saved =
              await tx.execute(sql`UPDATE ${financialOperation} op SET state = 'SUCCEEDED',
          provider_operation_reference = ${input.providerReference}, updated_at = ${input.observedAt}::timestamptz
          WHERE ${originalFence(row, record, options)} AND op.lease_expires_at >= ${clock.toISOString()}::timestamptz
            AND op.lease_expires_at >= clock_timestamp() AND ${noPaymentEffects(row, input)} RETURNING op.id`);
            if (
              saved.rows.length !== 1 ||
              saved.rows[0]?.id !== input.attemptId
            )
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            const attempt =
              await tx.execute(sql`UPDATE ${giftCheckoutAttempt} a SET provider_reference = ${input.providerReference}, hosted_url = ${parsed.data.hostedUrl}
          WHERE a.id = ${input.attemptId} AND a.site_id = ${input.siteId} AND a.account_id = ${row.accountId}
            AND a.environment = ${row.environment} AND a.order_id = ${input.orderId} AND a.operation_id = ${input.attemptId}
            AND a.operation_kind = 'CHECKOUT_CREATE' AND a.provider_reference IS NULL AND a.hosted_url IS NULL RETURNING a.id`);
            if (
              attempt.rows.length !== 1 ||
              attempt.rows[0]?.id !== input.attemptId
            )
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            const stored = await readRecord(
              tx,
              input.siteId,
              input.requestId,
              options,
            );
            if (
              stored?.state !== "AWAITING_PAYMENT" ||
              !sameIdentity(stored, input) ||
              !isDeepStrictEqual(stored.checkout, parsed.data)
            )
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            return stored;
          },
          { isolationLevel: "read committed" },
        );
      }),
    markOutcomeUnknown: (identity: GiftCheckoutIdentity, observedAt: string) =>
      guarded(async () => {
        const input = structuredClone(identity);
        validIdentity(input);
        if (!giftQuoteSchema.shape.expiresAt.safeParse(observedAt).success)
          return fail("EXTERNAL_OUTCOME_UNKNOWN");
        await db.transaction(
          async (tx) => {
            const { record, row } = await lockedRecord(tx, input, options);
            const clock = now(options);
            if (
              Date.parse(observedAt) < Date.parse(record.createdAt) ||
              Date.parse(observedAt) > clock.getTime()
            )
              return fail("EXTERNAL_OUTCOME_UNKNOWN");
            await tx.execute(sql`UPDATE ${financialOperation} op SET state = 'UNKNOWN', last_error_code = 'EXTERNAL_OUTCOME_UNKNOWN',
          updated_at = ${clock.toISOString()}::timestamptz WHERE ${originalFence(row, record, options)} AND ${noPaymentEffects(row, input)} RETURNING op.id`);
          },
          { isolationLevel: "read committed" },
        );
      }),
  };
}
