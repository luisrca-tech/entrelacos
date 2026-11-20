import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type GiftCheckoutPix,
  giftCheckoutPixSchema,
  giftQuoteSchema,
  publicGiftItemSchema,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
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
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { GiftCheckoutOrderBinding } from "./giftCheckoutLifecycle";
import {
  type GiftCheckoutIdentity,
  type GiftCheckoutRecord,
  type GiftCheckoutRepository,
  type GiftCheckoutReservation,
  GiftCheckoutServiceError,
  giftCheckoutOrderBinding,
  readGiftQuoteSnapshot,
} from "./giftCheckouts";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import type {
  GiftQuoteReceivingContext,
  GiftQuoteSnapshot,
} from "./giftQuotes";
import type { PagarmeOrderObservation } from "./pagarmeOrderClient";
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

interface CheckoutRow extends QuoteRow {
  orderId: string;
  requestId: string;
  recoveryTokenHash: string;
  orderCreatedAt: Date;
  attemptId: string;
  providerReference: string | null;
  pixExpiresAt: Date | null;
  pixQrCode: string | null;
  pixQrCodeUrl: string | null;
  operationState: string;
  operationErrorCode: string | null;
  operationUpdatedAt: Date;
  paymentStatus: string | null;
  paymentObservedAt: Date | null;
  credited: boolean;
}

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

function validIdentity(identity: GiftCheckoutIdentity) {
  if (
    !identity ||
    ![
      identity.siteId,
      identity.quoteId,
      identity.requestId,
      identity.orderId,
      identity.attemptId,
    ].every((value) => giftQuoteSchema.shape.siteId.safeParse(value).success)
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
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

function checkoutQuery(where: ReturnType<typeof sql>) {
  return sql`SELECT ${quoteColumns}, o.id AS "orderId", o.request_id AS "requestId",
    o.recovery_token_hash AS "recoveryTokenHash", o.created_at AS "orderCreatedAt",
    a.id AS "attemptId", a.provider_reference AS "providerReference", a.expires_at AS "pixExpiresAt",
    a.pix_qr_code AS "pixQrCode", a.pix_qr_code_url AS "pixQrCodeUrl",
    op.state AS "operationState", op.last_error_code AS "operationErrorCode", op.updated_at AS "operationUpdatedAt",
    p.provider_status AS "paymentStatus", p.observed_at AS "paymentObservedAt",
    COALESCE(p.credited, false) AS credited
    FROM ${giftOrder} o
    INNER JOIN ${giftQuoteRecord} q ON q.id = o.quote_id AND q.site_id = o.site_id AND q.account_id = o.account_id AND q.environment = o.environment
    INNER JOIN ${giftCheckoutAttempt} a ON a.order_id = o.id AND a.site_id = o.site_id AND a.account_id = o.account_id AND a.environment = o.environment AND a.attempt_number = 1
    INNER JOIN ${financialOperation} op ON op.id = a.operation_id AND op.order_id = o.id AND op.kind = 'CHECKOUT_CREATE'
      AND op.site_id = o.site_id AND op.account_id = o.account_id AND op.environment = o.environment
    LEFT JOIN LATERAL (
      SELECT pr.provider_status, pr.observed_at, EXISTS (SELECT 1 FROM ${financialLedgerEntry} l
        WHERE l.payment_id = pr.id AND l.site_id = pr.site_id AND l.account_id = pr.account_id AND l.environment = pr.environment
          AND l.kind = 'GIFT_RECEIVED' AND l.direction = 'CREDIT') AS credited
      FROM ${giftPaymentRecord} pr
      WHERE pr.order_id = o.id AND pr.attempt_id = a.id AND pr.site_id = o.site_id AND pr.account_id = o.account_id
        AND pr.environment = o.environment AND pr.verification_status = 'VERIFIED'
      ORDER BY pr.created_at DESC, pr.id LIMIT 1
    ) p ON true
    WHERE ${where}`;
}

function time(value: unknown): Date {
  return readDatabaseTimestamp(value);
}

function project(raw: Record<string, unknown>): GiftCheckoutRecord {
  const row = {
    ...raw,
    createdAt: time(raw.createdAt),
    expiresAt: time(raw.expiresAt),
    orderCreatedAt: time(raw.orderCreatedAt),
    operationUpdatedAt: time(raw.operationUpdatedAt),
    pixExpiresAt: raw.pixExpiresAt === null ? null : time(raw.pixExpiresAt),
    paymentObservedAt:
      raw.paymentObservedAt === null ? null : time(raw.paymentObservedAt),
  } as unknown as CheckoutRow;
  const quoteSnapshot = snapshot(row);
  let state: GiftCheckoutRecord["state"];
  let observedAt: Date | null = row.operationUpdatedAt;
  let closedReason: GiftCheckoutRecord["closedReason"] = null;
  switch (row.operationState) {
    case "REQUESTED":
    case "CLAIMED":
    case "PROCESSING":
      state = "CREATING";
      observedAt = null;
      break;
    case "UNKNOWN":
      state = "OUTCOME_UNKNOWN";
      observedAt = null;
      break;
    case "FAILED":
      state = "CLOSED_UNPAID";
      closedReason = "FAILED";
      break;
    case "CANCELLED":
      state = "CLOSED_UNPAID";
      closedReason =
        row.operationErrorCode === "ORDER_EXPIRED" ? "EXPIRED" : "CANCELED";
      break;
    case "SUCCEEDED":
      if (
        row.paymentStatus === "REFUNDED" ||
        row.paymentStatus === "CHARGEBACK"
      ) {
        state = "REFUNDED";
        observedAt = row.paymentObservedAt ?? observedAt;
      } else if (row.paymentStatus === "RECEIVED" && row.credited === true) {
        state = "RECEIVED";
        observedAt = row.paymentObservedAt ?? observedAt;
      } else state = "AWAITING_PAYMENT";
      break;
    default:
      return fail("EXTERNAL_OUTCOME_UNKNOWN");
  }
  let pix: GiftCheckoutPix | null = null;
  if (row.pixQrCode !== null && row.pixExpiresAt !== null) {
    const parsed = giftCheckoutPixSchema.safeParse({
      qrCode: row.pixQrCode,
      qrCodeUrl: row.pixQrCodeUrl,
      expiresAt: row.pixExpiresAt.toISOString(),
    });
    if (!parsed.success) return fail("EXTERNAL_OUTCOME_UNKNOWN");
    pix = parsed.data;
  }
  return {
    siteId: row.siteId,
    quoteId: row.quoteId,
    requestId: row.requestId,
    orderId: row.orderId,
    attemptId: row.attemptId,
    recoveryTokenHash: row.recoveryTokenHash,
    quoteSnapshot,
    createdAt: row.orderCreatedAt.toISOString(),
    state,
    observedAt: observedAt === null ? null : observedAt.toISOString(),
    closedReason,
    providerOrderId: row.providerReference,
    pix,
  };
}

async function readRecord(
  tx: GiftCheckoutReader,
  siteId: string,
  requestId: string,
): Promise<GiftCheckoutRecord | null> {
  const result = await tx.execute(
    checkoutQuery(sql`o.site_id = ${siteId} AND o.request_id = ${requestId}`),
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return project(result.rows[0]);
}

async function lockEligibility(
  tx: GiftCheckoutTransaction,
  row: QuoteRow,
  options: GiftCheckoutRepositoryOptions,
) {
  const stored = snapshot(row);
  const accounts =
    await tx.execute(sql`SELECT id, site_id AS "siteId", environment, is_current AS "isCurrent",
    account_reference AS "accountReference", recipient_reference AS "recipientReference", operator_reference AS "operatorReference", provider FROM ${receivingAccount}
    WHERE site_id = ${row.siteId} AND environment = ${row.environment} FOR UPDATE`);
  if (
    !accounts.rows.some(
      (value) =>
        value.id === row.accountId &&
        value.isCurrent === true &&
        value.accountReference === stored.receiving.accountReference &&
        value.provider === stored.receiving.provider &&
        value.operatorReference === stored.receiving.operatorReference &&
        value.recipientReference === stored.receiving.recipientReference,
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
  const receivingContext = structuredClone(
    await options.loadStoredReceivingContext(tx, {
      siteId: row.siteId,
      accountId: row.accountId,
      environment: row.environment,
    }),
  );
  if (!receivingContext) throw new ReceivingReadinessServiceError();
  const readiness = () =>
    evaluateReceivingReadiness({
      ...receivingContext,
      siteId: row.siteId,
      now: now(options),
    });
  assertReceivingReady(readiness());
  if (!sameBinding(stored.receiving, receivingContext.providerBinding))
    throw new ReceivingReadinessServiceError();
  const gift = await findPublishedGiftForQuote(tx, row.siteId, row.giftId, {
    applicationEnvironment: receivingContext.environment,
    liveDemoSiteIds: receivingContext.liveDemoSiteIds,
    now: options.now,
    readReadiness: async () => readiness(),
  });
  if (
    gift?.publicationState !== "PUBLISHED" ||
    gift.siteActive !== true ||
    gift.gift.id !== row.giftId ||
    gift.gift.siteId !== row.siteId ||
    !publicGiftItemSchema.safeParse(gift.gift).success
  )
    return fail("QUOTE_INVALID");
  return {
    quoteSnapshot: stored,
    receivingContext,
    gift: structuredClone(gift),
  };
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

async function insertReservation(
  tx: GiftCheckoutTransaction,
  row: QuoteRow,
  input: GiftCheckoutReservation,
  options: GiftCheckoutRepositoryOptions,
  clock: Date,
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
  const leaseExpiresAt = new Date(clock.getTime() + options.leaseMs);
  instant(leaseExpiresAt);
  await tx.insert(giftOrder).values({
    ...scope,
    id: input.orderId,
    quoteId: input.quoteId,
    requestId: input.requestId,
    requestHash: hash,
    recoveryTokenHash: input.recoveryTokenHash,
    createdAt,
  });
  // The lease token is the attempt id: it proves this instance dispatched it.
  await tx.insert(financialOperation).values({
    ...scope,
    id: input.attemptId,
    orderId: input.orderId,
    kind: "CHECKOUT_CREATE",
    state: "PROCESSING",
    requestId: input.requestId,
    requestHash: hash,
    requestSnapshot: operationSnapshot(scope, input),
    leaseOwner: options.instanceId,
    leaseToken: input.attemptId,
    leaseExpiresAt,
    attempts: 1,
    createdAt,
    updatedAt: clock,
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
  const record = await readRecord(tx, input.siteId, input.requestId);
  if (record?.state !== "CREATING") return fail("EXTERNAL_OUTCOME_UNKNOWN");
  return record;
}

function pixData(order: PagarmeOrderObservation) {
  const pix = order.charges[0]?.pix ?? null;
  if (pix === null) return null;
  return giftCheckoutPixSchema.parse(pix);
}

async function bindOrder(
  tx: GiftCheckoutReader,
  identity: Pick<GiftCheckoutIdentity, "siteId" | "orderId" | "attemptId">,
  order: PagarmeOrderObservation,
  observedAt: string,
) {
  const at = instant(new Date(observedAt));
  if (order.code !== identity.attemptId)
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const pix = pixData(order);
  const operation = await tx.execute(sql`UPDATE ${financialOperation}
    SET state = 'SUCCEEDED', provider_operation_reference = ${order.id}, last_error_code = NULL,
      updated_at = GREATEST(updated_at, ${at}::timestamptz),
      lease_expires_at = GREATEST(lease_expires_at, updated_at, ${at}::timestamptz)
    WHERE id = ${identity.attemptId} AND site_id = ${identity.siteId} AND order_id = ${identity.orderId}
      AND kind = 'CHECKOUT_CREATE'
      AND (state IN ('PROCESSING', 'UNKNOWN') OR (state = 'SUCCEEDED' AND provider_operation_reference = ${order.id}))
    RETURNING id`);
  if (operation.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
  const attempt = await tx.execute(sql`UPDATE ${giftCheckoutAttempt}
    SET provider_reference = ${order.id},
      expires_at = ${pix ? pix.expiresAt : null}::timestamptz,
      pix_qr_code = ${pix?.qrCode ?? null}, pix_qr_code_url = ${pix?.qrCodeUrl ?? null}
    WHERE id = ${identity.attemptId} AND site_id = ${identity.siteId} AND order_id = ${identity.orderId}
      AND (provider_reference IS NULL OR provider_reference = ${order.id}) RETURNING id`);
  if (attempt.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
}

export type GiftCheckoutStore = GiftCheckoutRepository & {
  bindRecoveredOrder(
    binding: GiftCheckoutOrderBinding,
    order: PagarmeOrderObservation,
    observedAt: string,
  ): Promise<void>;
  closeMissingOrder(
    binding: GiftCheckoutOrderBinding,
    observedAt: string,
  ): Promise<void>;
};

export function createGiftCheckoutRepository(
  db: GiftCheckoutDatabase,
  options: GiftCheckoutRepositoryOptions,
): GiftCheckoutStore {
  if (
    !giftQuoteSchema.shape.siteId.safeParse(options.instanceId).success ||
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs < 1_000
  )
    return fail("EXTERNAL_OUTCOME_UNKNOWN");
  async function transition(
    identity: GiftCheckoutIdentity,
    observedAt: string,
    target: "UNKNOWN" | "FAILED",
  ) {
    validIdentity(identity);
    const at = new Date(observedAt);
    instant(at);
    await guarded(() =>
      db.transaction(async (tx) => {
        const updated =
          await tx.execute(sql`UPDATE ${financialOperation} SET state = ${target},
          last_error_code = ${target === "FAILED" ? "PROVIDER_REJECTED" : null},
          updated_at = GREATEST(updated_at, ${instant(at)}::timestamptz)
          WHERE id = ${identity.attemptId} AND site_id = ${identity.siteId} AND order_id = ${identity.orderId}
            AND kind = 'CHECKOUT_CREATE' AND state = 'PROCESSING' RETURNING id`);
        if (updated.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
      }),
    );
  }
  return {
    findByRequest(siteId, requestId) {
      return guarded(() => readRecord(db, siteId, requestId));
    },
    findQuote(siteId, quoteId) {
      return guarded(async () => {
        const row = await quoteRow(db, siteId, quoteId);
        return row ? snapshot(row) : null;
      });
    },
    reserve(reservation, assertLockedEligibility) {
      const input = reservationInput(reservation);
      return guarded(() =>
        db.transaction(async (tx) => {
          await lockRequest(tx, input.siteId, input.requestId);
          const existing = await readRecord(tx, input.siteId, input.requestId);
          if (existing) {
            sameRequest(existing, input);
            return { created: false, record: existing };
          }
          const site = await tx.execute(
            sql`SELECT id FROM site WHERE id = ${input.siteId} FOR UPDATE`,
          );
          if (site.rows.length !== 1) return fail("QUOTE_INVALID");
          const row = await quoteRow(tx, input.siteId, input.quoteId, true);
          if (!row || !isDeepStrictEqual(input.quoteSnapshot, snapshot(row)))
            return fail("QUOTE_INVALID");
          const ordered = await tx.execute(
            checkoutQuery(
              sql`o.site_id = ${input.siteId} AND o.account_id = ${row.accountId} AND o.environment = ${row.environment} AND o.quote_id = ${input.quoteId}`,
            ),
          );
          if (ordered.rows.length) return fail("REQUEST_CONFLICT");
          assertLockedEligibility(await lockEligibility(tx, row, options));
          return {
            created: true,
            record: await insertReservation(
              tx,
              row,
              input,
              options,
              now(options),
            ),
          };
        }),
      );
    },
    saveOrder(identity, order, observedAt) {
      validIdentity(identity);
      return guarded(() =>
        db.transaction(async (tx) => {
          await bindOrder(tx, identity, order, observedAt);
          const record = await readRecord(
            tx,
            identity.siteId,
            identity.requestId,
          );
          if (!record || record.attemptId !== identity.attemptId)
            return fail("EXTERNAL_OUTCOME_UNKNOWN");
          return record;
        }),
      );
    },
    bindRecoveredOrder(binding, order, observedAt) {
      return guarded(() =>
        db.transaction((tx) => bindOrder(tx, binding, order, observedAt)),
      );
    },
    closeMissingOrder(binding, observedAt) {
      const at = instant(new Date(observedAt));
      return guarded(async () => {
        const updated = await db.execute(sql`UPDATE ${financialOperation}
          SET state = 'FAILED', last_error_code = 'ORDER_NOT_FOUND', updated_at = GREATEST(updated_at, ${at}::timestamptz)
          WHERE id = ${binding.attemptId} AND site_id = ${binding.siteId} AND order_id = ${binding.orderId}
            AND kind = 'CHECKOUT_CREATE' AND state IN ('PROCESSING', 'UNKNOWN') RETURNING id`);
        if (updated.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
      });
    },
    markOutcomeUnknown(identity, observedAt) {
      return transition(identity, observedAt, "UNKNOWN");
    },
    markProviderRejected(identity, observedAt) {
      return transition(identity, observedAt, "FAILED");
    },
    loadBinding(identity) {
      return guarded(async () => {
        const result = await db.execute(
          checkoutQuery(
            sql`o.site_id = ${identity.siteId} AND a.id = ${identity.attemptId}`,
          ),
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return fail("EXTERNAL_OUTCOME_UNKNOWN");
        const raw = result.rows[0];
        const record = project(raw);
        return giftCheckoutOrderBinding({
          ...record,
          accountId: String(raw.accountId),
          pixExpiresAt: record.pix?.expiresAt ?? null,
        });
      });
    },
  };
}
