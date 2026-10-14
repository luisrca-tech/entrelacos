import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  giftQuoteSchema,
  siteAccessSchema,
  siteIdSchema,
  type WithdrawalRequestContext,
  type WithdrawalRequestStatus,
  withdrawalPreviewSchema,
  withdrawalRequestContextSchema,
  withdrawalRequestStatusSchema,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftPaymentRecord,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  session,
  site,
  siteMembership,
  user,
  withdrawalIntent,
  withdrawalRequest,
} from "@entrelacos/database/schema";
import { type SQL, sql } from "drizzle-orm";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, ADMIN_IDLE_TIMEOUT_MS } from "./authHttp";
import {
  compareDatabaseTimestamps,
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import {
  assertFinancialReadAccess,
  assertRecipientFinancialAction,
  type FinancialActor,
  FinancialAuthorizationError,
  type RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import {
  evaluateReceivingReadiness,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";
import {
  loadReceivingContextInTransaction,
  type ReceivingTransaction,
} from "./receivingRepository";
import { resolveSiteAccess, SiteAccessDeniedError } from "./siteAccess";
import {
  captureWithdrawalPresentation,
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentRecord,
  readWithdrawalConsentSnapshot,
  readWithdrawalReservationRecord,
  readWithdrawalReservationSnapshot,
  sameWithdrawalConsentTerms,
  type WithdrawalConsentRecord,
  type WithdrawalConsentSnapshot,
  type WithdrawalFeeScope,
  type WithdrawalPresentationScope,
  type WithdrawalReadAttempt,
  type WithdrawalReservationContext,
  type WithdrawalReservationRecord,
  type WithdrawalReservationRepository,
  WithdrawalReservationServiceError,
  type WithdrawalStoredPresentation,
  type WithdrawalVerifiedPresentation,
} from "./withdrawalReservations";

export type WithdrawalReservationDatabase = Pick<
  DatabaseConnection["db"],
  "execute" | "transaction"
>;
export type WithdrawalReservationRepositoryOptions =
  | { mode: "disabled" }
  | {
      mode: "sandbox" | "live";
      applicationEnvironment: "development" | "test" | "production";
      maxAuthAgeMs: number;
      freshnessMs: number;
      now(): Date;
      loadVerifiedPresentationInTransaction?: WithdrawalStoredPresentationLoader;
    };
export interface WithdrawalStoredPresentationLoader {
  (
    tx: ReceivingTransaction,
    scope: WithdrawalFeeScope,
  ): Promise<WithdrawalVerifiedPresentation | null>;
  (
    tx: ReceivingTransaction,
    scope: WithdrawalPresentationScope,
  ): Promise<WithdrawalStoredPresentation | null>;
}
type Reader = Pick<WithdrawalReservationDatabase, "execute">;
interface Association {
  row: Record<string, unknown>;
  consent: WithdrawalConsentRecord;
  updatedAt: Date;
}

async function scopeRevision(
  reader: Reader,
  siteId: string,
  environment: string,
): Promise<string> {
  const result = await reader.execute(
    sql`SELECT COALESCE(SUM(r.request_revision),0)::text AS "scopeRevision" FROM ${withdrawalRequest} r WHERE r.site_id=${siteId} AND r.environment=${environment}`,
  );
  if (
    result.rows.length !== 1 ||
    typeof result.rows[0].scopeRevision !== "string" ||
    !/^(0|[1-9]\d*)$/.test(result.rows[0].scopeRevision)
  )
    return fail();
  return result.rows[0].scopeRevision;
}
function validateAssociation(
  value: unknown,
  siteId: string,
  requestId: string,
  at: Date,
): Association {
  const row = record(value);
  id(row.id);
  const consent = readWithdrawalConsentRecord({
    snapshot: row.previewSnapshot,
    previewHash: row.previewHash,
    requestRevision: row.requestRevision,
    state: row.state,
  });
  const frozen = consent.snapshot;
  if (
    row.siteId !== siteId ||
    row.requestId !== requestId ||
    frozen.preview.siteId !== siteId ||
    frozen.preview.requestId !== requestId ||
    row.accountId !== frozen.scope.accountId ||
    row.environment !== frozen.scope.environment ||
    row.operatorUserId !== frozen.operatorUserId ||
    row.destinationVersion !== frozen.scope.destinationVersion
  )
    return fail();
  const created = storedTime(row.createdAt),
    updated = storedTime(row.updatedAt),
    expiry = storedTime(row.expiresAt);
  if (
    compareDatabaseTimestamps(created, new Date(frozen.preview.issuedAt)) < 0 ||
    compareDatabaseTimestamps(expiry, new Date(frozen.preview.expiresAt)) !==
      0 ||
    compareDatabaseTimestamps(updated, created) < 0 ||
    compareDatabaseTimestamps(updated, at) > 0 ||
    compareDatabaseTimestamps(created, at) > 0
  )
    return fail();
  if (consent.state === "OPEN") {
    if (
      row.withdrawalIntentId !== null ||
      row.sealedAt !== null ||
      compareDatabaseTimestamps(updated, created) !== 0
    )
      return fail();
  } else if (consent.state === "COMMITTED") {
    id(row.withdrawalIntentId);
    if (row.sealedAt !== null) return fail();
  } else {
    if (
      row.withdrawalIntentId !== null ||
      compareDatabaseTimestamps(storedTime(row.sealedAt), updated) !== 0
    )
      return fail();
  }
  return { row, consent, updatedAt: updated };
}
async function findAssociation(
  reader: Reader,
  siteId: string,
  requestId: string,
  at: Date,
  lock = false,
): Promise<Association | null> {
  const found = await reader.execute(
    sql`SELECT r.id,r.site_id AS "siteId",r.account_id AS "accountId",r.environment,r.operator_user_id AS "operatorUserId",r.destination_version AS "destinationVersion",r.request_id AS "requestId",r.preview_snapshot AS "previewSnapshot",r.preview_hash AS "previewHash",r.expires_at AS "expiresAt",r.state,r.request_revision::text AS "requestRevision",r.withdrawal_intent_id AS "withdrawalIntentId",r.sealed_at AS "sealedAt",r.created_at AS "createdAt",r.updated_at AS "updatedAt" FROM ${withdrawalRequest} r WHERE r.site_id=${siteId} AND r.request_id=${requestId} LIMIT 2 ${lock ? sql`FOR UPDATE OF r` : sql``}`,
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length !== 1) return fail();
  return validateAssociation(found.rows[0], siteId, requestId, at);
}
async function noNativeOperation(
  reader: Reader,
  siteId: string,
  requestId: string,
  lock = false,
): Promise<void> {
  const result = await reader.execute(
    sql`SELECT op.id FROM ${financialOperation} op WHERE op.site_id=${siteId} AND op.kind='WITHDRAWAL' AND op.request_id=${requestId} LIMIT 2 ${lock ? sql`FOR UPDATE OF op` : sql``}`,
  );
  if (result.rows.length !== 0) fail();
}
function projection(
  siteId: string,
  requestId: string,
  environment: "sandbox" | "live",
  revision: string,
  at: Date,
  association: Association | null,
  native: WithdrawalReservationRecord | null,
): WithdrawalRequestStatus {
  const requestRevision = association?.consent.requestRevision ?? null;
  const nativeAt = native ? nativeModificationTimes.get(native) : undefined;
  if (native && !nativeAt) return fail();
  const latest = association
    ? nativeAt && compareDatabaseTimestamps(nativeAt, association.updatedAt) > 0
      ? nativeAt
      : association.updatedAt
    : nativeAt;
  const common = {
    siteId,
    requestId,
    mode: environment,
    requestRevision,
    scopeRevision: revision,
    observedAt: at.toISOString(),
    observationOrder: {
      scopeRevision: revision,
      requestRevision,
      recordUpdatedAtMicroseconds: latest
        ? databaseTimestampEpochMicroseconds(latest).toString()
        : null,
    },
  };
  if (native) {
    if (native.snapshot.environment !== environment)
      return fail("REQUEST_CONFLICT", 409);
    if (
      association &&
      (association.consent.state !== "COMMITTED" ||
        association.row.withdrawalIntentId !== native.intent.id ||
        !sameWithdrawalConsentTerms(
          association.consent.snapshot,
          native.snapshot,
          association.consent.snapshot.presentation,
        ))
    )
      return fail();
    return withdrawalRequestStatusSchema.parse({
      ...common,
      state: "EXISTING",
      command: {
        requestId,
        amountCents: native.intent.amountCents,
        destinationVersion: native.intent.destinationVersion,
      },
      withdrawal: native.intent,
      preview: association?.consent.snapshot.preview ?? null,
    });
  }
  if (!association)
    return withdrawalRequestStatusSchema.parse({
      ...common,
      state: "UNRESOLVED",
      command: null,
    });
  const consent = association.consent.snapshot,
    command = {
      requestId,
      amountCents: consent.preview.amountCents,
      destinationVersion: consent.preview.destinationVersion,
    };
  if (association.consent.state === "COMMITTED") return fail();
  return withdrawalRequestStatusSchema.parse(
    association.consent.state === "OPEN"
      ? { ...common, state: "OPEN", preview: consent.preview }
      : {
          ...common,
          state: "SEALED_NOT_CREATED",
          command,
          sealedAt: storedTime(association.row.sealedAt).toISOString(),
        },
  );
}

function fail(
  code: WithdrawalReservationServiceError["code"] = "WITHDRAWAL_UNAVAILABLE",
  status: 400 | 403 | 409 | 503 = 503,
): never {
  throw new WithdrawalReservationServiceError(status, code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  const parsed = giftQuoteSchema.shape.siteId.safeParse(value);
  if (!parsed.success) return fail();
  return parsed.data;
}
function clockTime(value: unknown): bigint {
  // Backend clocks and authentication proofs are Date-only, never SQL strings.
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    value.getTime() < 0 ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    return fail();
  return BigInt(value.getTime()) * 1000n;
}
function storedTime(value: unknown): Date {
  const parsed = readDatabaseTimestamp(value);
  if (databaseTimestampEpochMicroseconds(parsed) < 0n) return fail();
  return parsed;
}
function nullableReference(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value))
    return fail();
  return value;
}
function count(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 40
  )
    return fail();
  return BigInt(value);
}
function safeCount(value: unknown): number {
  const integer = count(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return Number(integer);
}
function safeError(error: unknown): never {
  if (
    error instanceof WithdrawalReservationServiceError &&
    [400, 403, 409, 503].includes(error.status) &&
    [
      "WITHDRAWAL_INVALID",
      "MEMBERSHIP_DENIED",
      "RECENT_AUTH_REQUIRED",
      "RECIPIENT_REQUIRED",
      "DESTINATION_UNVERIFIED",
      "REQUEST_CONFLICT",
      "PROVIDER_MODE_UNAVAILABLE",
      "FEE_QUOTE_UNAVAILABLE",
      "PROVIDER_BALANCE_UNAVAILABLE",
      "FINANCIAL_EVENTS_UNRESOLVED",
      "INSUFFICIENT_FUNDS",
      "WITHDRAWAL_UNAVAILABLE",
    ].includes(error.code)
  )
    throw new WithdrawalReservationServiceError(error.status, error.code);
  if (
    error instanceof FinancialAuthorizationError ||
    error instanceof SiteAccessDeniedError
  ) {
    const code = error.code;
    if (
      [
        "MEMBERSHIP_DENIED",
        "RECIPIENT_REQUIRED",
        "RECENT_AUTH_REQUIRED",
        "DESTINATION_UNVERIFIED",
      ].includes(code)
    )
      return fail(
        code as WithdrawalReservationServiceError["code"],
        code === "DESTINATION_UNVERIFIED" ? 409 : 403,
      );
  }
  if (error instanceof ReceivingReadinessServiceError)
    throw new ReceivingReadinessServiceError();
  return fail();
}

async function find(
  reader: Reader,
  siteId: string,
  requestId: string,
  databaseNow: Date,
  lock = false,
): Promise<WithdrawalReservationRecord | null> {
  const selected =
    await reader.execute(sql`SELECT w.id,w.site_id AS "siteId",w.account_id AS "accountId",w.environment,w.operator_user_id AS "operatorUserId",w.destination_version AS "destinationVersion",w.request_id AS "requestId",w.request_hash AS "requestHash",w.authorization_reference AS "authorizationReference",w.policy_version AS "policyVersion",w.amount_cents AS "amountCents",w.fee_cents AS "feeCents",w.net_cents AS "netCents",w.currency,w.state,w.reservation_state AS "reservationState",w.reserved_cents AS "reservedCents",w.provider_reference AS "providerReference",w.receipt_reference AS "receiptReference",w.resolution_observed_at AS "resolutionObservedAt",w.created_at AS "createdAt",w.updated_at AS "updatedAt",a.provider AS "accountProvider",a.operator_user_id AS "accountOperatorUserId"
    FROM ${withdrawalIntent} w INNER JOIN ${receivingAccount} a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment
    WHERE w.site_id=${siteId} AND w.request_id=${requestId} LIMIT 2 ${lock ? sql`FOR UPDATE OF w` : sql``}`);
  if (selected.rows.length === 0) return null;
  if (selected.rows.length !== 1) return fail();
  const row = record(selected.rows[0]);
  const operations =
    await reader.execute(sql`SELECT op.id,op.site_id AS "siteId",op.account_id AS "accountId",op.environment,op.kind,op.state,op.request_id AS "requestId",op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",op.withdrawal_intent_id AS "withdrawalIntentId",op.order_id AS "orderId",op.payment_id AS "paymentId",op.provider_operation_reference AS "providerOperationReference",op.attempts,op.next_attempt_at AS "nextAttemptAt",op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",op.last_error_code AS "lastErrorCode",op.created_at AS "createdAt",op.updated_at AS "updatedAt"
    FROM ${financialOperation} op WHERE op.site_id=${siteId} AND op.withdrawal_intent_id=${row.id} LIMIT 2 ${lock ? sql`FOR UPDATE OF op` : sql``}`);
  if (operations.rows.length !== 1) return fail();
  const operation = record(operations.rows[0]);
  return validateNative(row, operation, siteId, requestId, databaseNow);
}

const nativeModificationTimes = new WeakMap<
  WithdrawalReservationRecord,
  Date
>();
function validateNative(
  row: Record<string, unknown>,
  operation: Record<string, unknown>,
  siteId: string,
  requestId: string,
  databaseNow: Date,
): WithdrawalReservationRecord {
  const snapshot = readWithdrawalReservationSnapshot(operation.requestSnapshot);
  const created = storedTime(row.createdAt);
  const updated = storedTime(row.updatedAt);
  const operationCreated = storedTime(operation.createdAt);
  const operationUpdated = storedTime(operation.updatedAt);
  const originalCreated = new Date(snapshot.intent.createdAt);
  const state = row.state;
  const operationState = operation.state;
  const coherent =
    state === "REQUESTED" || state === "AWAITING_AUTHORIZATION"
      ? operationState === "REQUESTED"
      : state === "PROCESSING"
        ? operationState === "CLAIMED" || operationState === "PROCESSING"
        : state === "UNKNOWN"
          ? operationState === "UNKNOWN" ||
            operationState === "REQUESTED" ||
            operationState === "PROCESSING" ||
            operationState === "CLAIMED"
          : false;
  if (
    !coherent ||
    row.siteId !== siteId ||
    row.requestId !== requestId ||
    row.id !== snapshot.intent.id ||
    snapshot.intent.siteId !== siteId ||
    snapshot.requestId !== requestId ||
    row.accountId !== snapshot.accountId ||
    row.environment !== snapshot.environment ||
    row.operatorUserId !== snapshot.operatorUserId ||
    row.accountProvider !== "ASAAS" ||
    row.accountOperatorUserId !== snapshot.operatorUserId ||
    row.destinationVersion !== snapshot.intent.destinationVersion ||
    row.requestHash !== snapshot.requestHash ||
    row.authorizationReference !== snapshot.authenticationAuditHash ||
    row.policyVersion !== snapshot.feeQuote.policyVersion ||
    row.amountCents !== snapshot.intent.amountCents ||
    row.feeCents !== snapshot.intent.feeCents ||
    row.netCents !== snapshot.intent.netCents ||
    row.currency !== "BRL" ||
    row.reservationState !== "HELD" ||
    row.reservedCents !== snapshot.intent.amountCents ||
    row.resolutionObservedAt !== null ||
    operation.id !== snapshot.operationId ||
    operation.siteId !== siteId ||
    operation.accountId !== snapshot.accountId ||
    operation.environment !== snapshot.environment ||
    operation.kind !== "WITHDRAWAL" ||
    operation.requestId !== requestId ||
    operation.requestHash !== snapshot.requestHash ||
    operation.withdrawalIntentId !== snapshot.intent.id ||
    operation.orderId !== null ||
    operation.paymentId !== null ||
    !Number.isSafeInteger(operation.attempts) ||
    (operation.attempts as number) < 0 ||
    compareDatabaseTimestamps(created, originalCreated) !== 0 ||
    compareDatabaseTimestamps(operationCreated, originalCreated) !== 0 ||
    compareDatabaseTimestamps(updated, created) < 0 ||
    compareDatabaseTimestamps(operationUpdated, operationCreated) < 0 ||
    compareDatabaseTimestamps(updated, databaseNow) > 0 ||
    compareDatabaseTimestamps(operationUpdated, databaseNow) > 0
  )
    return fail();
  const provider = nullableReference(row.providerReference);
  const operationProvider = nullableReference(
    operation.providerOperationReference,
  );
  nullableReference(row.receiptReference);
  storedTime(operation.nextAttemptAt);
  if (
    provider !== null &&
    operationProvider !== null &&
    provider !== operationProvider
  )
    return fail();
  const leases = [
    operation.leaseOwner,
    operation.leaseToken,
    operation.leaseExpiresAt,
  ];
  if (leases.some((value) => value !== null)) {
    if (
      leases.some((value) => value === null) ||
      typeof operation.leaseOwner !== "string" ||
      typeof operation.leaseToken !== "string"
    )
      return fail();
    id(operation.leaseOwner);
    id(operation.leaseToken);
    storedTime(operation.leaseExpiresAt);
  }
  if (
    operation.lastErrorCode !== null &&
    (typeof operation.lastErrorCode !== "string" ||
      !/^[A-Z0-9_]{1,64}$/.test(operation.lastErrorCode))
  )
    return fail();
  if (
    operationState === "REQUESTED" &&
    (operation.attempts !== 0 ||
      leases.some((value) => value !== null) ||
      provider !== null ||
      operationProvider !== null ||
      row.receiptReference !== null)
  )
    return fail();
  if (
    (operationState === "CLAIMED" || operationState === "PROCESSING") &&
    ((operation.attempts as number) < 1 ||
      leases.some((value) => value === null))
  )
    return fail();
  const found = readWithdrawalReservationRecord({
    snapshot,
    intent: {
      ...snapshot.intent,
      state,
      createdAt: created.toISOString(),
      updatedAt: updated.toISOString(),
    },
  });
  nativeModificationTimes.set(
    found,
    compareDatabaseTimestamps(updated, operationUpdated) >= 0
      ? updated
      : operationUpdated,
  );
  return found;
}

type EnabledOptions = Exclude<
  WithdrawalReservationRepositoryOptions,
  { mode: "disabled" }
>;
interface Authority {
  actor: FinancialActor;
  access: ReturnType<typeof siteAccessSchema.parse>;
  isDemo: boolean;
  user: Record<string, unknown>;
  observedAt: Date;
  clock(): Promise<Date>;
}
async function requestAuthority(
  tx: ReceivingTransaction,
  attempt: WithdrawalReadAttempt,
  options: EnabledOptions,
  mutating: boolean,
  requestId?: string,
  recentAuth?: RecentFinancialAuthenticationEvidence | null,
): Promise<Authority> {
  const incoming = record(attempt.actor);
  const actor: FinancialActor = Object.freeze({
    userId: id(incoming.userId),
    siteId: siteIdSchema.parse(incoming.siteId),
    sessionId: id(incoming.sessionId),
  });
  if (Object.keys(incoming).sort().join(",") !== "sessionId,siteId,userId")
    return fail("MEMBERSHIP_DENIED", 403);
  let proofAt: bigint | null = null,
    proofExpiry: bigint | null = null;
  if (recentAuth !== undefined) {
    if (recentAuth === null) return fail("RECENT_AUTH_REQUIRED", 403);
    const proof = record(recentAuth);
    if (
      proof.userId !== actor.userId ||
      proof.siteId !== actor.siteId ||
      proof.sessionId !== actor.sessionId ||
      proof.provenance !== "backend" ||
      proof.verification !== "verified" ||
      !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
        String(proof.proofKind),
      )
    )
      return fail("RECENT_AUTH_REQUIRED", 403);
    proofAt = clockTime(proof.authenticatedAt);
    proofExpiry = clockTime(proof.expiresAt);
    if (
      proofExpiry <= proofAt ||
      proofExpiry - proofAt > BigInt(options.maxAuthAgeMs) * 1000n
    )
      return fail("RECENT_AUTH_REQUIRED", 403);
  }
  let lastLocal = -1n,
    lastDatabase: Date | null = null,
    sessionTimes: bigint[] | null = null;
  const check = (at: bigint) => {
    if (
      proofAt !== null &&
      proofExpiry !== null &&
      (proofAt > at ||
        at - proofAt > BigInt(options.maxAuthAgeMs) * 1000n ||
        proofExpiry <= at)
    )
      fail("RECENT_AUTH_REQUIRED", 403);
    if (
      sessionTimes &&
      (sessionTimes[0] <= at ||
        sessionTimes[1] > at ||
        sessionTimes[2] > sessionTimes[1] ||
        sessionTimes[2] >= sessionTimes[0] ||
        at - sessionTimes[1] >= BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
        at - sessionTimes[2] >= BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n)
    )
      fail("MEMBERSHIP_DENIED", 403);
  };
  const local = () => {
    const at = clockTime(options.now());
    if (at < lastLocal) fail();
    lastLocal = at;
    check(at);
  };
  const execute = async (statement: SQL) => {
    local();
    const result = await tx.execute(statement);
    local();
    return result;
  };
  const clock = async () => {
    const result = await execute(
      sql`SELECT clock_timestamp() AS "currentTime"`,
    );
    if (result.rows.length !== 1) return fail();
    const at = storedTime(result.rows[0].currentTime);
    if (lastDatabase && compareDatabaseTimestamps(at, lastDatabase) < 0)
      return fail();
    lastDatabase = at;
    check(databaseTimestampEpochMicroseconds(at));
    return at;
  };
  local();
  if (mutating) {
    if (!requestId) return fail();
    await execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["withdrawal-reservation", actor.siteId, requestId])},0))`,
    );
  }
  const observedAt = mutating ? null : await clock();
  const sites = await execute(
    sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${actor.siteId} ${mutating ? sql`FOR UPDATE OF st` : sql``}`,
  );
  if (
    sites.rows.length !== 1 ||
    sites.rows[0].siteId !== actor.siteId ||
    typeof sites.rows[0].isDemo !== "boolean"
  )
    return fail();
  if (options.mode === "live" && sites.rows[0].isDemo)
    return fail("PROVIDER_MODE_UNAVAILABLE", 409);
  const users = await execute(
    sql`SELECT u.id AS "userId",u.role,u.state,u.name AS "operatorDisplayName",u.updated_at AS "operatorProfileUpdatedAt" FROM ${user} u WHERE u.id=${actor.userId} AND u.state='ACTIVE' ${mutating ? sql`FOR SHARE OF u` : sql``}`,
  );
  if (
    users.rows.length !== 1 ||
    users.rows[0].userId !== actor.userId ||
    users.rows[0].state !== "ACTIVE" ||
    !["SITE_ADMIN", "SITE_ASSISTANT"].includes(String(users.rows[0].role))
  )
    return fail("MEMBERSHIP_DENIED", 403);
  const sessions = await execute(
    sql`SELECT se.user_id AS "userId",se.id AS "sessionId",se.expires_at AS "sessionExpiresAt",se.last_active_at AS "lastActiveAt",se.created_at AS "sessionCreatedAt" FROM ${session} se WHERE se.id=${actor.sessionId} AND se.user_id=${actor.userId} ${mutating ? sql`FOR SHARE OF se` : sql``}`,
  );
  if (
    sessions.rows.length !== 1 ||
    sessions.rows[0].userId !== actor.userId ||
    sessions.rows[0].sessionId !== actor.sessionId
  )
    return fail("MEMBERSHIP_DENIED", 403);
  sessionTimes = [
    sessions.rows[0].sessionExpiresAt,
    sessions.rows[0].lastActiveAt,
    sessions.rows[0].sessionCreatedAt,
  ].map((value) => databaseTimestampEpochMicroseconds(storedTime(value)));
  await clock();
  const memberships = await execute(
    sql`SELECT m.id,m.site_id AS "siteId",m.user_id AS "userId",m.role,m.revoked_at AS "revokedAt" FROM ${siteMembership} m WHERE m.site_id=${actor.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL ${mutating ? sql`FOR SHARE OF m` : sql``}`,
  );
  if (
    memberships.rows.length !== 1 ||
    memberships.rows[0].siteId !== actor.siteId ||
    memberships.rows[0].userId !== actor.userId ||
    memberships.rows[0].role !== "SITE_ADMIN" ||
    memberships.rows[0].revokedAt !== null
  )
    return fail("MEMBERSHIP_DENIED", 403);
  const access = siteAccessSchema.parse(
    await resolveSiteAccess(tx, {
      userId: actor.userId,
      platformRole: users.rows[0].role as "SITE_ADMIN" | "SITE_ASSISTANT",
      siteId: actor.siteId,
    }),
  );
  assertFinancialReadAccess(access, actor.siteId);
  const offered = siteAccessSchema.parse(attempt.access);
  if (
    access.userId !== actor.userId ||
    access.membershipId !== memberships.rows[0].id ||
    offered.siteId !== actor.siteId ||
    offered.userId !== actor.userId ||
    offered.membershipId !== access.membershipId ||
    offered.membershipRole !== "SITE_ADMIN" ||
    !offered.capabilities.readFinance
  )
    return fail("MEMBERSHIP_DENIED", 403);
  const at = await clock();
  return {
    actor,
    access,
    isDemo: sites.rows[0].isDemo,
    user: record(users.rows[0]),
    observedAt: observedAt ?? at,
    clock,
  };
}
async function requestPair(
  tx: Reader,
  authority: Authority,
  requestId: string,
  mode: "sandbox" | "live",
  lock = false,
): Promise<{
  association: Association | null;
  native: WithdrawalReservationRecord | null;
}> {
  const at = lock ? await authority.clock() : authority.observedAt;
  const preliminary = await findAssociation(
    tx,
    authority.actor.siteId,
    requestId,
    at,
  );
  const initialNative = await find(tx, authority.actor.siteId, requestId, at);
  const accountId =
    preliminary?.consent.snapshot.scope.accountId ??
    initialNative?.snapshot.accountId;
  const environment =
    preliminary?.consent.snapshot.scope.environment ??
    initialNative?.snapshot.environment;
  const owner =
    preliminary?.consent.snapshot.operatorUserId ??
    initialNative?.snapshot.operatorUserId;
  if (
    owner !== undefined &&
    (owner !== authority.actor.userId || environment !== mode)
  )
    return fail("REQUEST_CONFLICT", 409);
  if (lock && accountId) {
    const accounts = await tx.execute(
      sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId" FROM ${receivingAccount} a WHERE a.id=${accountId} AND a.site_id=${authority.actor.siteId} AND a.environment=${mode} FOR UPDATE OF a`,
    );
    const account = accounts.rows[0];
    if (
      accounts.rows.length !== 1 ||
      account.id !== accountId ||
      account.siteId !== authority.actor.siteId ||
      account.environment !== mode ||
      account.provider !== "ASAAS" ||
      account.operatorUserId !== authority.actor.userId
    )
      return fail("RECIPIENT_REQUIRED", 403);
  }
  const association = lock
    ? await findAssociation(
        tx,
        authority.actor.siteId,
        requestId,
        await authority.clock(),
        true,
      )
    : preliminary;
  const native = lock
    ? await find(
        tx,
        authority.actor.siteId,
        requestId,
        await authority.clock(),
        true,
      )
    : initialNative;
  if (!native)
    await noNativeOperation(tx, authority.actor.siteId, requestId, lock);
  return { association, native };
}
async function currentPresentation(
  tx: ReceivingTransaction,
  authority: Authority,
  consent: WithdrawalConsentSnapshot,
  options: EnabledOptions,
  loader: NonNullable<EnabledOptions["loadVerifiedPresentationInTransaction"]>,
): Promise<WithdrawalConsentSnapshot["presentation"]> {
  const scope = consent.scope;
  const accounts = await tx.execute(
    sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.observed_at AS "observedAt",a.is_current AS "isCurrent" FROM ${receivingAccount} a WHERE a.id=${scope.accountId} AND a.site_id=${scope.siteId} AND a.environment=${scope.environment} FOR UPDATE OF a`,
  );
  const a = accounts.rows[0];
  if (
    accounts.rows.length !== 1 ||
    a.id !== scope.accountId ||
    a.siteId !== scope.siteId ||
    a.environment !== scope.environment ||
    a.provider !== "ASAAS" ||
    a.operatorUserId !== authority.actor.userId ||
    a.isCurrent !== true ||
    a.accountReference !== scope.accountReference ||
    a.recipientReference !== consent.recipientReference
  )
    return fail("RECIPIENT_REQUIRED", 403);
  const destinations = await tx.execute(
    sql`SELECT d.id,d.site_id AS "siteId",d.account_id AS "accountId",d.environment,d.version,d.bank_reference AS "bankReference",d.bank_state AS "bankState",d.is_current AS "isCurrent" FROM ${receivingDestination} d WHERE d.site_id=${scope.siteId} AND d.account_id=${scope.accountId} AND d.environment=${scope.environment} AND d.version=${scope.destinationVersion} LIMIT 2 FOR SHARE OF d`,
  );
  const d = destinations.rows[0];
  if (
    destinations.rows.length !== 1 ||
    d.siteId !== scope.siteId ||
    d.accountId !== scope.accountId ||
    d.environment !== scope.environment ||
    d.version !== scope.destinationVersion ||
    d.bankReference !== scope.bankReference ||
    d.bankState !== "VERIFIED" ||
    d.isCurrent !== true
  )
    return fail("DESTINATION_UNVERIFIED", 409);
  const evidence = await tx.execute(
    sql`SELECT ev.id,ev.site_id AS "siteId",ev.account_id AS "accountId",ev.environment,ev.destination_version AS "destinationVersion",ev.verification_reference AS "verificationReference",ev.created_at AS "createdAt",ev.observed_at AS "observedAt",ev.bank_observed_at AS "bankObservedAt" FROM ${receivingVerificationEvidence} ev WHERE ev.site_id=${scope.siteId} AND ev.account_id=${scope.accountId} AND ev.environment=${scope.environment} AND ev.destination_version=${scope.destinationVersion} ORDER BY ev.created_at DESC,ev.id DESC LIMIT 2 FOR SHARE OF ev`,
  );
  const e = evidence.rows[0];
  if (
    evidence.rows.length < 1 ||
    evidence.rows.length > 2 ||
    e.siteId !== scope.siteId ||
    e.accountId !== scope.accountId ||
    e.environment !== scope.environment ||
    e.destinationVersion !== scope.destinationVersion ||
    (evidence.rows[1] &&
      compareDatabaseTimestamps(
        storedTime(evidence.rows[1].createdAt),
        storedTime(e.createdAt),
      ) >= 0)
  )
    return fail("DESTINATION_UNVERIFIED", 409);
  let at = await authority.clock();
  const loaded = await loadReceivingContextInTransaction(tx, scope.siteId, {
    ...options,
    now: () => new Date(at.getTime()),
  });
  if (
    !loaded ||
    loaded.isDemo !== authority.isDemo ||
    loaded.providerBinding?.provider !== "ASAAS" ||
    loaded.providerBinding.accountReference !== scope.accountReference ||
    loaded.providerBinding.recipientReference !== consent.recipientReference ||
    loaded.providerBinding.bankReference !== scope.bankReference ||
    loaded.providerBinding.destinationVersion !== scope.destinationVersion
  )
    return fail("DESTINATION_UNVERIFIED", 409);
  const readiness = evaluateReceivingReadiness({
    ...loaded,
    siteId: scope.siteId,
    now: new Date(at.getTime()),
  });
  if (
    readiness.state !== "READY" ||
    loaded.evidence?.verification !== "verified"
  )
    return fail("DESTINATION_UNVERIFIED", 409);
  const context: WithdrawalReservationContext = {
    siteId: scope.siteId,
    isDemo: authority.isDemo,
    mode: scope.environment,
    verification: "verified",
    accountId: scope.accountId,
    bankReference: scope.bankReference,
    recipientBinding: {
      siteId: scope.siteId,
      operatorUserId: authority.actor.userId,
      environment: scope.environment,
      accountReference: scope.accountReference,
      recipientReference: consent.recipientReference,
      destinationVersion: scope.destinationVersion,
    },
    readiness,
  };
  const raw = await loader(tx, scope);
  at = await authority.clock();
  const presentation = captureWithdrawalPresentation(
    raw,
    scope,
    context,
    authority.actor.userId,
    Number(databaseTimestampEpochMicroseconds(at) / 1000n),
    options.freshnessMs,
    options.applicationEnvironment,
  );
  if (presentation.provenance !== loaded.evidence.provenance)
    return fail("DESTINATION_UNVERIFIED", 409);
  if (
    presentation.destinationId !== d.id ||
    presentation.evidenceId !== e.id ||
    presentation.verificationReference !== e.verificationReference ||
    databaseTimestampEpochMicroseconds(presentation.evidenceObservedAt) !==
      databaseTimestampEpochMicroseconds(storedTime(e.observedAt)) ||
    databaseTimestampEpochMicroseconds(presentation.bankObservedAt) !==
      databaseTimestampEpochMicroseconds(storedTime(e.bankObservedAt)) ||
    presentation.operatorDisplayName !== authority.user.operatorDisplayName ||
    databaseTimestampEpochMicroseconds(
      presentation.operatorProfileUpdatedAt,
    ) !==
      databaseTimestampEpochMicroseconds(
        storedTime(authority.user.operatorProfileUpdatedAt),
      )
  )
    return fail("DESTINATION_UNVERIFIED", 409);
  if (
    presentation.destinationId !== consent.presentation.destinationId ||
    presentation.maskedDestination !== consent.preview.maskedDestination ||
    presentation.operatorDisplayName !== consent.preview.operatorDisplayName ||
    presentation.operatorProfileUpdatedAt !==
      consent.presentation.operatorProfileUpdatedAt
  )
    return fail("REQUEST_CONFLICT", 409);
  const nowMicros = databaseTimestampEpochMicroseconds(at),
    freshness = BigInt(options.freshnessMs) * 1000n;
  for (const value of [a.observedAt, e.observedAt, e.bankObservedAt]) {
    const observed = databaseTimestampEpochMicroseconds(storedTime(value));
    if (observed > nowMicros || nowMicros - observed > freshness)
      return fail("DESTINATION_UNVERIFIED", 409);
  }
  if (
    databaseTimestampEpochMicroseconds(storedTime(e.createdAt)) > nowMicros ||
    nowMicros >= BigInt(Date.parse(consent.preview.expiresAt)) * 1000n ||
    nowMicros - BigInt(Date.parse(consent.feeQuote.observedAt)) * 1000n >
      freshness
  )
    return fail("FEE_QUOTE_UNAVAILABLE", 409);
  return presentation;
}

async function allAssociations(
  reader: Reader,
  actor: FinancialActor,
  environment: string,
  at: Date,
): Promise<Association[]> {
  const rows = await reader.execute(
    sql`SELECT r.id,r.site_id AS "siteId",r.account_id AS "accountId",r.environment,r.operator_user_id AS "operatorUserId",r.destination_version AS "destinationVersion",r.request_id AS "requestId",r.preview_snapshot AS "previewSnapshot",r.preview_hash AS "previewHash",r.expires_at AS "expiresAt",r.state,r.request_revision::text AS "requestRevision",r.withdrawal_intent_id AS "withdrawalIntentId",r.sealed_at AS "sealedAt",r.created_at AS "createdAt",r.updated_at AS "updatedAt" FROM ${withdrawalRequest} r WHERE r.site_id=${actor.siteId} AND r.environment=${environment} AND r.operator_user_id=${actor.userId} ORDER BY r.request_id`,
  );
  const found = new Set<string>();
  return rows.rows.map((value) => {
    const row = record(value),
      requestId = id(row.requestId);
    if (found.has(requestId)) return fail();
    found.add(requestId);
    const result = validateAssociation(row, actor.siteId, requestId, at);
    if (
      result.consent.snapshot.operatorUserId !== actor.userId ||
      result.consent.snapshot.scope.environment !== environment
    )
      return fail();
    return result;
  });
}
async function allNative(
  reader: Reader,
  actor: FinancialActor,
  environment: string,
  at: Date,
): Promise<Map<string, WithdrawalReservationRecord>> {
  const [intents, operations] = await Promise.all([
    reader.execute(
      sql`SELECT w.id,w.site_id AS "siteId",w.account_id AS "accountId",w.environment,w.operator_user_id AS "operatorUserId",w.destination_version AS "destinationVersion",w.request_id AS "requestId",w.request_hash AS "requestHash",w.authorization_reference AS "authorizationReference",w.policy_version AS "policyVersion",w.amount_cents AS "amountCents",w.fee_cents AS "feeCents",w.net_cents AS "netCents",w.currency,w.state,w.reservation_state AS "reservationState",w.reserved_cents AS "reservedCents",w.provider_reference AS "providerReference",w.receipt_reference AS "receiptReference",w.resolution_observed_at AS "resolutionObservedAt",w.created_at AS "createdAt",w.updated_at AS "updatedAt",a.provider AS "accountProvider",a.operator_user_id AS "accountOperatorUserId" FROM ${withdrawalIntent} w INNER JOIN ${receivingAccount} a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment WHERE w.site_id=${actor.siteId} AND w.environment=${environment} AND w.operator_user_id=${actor.userId} ORDER BY w.request_id`,
    ),
    reader.execute(
      sql`SELECT op.id,op.site_id AS "siteId",op.account_id AS "accountId",op.environment,op.kind,op.state,op.request_id AS "requestId",op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",op.withdrawal_intent_id AS "withdrawalIntentId",op.order_id AS "orderId",op.payment_id AS "paymentId",op.provider_operation_reference AS "providerOperationReference",op.attempts,op.next_attempt_at AS "nextAttemptAt",op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",op.last_error_code AS "lastErrorCode",op.created_at AS "createdAt",op.updated_at AS "updatedAt" FROM ${financialOperation} op INNER JOIN ${receivingAccount} a ON a.id=op.account_id AND a.site_id=op.site_id AND a.environment=op.environment WHERE op.site_id=${actor.siteId} AND op.environment=${environment} AND a.operator_user_id=${actor.userId} AND op.kind='WITHDRAWAL' ORDER BY op.request_id`,
    ),
  ]);
  const result = new Map<string, WithdrawalReservationRecord>(),
    used = new Set<string>();
  for (const value of intents.rows) {
    const row = record(value),
      requestId = id(row.requestId);
    if (
      result.has(requestId) ||
      row.environment !== environment ||
      row.operatorUserId !== actor.userId
    )
      return fail();
    const matched = operations.rows.filter(
      (op) => op.withdrawalIntentId === row.id,
    );
    if (matched.length !== 1) return fail();
    used.add(String(matched[0].id));
    result.set(
      requestId,
      validateNative(row, record(matched[0]), actor.siteId, requestId, at),
    );
  }
  if (used.size !== operations.rows.length) return fail();
  return result;
}
async function unresolvedScope(
  reader: Reader,
  actor: FinancialActor,
  environment: string,
): Promise<number> {
  const result = await reader.execute(sql`SELECT (
    (SELECT COUNT(*) FROM ${financialEventInbox} ev INNER JOIN ${receivingAccount} a ON a.id=ev.account_id AND a.site_id=ev.site_id AND a.environment=ev.environment WHERE ev.site_id=${actor.siteId} AND ev.environment=${environment} AND a.operator_user_id=${actor.userId} AND ev.authenticated_at IS NOT NULL AND ev.state<>'PROCESSED' AND ev.event_type ~ '^(PAYMENT|CHECKOUT|TRANSFER|REFUND)_') +
    (SELECT COUNT(*) FROM ${financialOperation} op INNER JOIN ${receivingAccount} a ON a.id=op.account_id AND a.site_id=op.site_id AND a.environment=op.environment WHERE op.site_id=${actor.siteId} AND op.environment=${environment} AND a.operator_user_id=${actor.userId} AND op.state='UNKNOWN') +
    (SELECT COUNT(*) FROM ${withdrawalIntent} w INNER JOIN ${receivingAccount} a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment WHERE w.site_id=${actor.siteId} AND w.environment=${environment} AND w.operator_user_id=${actor.userId} AND a.operator_user_id=${actor.userId} AND w.state='UNKNOWN') +
    (SELECT COUNT(*) FROM ${giftPaymentRecord} p INNER JOIN ${receivingAccount} a ON a.id=p.account_id AND a.site_id=p.site_id AND a.environment=p.environment WHERE p.site_id=${actor.siteId} AND p.environment=${environment} AND a.operator_user_id=${actor.userId} AND (p.provider_status IS NULL OR p.verification_status<>'VERIFIED' OR p.provider_status NOT IN ('PENDING','AUTHORIZED','CONFIRMED','RECEIVED','OVERDUE')))
  )::text AS "scopeUnresolvedCount"`);
  if (result.rows.length !== 1) return fail();
  return safeCount(result.rows[0].scopeUnresolvedCount);
}
function sqlInstant(at: Date): string {
  return at
    .toISOString()
    .replace(
      /\.\d{3}Z$/,
      `.${String(databaseTimestampEpochMicroseconds(at) % 1_000_000n).padStart(6, "0")}Z`,
    );
}

async function readCurrentPresentation(
  tx: ReceivingTransaction,
  authority: Authority,
  options: EnabledOptions,
): Promise<WithdrawalRequestContext["reason"]> {
  const accounts = await tx.execute(
    sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.observed_at AS "observedAt",a.is_current AS "isCurrent" FROM ${receivingAccount} a WHERE a.site_id=${authority.actor.siteId} AND a.environment=${options.mode} AND a.is_current=true LIMIT 2`,
  );
  if (accounts.rows.length === 0) return "NOT_CONFIGURED";
  if (accounts.rows.length !== 1) return fail();
  const a = record(accounts.rows[0]);
  if (
    a.siteId !== authority.actor.siteId ||
    a.environment !== options.mode ||
    a.provider !== "ASAAS" ||
    a.isCurrent !== true
  )
    return fail();
  if (a.operatorUserId !== authority.actor.userId) return "RECIPIENT_REQUIRED";
  const destinations = await tx.execute(
    sql`SELECT d.id,d.site_id AS "siteId",d.account_id AS "accountId",d.environment,d.version,d.bank_reference AS "bankReference",d.bank_state AS "bankState",d.is_current AS "isCurrent" FROM ${receivingDestination} d WHERE d.site_id=${authority.actor.siteId} AND d.account_id=${a.id} AND d.environment=${options.mode} AND d.is_current=true LIMIT 2`,
  );
  if (destinations.rows.length === 0) return "DESTINATION_UNAVAILABLE";
  if (destinations.rows.length !== 1) return fail();
  const d = record(destinations.rows[0]);
  if (
    d.siteId !== authority.actor.siteId ||
    d.accountId !== a.id ||
    d.environment !== options.mode ||
    d.isCurrent !== true ||
    !Number.isSafeInteger(d.version) ||
    Number(d.version) < 1
  )
    return fail();
  if (d.bankState !== "VERIFIED") return "DESTINATION_UNAVAILABLE";
  const scope: WithdrawalPresentationScope = {
    siteId: authority.actor.siteId,
    accountId: id(a.id),
    accountReference: nullableReference(a.accountReference) ?? fail(),
    environment: options.mode,
    bankReference: nullableReference(d.bankReference) ?? fail(),
    destinationVersion: Number(d.version),
  };
  const evidence = await tx.execute(
    sql`SELECT ev.id,ev.site_id AS "siteId",ev.account_id AS "accountId",ev.environment,ev.destination_version AS "destinationVersion",ev.verification_reference AS "verificationReference",ev.created_at AS "createdAt",ev.observed_at AS "observedAt",ev.bank_observed_at AS "bankObservedAt" FROM ${receivingVerificationEvidence} ev WHERE ev.site_id=${scope.siteId} AND ev.account_id=${scope.accountId} AND ev.environment=${scope.environment} AND ev.destination_version=${scope.destinationVersion} ORDER BY ev.created_at DESC,ev.id DESC LIMIT 2`,
  );
  if (evidence.rows.length === 0) return "DESTINATION_UNAVAILABLE";
  const e = record(evidence.rows[0]);
  if (
    evidence.rows.length > 2 ||
    e.siteId !== scope.siteId ||
    e.accountId !== scope.accountId ||
    e.environment !== scope.environment ||
    e.destinationVersion !== scope.destinationVersion ||
    (evidence.rows[1] &&
      compareDatabaseTimestamps(
        storedTime(evidence.rows[1].createdAt),
        storedTime(e.createdAt),
      ) >= 0)
  )
    return fail();
  let at = await authority.clock();
  const loaded = await loadReceivingContextInTransaction(tx, scope.siteId, {
    mode: options.mode,
    applicationEnvironment: options.applicationEnvironment,
    freshnessMs: options.freshnessMs,
    now: () => new Date(at.getTime()),
  });
  if (
    !loaded ||
    loaded.isDemo !== authority.isDemo ||
    loaded.providerBinding?.provider !== "ASAAS" ||
    loaded.providerBinding.accountReference !== scope.accountReference ||
    loaded.providerBinding.recipientReference !== a.recipientReference ||
    loaded.providerBinding.bankReference !== scope.bankReference ||
    loaded.providerBinding.destinationVersion !== scope.destinationVersion ||
    evaluateReceivingReadiness({
      ...loaded,
      siteId: scope.siteId,
      now: new Date(at.getTime()),
    }).state !== "READY" ||
    loaded.evidence?.verification !== "verified"
  )
    return "DESTINATION_UNAVAILABLE";
  if (!options.loadVerifiedPresentationInTransaction)
    return "DESTINATION_UNAVAILABLE";
  // This read has no price, proof or financial command. The same stored loader
  // receives the six-field presentation scope and cannot invent monetary terms.
  const raw = await options.loadVerifiedPresentationInTransaction(
    tx,
    Object.freeze(scope),
  );
  at = await authority.clock();
  if (raw === null) return "DESTINATION_UNAVAILABLE";
  const p = record(raw),
    keys = [
      ...Object.keys(scope),
      "source",
      "verification",
      "provenance",
      "operatorUserId",
      "recipientReference",
      "destinationId",
      "evidenceId",
      "verificationReference",
      "evidenceObservedAt",
      "bankObservedAt",
      "operatorProfileUpdatedAt",
      "maskedDestination",
      "operatorDisplayName",
    ];
  if (p.provenance !== loaded.evidence.provenance) return fail();
  if (
    Reflect.ownKeys(p).length !== keys.length ||
    Reflect.ownKeys(p).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    Object.entries(scope).some(([key, value]) => p[key] !== value) ||
    p.source !== "stored" ||
    p.verification !== "verified" ||
    (p.provenance !== "provider" && p.provenance !== "simulation") ||
    (p.provenance === "simulation" &&
      (options.mode !== "sandbox" ||
        !authority.isDemo ||
        options.applicationEnvironment === "production")) ||
    p.operatorUserId !== authority.actor.userId ||
    p.recipientReference !== a.recipientReference ||
    p.destinationId !== d.id ||
    p.evidenceId !== e.id ||
    p.verificationReference !== e.verificationReference ||
    p.operatorDisplayName !== authority.user.operatorDisplayName
  )
    return fail();
  const mask = p.maskedDestination,
    name = p.operatorDisplayName;
  if (
    !withdrawalPreviewSchema.shape.maskedDestination.safeParse(mask).success ||
    !withdrawalPreviewSchema.shape.operatorDisplayName.safeParse(name).success
  )
    return fail();
  for (const key of [
    "evidenceObservedAt",
    "bankObservedAt",
    "operatorProfileUpdatedAt",
  ]) {
    if (!(p[key] instanceof Date)) return fail();
    clockTime(p[key]);
  }
  if (
    databaseTimestampEpochMicroseconds(p.evidenceObservedAt) !==
      databaseTimestampEpochMicroseconds(storedTime(e.observedAt)) ||
    databaseTimestampEpochMicroseconds(p.bankObservedAt) !==
      databaseTimestampEpochMicroseconds(storedTime(e.bankObservedAt)) ||
    databaseTimestampEpochMicroseconds(p.operatorProfileUpdatedAt) !==
      databaseTimestampEpochMicroseconds(
        storedTime(authority.user.operatorProfileUpdatedAt),
      )
  )
    return fail();
  const current = databaseTimestampEpochMicroseconds(at),
    freshness = BigInt(options.freshnessMs) * 1000n;
  for (const value of [a.observedAt, e.observedAt, e.bankObservedAt]) {
    const observed = databaseTimestampEpochMicroseconds(storedTime(value));
    if (observed > current || current - observed > freshness)
      return "DESTINATION_UNAVAILABLE";
  }
  if (
    compareDatabaseTimestamps(storedTime(e.createdAt), at) > 0 ||
    compareDatabaseTimestamps(
      storedTime(authority.user.operatorProfileUpdatedAt),
      at,
    ) > 0
  )
    return "DESTINATION_UNAVAILABLE";
  return null;
}

export function createWithdrawalReservationRepository(
  db: WithdrawalReservationDatabase,
  options: WithdrawalReservationRepositoryOptions,
): WithdrawalReservationRepository {
  try {
    if (options.mode === "disabled")
      return {
        async findByRequest() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async reserveWithdrawal() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async readRequest() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async readContext() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async findConsent() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async issuePreview() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async recoverWithdrawal() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async sealUncreatedRequest() {
          return fail("PROVIDER_MODE_UNAVAILABLE", 409);
        },
      };
    const { mode, applicationEnvironment, maxAuthAgeMs, freshnessMs } = options;
    if (
      !["sandbox", "live"].includes(mode) ||
      !["test", "development", "production"].includes(applicationEnvironment) ||
      [maxAuthAgeMs, freshnessMs].some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 300_000,
      ) ||
      typeof options.now !== "function" ||
      typeof db?.execute !== "function" ||
      typeof db?.transaction !== "function"
    )
      return fail();
    if (mode === "live" && applicationEnvironment !== "production")
      return fail("PROVIDER_MODE_UNAVAILABLE", 409);
    const now = options.now.bind(options);
    const loadPresentation =
      options.loadVerifiedPresentationInTransaction?.bind(options);
    const requestOptions: EnabledOptions = Object.freeze({
      mode,
      applicationEnvironment,
      maxAuthAgeMs,
      freshnessMs,
      now,
      loadVerifiedPresentationInTransaction: loadPresentation,
    });
    async function read<T>(
      attempt: WithdrawalReadAttempt,
      callback: (tx: ReceivingTransaction, authority: Authority) => Promise<T>,
    ): Promise<T> {
      try {
        clockTime(now());
        return await db.transaction(
          async (tx) => {
            const authority = await requestAuthority(
              tx as ReceivingTransaction,
              attempt,
              requestOptions,
              false,
            );
            const result = await callback(
              tx as ReceivingTransaction,
              authority,
            );
            await authority.clock();
            return result;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        return safeError(error);
      }
    }
    return {
      async readRequest(attempt) {
        const requestId = id(attempt.requestId);
        return read(attempt, async (tx, authority) => {
          const pair = await requestPair(tx, authority, requestId, mode);
          const revision = await scopeRevision(
            tx,
            authority.actor.siteId,
            mode,
          );
          return projection(
            authority.actor.siteId,
            requestId,
            mode,
            revision,
            authority.observedAt,
            pair.association,
            pair.native,
          );
        });
      },
      async findConsent(attempt) {
        const requestId = id(attempt.requestId);
        return read(attempt, async (tx, authority) => {
          const pair = await requestPair(tx, authority, requestId, mode);
          return pair.association?.consent ?? null;
        });
      },
      async readContext(attempt) {
        try {
          const cursor = attempt.cursor;
          if (
            cursor !== undefined &&
            !/^wc1:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cursor)
          )
            return fail("WITHDRAWAL_INVALID", 400);
          return await read(attempt, async (tx, authority) => {
            // Both complete fact batches and the whole-scope counters precede
            // pagination. An empty page cannot erase an outstanding obligation.
            const [associations, native, revision, unresolved] =
              await Promise.all([
                allAssociations(
                  tx,
                  authority.actor,
                  mode,
                  authority.observedAt,
                ),
                allNative(tx, authority.actor, mode, authority.observedAt),
                scopeRevision(tx, authority.actor.siteId, mode),
                unresolvedScope(tx, authority.actor, mode),
              ]);
            const associated = new Map(
              associations.map((value) => [String(value.row.requestId), value]),
            );
            const requests = [
              ...new Set([...associated.keys(), ...native.keys()]),
            ]
              .sort()
              .map((requestId) =>
                projection(
                  authority.actor.siteId,
                  requestId,
                  mode,
                  revision,
                  authority.observedAt,
                  associated.get(requestId) ?? null,
                  native.get(requestId) ?? null,
                ),
              );
            const open = requests.filter((request) => request.state === "OPEN");
            if (open.length > 1) return fail();
            const blocked =
              unresolved !== 0 ||
              requests.some(
                (request) =>
                  request.state === "UNRESOLVED" ||
                  (request.state === "EXISTING" &&
                    request.withdrawal.state === "UNKNOWN"),
              );
            let reason: WithdrawalRequestContext["reason"] = open.length
              ? "OPEN_REQUEST"
              : blocked
                ? "UNRESOLVED_OPERATION"
                : "DESTINATION_UNAVAILABLE";
            if (!open.length && !blocked) {
              reason = await readCurrentPresentation(
                tx,
                authority,
                requestOptions,
              );
            }
            const remaining = requests.filter(
              (request) =>
                request.state !== "OPEN" &&
                (cursor === undefined || request.requestId > cursor.slice(4)),
            );
            const page = remaining.slice(0, 100);
            return withdrawalRequestContextSchema.parse({
              siteId: authority.actor.siteId,
              mode,
              scopeRevision: revision,
              observedAt: authority.observedAt.toISOString(),
              observationOrder: {
                scopeRevision: revision,
                requestRevision: null,
                recordUpdatedAtMicroseconds: null,
              },
              newRequestAllowed: reason === null,
              reason,
              openRequest: open[0] ?? null,
              recoverableRequests: page,
              nextCursor:
                remaining.length > page.length
                  ? `wc1:${page[page.length - 1].requestId}`
                  : null,
            });
          });
        } catch (error) {
          return safeError(error);
        }
      },
      async issuePreview(value, expectedRevision, attempt) {
        try {
          const consent = readWithdrawalConsentSnapshot(value);
          if (
            typeof expectedRevision !== "string" ||
            !/^(0|[1-9]\d*)$/.test(expectedRevision)
          )
            return fail("WITHDRAWAL_INVALID", 400);
          const requestId = consent.preview.requestId;
          return await db.transaction(async (tx) => {
            const authority = await requestAuthority(
              tx as ReceivingTransaction,
              attempt,
              requestOptions,
              true,
              requestId,
            );
            if (
              consent.operatorUserId !== authority.actor.userId ||
              consent.preview.siteId !== authority.actor.siteId ||
              consent.preview.mode !== mode
            )
              return fail("REQUEST_CONFLICT", 409);
            const pair = await requestPair(
              tx,
              authority,
              requestId,
              mode,
              true,
            );
            let revision = await scopeRevision(
              tx,
              authority.actor.siteId,
              mode,
            );
            if (pair.association || pair.native) {
              const original =
                pair.association?.consent.snapshot.preview.amountCents ??
                pair.native?.intent.amountCents;
              if (original !== consent.preview.amountCents)
                return fail("REQUEST_CONFLICT", 409);
              return projection(
                authority.actor.siteId,
                requestId,
                mode,
                revision,
                await authority.clock(),
                pair.association,
                pair.native,
              );
            }
            if (revision !== expectedRevision)
              return fail("REQUEST_CONFLICT", 409);
            const existing = await allAssociations(
              tx,
              authority.actor,
              mode,
              await authority.clock(),
            );
            const native = await allNative(
              tx,
              authority.actor,
              mode,
              await authority.clock(),
            );
            if (
              existing.some((row) => row.consent.state === "OPEN") ||
              [...native.values()].some(
                (row) => row.intent.state === "UNKNOWN",
              ) ||
              (await unresolvedScope(tx, authority.actor, mode)) !== 0
            )
              return fail("FINANCIAL_EVENTS_UNRESOLVED", 409);
            if (!loadPresentation) return fail("DESTINATION_UNVERIFIED", 409);
            await currentPresentation(
              tx as ReceivingTransaction,
              authority,
              consent,
              requestOptions,
              loadPresentation,
            );
            const expiry = new Date(consent.preview.expiresAt);
            const created = await authority.clock();
            if (compareDatabaseTimestamps(expiry, created) <= 0)
              return fail("FEE_QUOTE_UNAVAILABLE", 409);
            const rowId = `wr1_${createHash("sha256")
              .update(
                JSON.stringify([authority.actor.siteId, requestId]),
                "utf8",
              )
              .digest("base64url")}`;
            const inserted = await tx.execute(
              sql`INSERT INTO ${withdrawalRequest} (id,site_id,account_id,environment,operator_user_id,destination_version,request_id,preview_snapshot,preview_hash,expires_at,state,request_revision,withdrawal_intent_id,sealed_at,created_at,updated_at) VALUES (${rowId},${authority.actor.siteId},${consent.scope.accountId},${mode},${authority.actor.userId},${consent.scope.destinationVersion},${requestId},${JSON.stringify(consent)}::jsonb,${hashWithdrawalConsentSnapshot(consent)},${consent.preview.expiresAt},'OPEN',1,NULL,NULL,${sqlInstant(created)}::timestamptz,${sqlInstant(created)}::timestamptz) RETURNING id`,
            );
            if (inserted.rows.length !== 1 || inserted.rows[0].id !== rowId)
              return fail();
            const at = await authority.clock();
            if (compareDatabaseTimestamps(expiry, at) <= 0)
              return fail("FEE_QUOTE_UNAVAILABLE", 409);
            const saved = await findAssociation(
              tx,
              authority.actor.siteId,
              requestId,
              at,
              true,
            );
            if (!saved || !isDeepStrictEqual(saved.consent.snapshot, consent))
              return fail();
            revision = await scopeRevision(tx, authority.actor.siteId, mode);
            return projection(
              authority.actor.siteId,
              requestId,
              mode,
              revision,
              await authority.clock(),
              saved,
              null,
            );
          });
        } catch (error) {
          return safeError(error);
        }
      },
      async recoverWithdrawal(attempt) {
        try {
          const requestId = id(attempt.requestId);
          return await db.transaction(async (tx) => {
            const authority = await requestAuthority(
              tx as ReceivingTransaction,
              attempt,
              requestOptions,
              true,
              requestId,
              attempt.recentAuth ?? null,
            );
            const pair = await requestPair(
              tx,
              authority,
              requestId,
              mode,
              true,
            );
            await authority.clock();
            return pair.native;
          });
        } catch (error) {
          return safeError(error);
        }
      },
      async sealUncreatedRequest(attempt) {
        try {
          const requestId = id(attempt.requestId);
          return await db.transaction(async (tx) => {
            const authority = await requestAuthority(
              tx as ReceivingTransaction,
              attempt,
              requestOptions,
              true,
              requestId,
              attempt.recentAuth ?? null,
            );
            let pair = await requestPair(tx, authority, requestId, mode, true);
            let revision = await scopeRevision(
              tx,
              authority.actor.siteId,
              mode,
            );
            if (
              pair.native ||
              !pair.association ||
              pair.association.consent.state === "SEALED_NOT_CREATED"
            )
              return projection(
                authority.actor.siteId,
                requestId,
                mode,
                revision,
                await authority.clock(),
                pair.association,
                pair.native,
              );
            if (pair.association.consent.state !== "OPEN") return fail();
            await noNativeOperation(
              tx,
              authority.actor.siteId,
              requestId,
              true,
            );
            const at = await authority.clock();
            const changed = await tx.execute(
              sql`UPDATE ${withdrawalRequest} r SET state='SEALED_NOT_CREATED',request_revision=2,sealed_at=${sqlInstant(at)}::timestamptz,updated_at=${sqlInstant(at)}::timestamptz WHERE r.id=${pair.association.row.id} AND r.site_id=${authority.actor.siteId} AND r.request_id=${requestId} AND r.operator_user_id=${authority.actor.userId} AND r.environment=${mode} AND r.preview_hash=${pair.association.consent.previewHash} AND r.state='OPEN' AND r.request_revision=1 AND r.withdrawal_intent_id IS NULL AND r.sealed_at IS NULL RETURNING r.id`,
            );
            if (
              changed.rows.length !== 1 ||
              changed.rows[0].id !== pair.association.row.id
            )
              return fail("REQUEST_CONFLICT", 409);
            const final = await authority.clock();
            pair = {
              association: await findAssociation(
                tx,
                authority.actor.siteId,
                requestId,
                final,
                true,
              ),
              native: null,
            };
            revision = await scopeRevision(tx, authority.actor.siteId, mode);
            return projection(
              authority.actor.siteId,
              requestId,
              mode,
              revision,
              await authority.clock(),
              pair.association,
              null,
            );
          });
        } catch (error) {
          return safeError(error);
        }
      },
      async findByRequest(siteId, requestId) {
        try {
          siteIdSchema.parse(siteId);
          id(requestId);
          clockTime(now());
          const clocks = await db.execute(
            sql`SELECT clock_timestamp() AS "currentTime"`,
          );
          if (clocks.rows.length !== 1) return fail();
          const databaseNow = storedTime(clocks.rows[0].currentTime);
          const found = await find(db, siteId, requestId, databaseNow);
          clockTime(now());
          return found;
        } catch (error) {
          return safeError(error);
        }
      },
      async reserveWithdrawal(
        value,
        authorize,
        currentAuthorization,
        confirmation,
      ) {
        try {
          const candidate = readWithdrawalReservationSnapshot(value);
          if (candidate.environment !== mode)
            return fail("PROVIDER_MODE_UNAVAILABLE", 409);
          if (typeof authorize !== "function") return fail();
          const incoming = record(currentAuthorization);
          const rawActor = record(incoming.actor);
          const actor: FinancialActor = Object.freeze({
            userId: id(rawActor.userId),
            siteId: siteIdSchema.parse(rawActor.siteId),
            sessionId: id(rawActor.sessionId),
          });
          const rawProof = record(incoming.recentAuth);
          if (
            actor.userId !== candidate.operatorUserId ||
            actor.siteId !== candidate.intent.siteId ||
            rawProof.userId !== actor.userId ||
            rawProof.siteId !== actor.siteId ||
            rawProof.sessionId !== actor.sessionId ||
            rawProof.verification !== "verified" ||
            rawProof.provenance !== "backend" ||
            (rawProof.proofKind !== "PASSWORD_REAUTHENTICATION" &&
              rawProof.proofKind !== "MFA_REAUTHENTICATION")
          )
            return fail("RECENT_AUTH_REQUIRED", 403);
          const authenticatedAt = clockTime(rawProof.authenticatedAt);
          const proofExpiry = clockTime(rawProof.expiresAt);
          if (
            proofExpiry <= authenticatedAt ||
            proofExpiry - authenticatedAt > BigInt(maxAuthAgeMs) * 1000n
          )
            return fail("RECENT_AUTH_REQUIRED", 403);
          const proof: RecentFinancialAuthenticationEvidence = Object.freeze({
            ...actor,
            proofKind: rawProof.proofKind,
            verification: "verified",
            provenance: "backend",
            authenticatedAt: new Date(Number(authenticatedAt / 1000n)),
            expiresAt: new Date(Number(proofExpiry / 1000n)),
          });
          let lastLocal = -1n;
          let sessionTimes: {
            expiry: bigint;
            lastActive: bigint;
            created: bigint;
          } | null = null;
          const requireTime = (at: bigint) => {
            if (
              authenticatedAt > at ||
              at - authenticatedAt > BigInt(maxAuthAgeMs) * 1000n ||
              proofExpiry <= at
            )
              fail("RECENT_AUTH_REQUIRED", 403);
            if (
              sessionTimes &&
              (sessionTimes.expiry <= at ||
                sessionTimes.created > at ||
                sessionTimes.lastActive > at ||
                at - sessionTimes.lastActive >=
                  BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
                at - sessionTimes.created >=
                  BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n)
            )
              fail("MEMBERSHIP_DENIED", 403);
          };
          const localCheck = () => {
            const at = clockTime(now());
            if (at < lastLocal) fail();
            lastLocal = at;
            requireTime(at);
          };
          localCheck();
          const result = await db.transaction(async (tx) => {
            const execute = async (statement: SQL) => {
              localCheck();
              const rows = await tx.execute(statement);
              localCheck();
              return rows;
            };
            let lastDatabase: Date | null = null;
            const databaseClock = async () => {
              const clocks = await execute(
                sql`SELECT clock_timestamp() AS "currentTime"`,
              );
              if (clocks.rows.length !== 1) return fail();
              const at = storedTime(clocks.rows[0].currentTime);
              if (
                lastDatabase &&
                compareDatabaseTimestamps(at, lastDatabase) < 0
              )
                return fail();
              lastDatabase = at;
              requireTime(databaseTimestampEpochMicroseconds(at));
              return at;
            };
            await execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["withdrawal-reservation", candidate.intent.siteId, candidate.requestId])},0))`,
            );
            const sites = await execute(
              sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${actor.siteId} FOR UPDATE OF st`,
            );
            if (
              sites.rows.length !== 1 ||
              sites.rows[0].siteId !== actor.siteId ||
              typeof sites.rows[0].isDemo !== "boolean"
            )
              return fail();
            const isDemo = sites.rows[0].isDemo;
            if (mode === "live" && isDemo)
              return fail("PROVIDER_MODE_UNAVAILABLE", 409);
            let databaseNow = await databaseClock();
            // Revocation locks user before deleting sessions. Acquire explicitly.
            const users = await execute(
              sql`SELECT u.id AS "userId",u.role,u.state,u.name AS "operatorDisplayName",u.updated_at AS "operatorProfileUpdatedAt" FROM ${user} u WHERE u.id=${actor.userId} AND u.state='ACTIVE' FOR SHARE OF u`,
            );
            if (
              users.rows.length !== 1 ||
              users.rows[0].userId !== actor.userId ||
              users.rows[0].state !== "ACTIVE" ||
              !["SITE_ADMIN", "SITE_ASSISTANT"].includes(
                users.rows[0].role as string,
              )
            )
              return fail("MEMBERSHIP_DENIED", 403);
            const platformRole = users.rows[0].role as
              | "SITE_ADMIN"
              | "SITE_ASSISTANT";
            const sessions = await execute(
              sql`SELECT se.user_id AS "userId",se.id AS "sessionId",se.expires_at AS "sessionExpiresAt",se.last_active_at AS "lastActiveAt",se.created_at AS "sessionCreatedAt" FROM ${session} se WHERE se.id=${actor.sessionId} AND se.user_id=${actor.userId} FOR SHARE OF se`,
            );
            if (
              sessions.rows.length !== 1 ||
              sessions.rows[0].userId !== actor.userId ||
              sessions.rows[0].sessionId !== actor.sessionId
            )
              return fail("MEMBERSHIP_DENIED", 403);
            const storedSession = sessions.rows[0];
            sessionTimes = {
              expiry: databaseTimestampEpochMicroseconds(
                storedTime(storedSession.sessionExpiresAt),
              ),
              lastActive: databaseTimestampEpochMicroseconds(
                storedTime(storedSession.lastActiveAt),
              ),
              created: databaseTimestampEpochMicroseconds(
                storedTime(storedSession.sessionCreatedAt),
              ),
            };
            if (
              sessionTimes.created > sessionTimes.lastActive ||
              sessionTimes.created >= sessionTimes.expiry
            )
              return fail("MEMBERSHIP_DENIED", 403);
            localCheck();
            databaseNow = await databaseClock();
            const memberships = await execute(
              sql`SELECT m.id,m.site_id AS "siteId",m.user_id AS "userId",m.role,m.revoked_at AS "revokedAt" FROM ${siteMembership} m WHERE m.site_id=${actor.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR SHARE OF m`,
            );
            if (
              memberships.rows.length !== 1 ||
              memberships.rows[0].siteId !== actor.siteId ||
              memberships.rows[0].userId !== actor.userId ||
              memberships.rows[0].role !== "SITE_ADMIN" ||
              memberships.rows[0].revokedAt !== null
            )
              return fail("MEMBERSHIP_DENIED", 403);
            localCheck();
            const resolved = siteAccessSchema.safeParse(
              await resolveSiteAccess(tx, {
                userId: actor.userId,
                platformRole,
                siteId: actor.siteId,
              }),
            );
            localCheck();
            if (!resolved.success) return fail("MEMBERSHIP_DENIED", 403);
            const access = Object.freeze({
              ...resolved.data,
              capabilities: Object.freeze({ ...resolved.data.capabilities }),
            });
            assertFinancialReadAccess(access, actor.siteId);
            if (
              access.userId !== actor.userId ||
              access.membershipId !== memberships.rows[0].id
            )
              return fail("MEMBERSHIP_DENIED", 403);
            const preliminary = await find(
              tx,
              actor.siteId,
              candidate.requestId,
              databaseNow,
            );
            localCheck();
            if (
              preliminary &&
              preliminary.snapshot.requestHash !== candidate.requestHash
            )
              return fail("REQUEST_CONFLICT", 409);
            const snapshot = preliminary?.snapshot ?? candidate;
            const accounts = await execute(
              sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.operator_reference AS "operatorReference",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.is_current AS "isCurrent",a.observed_at AS "observedAt" FROM ${receivingAccount} a WHERE a.id=${snapshot.accountId} AND a.site_id=${actor.siteId} AND a.environment=${snapshot.environment} AND a.provider='ASAAS' FOR UPDATE OF a`,
            );
            if (accounts.rows.length !== 1) return fail();
            const account = record(accounts.rows[0]);
            if (
              account.id !== snapshot.accountId ||
              account.siteId !== actor.siteId ||
              account.environment !== snapshot.environment ||
              account.provider !== "ASAAS" ||
              account.operatorUserId !== snapshot.operatorUserId ||
              account.operatorUserId !== actor.userId
            )
              return fail("RECIPIENT_REQUIRED", 403);
            const destinations = await execute(
              sql`SELECT d.id,d.site_id AS "siteId",d.account_id AS "accountId",d.environment,d.version,d.bank_reference AS "bankReference",d.bank_state AS "bankState",d.is_current AS "isCurrent" FROM ${receivingDestination} d WHERE d.site_id=${actor.siteId} AND d.account_id=${snapshot.accountId} AND d.environment=${snapshot.environment} AND d.version=${snapshot.intent.destinationVersion} LIMIT 2 FOR SHARE OF d`,
            );
            if (destinations.rows.length !== 1)
              return fail("DESTINATION_UNVERIFIED", 409);
            const destination = record(destinations.rows[0]);
            if (
              destination.siteId !== actor.siteId ||
              destination.accountId !== snapshot.accountId ||
              destination.environment !== snapshot.environment ||
              destination.version !== snapshot.intent.destinationVersion ||
              destination.bankReference !== snapshot.bankReference
            )
              return fail("DESTINATION_UNVERIFIED", 409);
            // Future bank/evidence, refund and completion writers must acquire
            // the same account lock before changing observable financial facts.
            const evidenceRows = preliminary
              ? null
              : await execute(
                  sql`SELECT ev.id,ev.site_id AS "siteId",ev.account_id AS "accountId",ev.environment,ev.destination_version AS "destinationVersion",ev.verification_reference AS "verificationReference",ev.created_at AS "createdAt",ev.observed_at AS "observedAt",ev.bank_observed_at AS "bankObservedAt" FROM ${receivingVerificationEvidence} ev WHERE ev.site_id=${actor.siteId} AND ev.account_id=${snapshot.accountId} AND ev.environment=${snapshot.environment} AND ev.destination_version=${snapshot.intent.destinationVersion} ORDER BY ev.created_at DESC,ev.id DESC LIMIT 2 FOR SHARE OF ev`,
                );
            databaseNow = await databaseClock();
            const association = await findAssociation(
              tx,
              actor.siteId,
              candidate.requestId,
              databaseNow,
              true,
            );
            const previous = await find(
              tx,
              actor.siteId,
              candidate.requestId,
              databaseNow,
              true,
            );
            localCheck();
            if (
              Boolean(previous) !== Boolean(preliminary) ||
              (previous &&
                preliminary &&
                !isDeepStrictEqual(previous.snapshot, preliminary.snapshot))
            )
              return fail();
            if (
              previous &&
              previous.snapshot.requestHash !== candidate.requestHash
            )
              return fail("REQUEST_CONFLICT", 409);
            let context: WithdrawalReservationContext = {
              siteId: actor.siteId,
              isDemo,
              mode,
              verification: "unverified",
              accountId: null,
              bankReference: null,
              recipientBinding: null,
              readiness: null,
            };
            let heldCents: bigint | null = null;
            let unresolvedFinancialEventCount: number | null = null;
            let balanceEffectsAfterObservationCount: number | null = null;
            let requireReceiving = (_at: Date): void => {};
            const requireResolvedOwnScope = async (): Promise<void> => {
              // A NEW hold is denied by uncertainty in any retained account of
              // this operator/site/environment, including UNKNOWN intent state
              // while the corresponding operation still says REQUESTED. Replay
              // and existing-only recovery do not invoke this creation gate.
              const uncertain = await unresolvedScope(tx, actor, mode);
              localCheck();
              databaseNow = await databaseClock();
              if (uncertain !== 0) fail("FINANCIAL_EVENTS_UNRESOLVED", 409);
            };
            const requireConsent = (at: Date) => {
              if (previous) return;
              if (
                !confirmation ||
                !association ||
                association.consent.state !== "OPEN" ||
                association.consent.requestRevision !== "1" ||
                association.consent.snapshot.operatorUserId !== actor.userId ||
                confirmation.requestId !== candidate.requestId ||
                confirmation.previewHash !== association.consent.previewHash ||
                confirmation.requestRevision !== "1" ||
                Object.keys(confirmation).sort().join(",") !==
                  "previewHash,requestId,requestRevision" ||
                compareDatabaseTimestamps(
                  new Date(association.consent.snapshot.preview.expiresAt),
                  at,
                ) <= 0 ||
                !sameWithdrawalConsentTerms(
                  association.consent.snapshot,
                  snapshot,
                  association.consent.snapshot.presentation,
                )
              )
                fail("REQUEST_CONFLICT", 409);
            };
            const freshSnapshot = (at: Date) => {
              const current = databaseTimestampEpochMicroseconds(at);
              const feeAt =
                BigInt(Date.parse(snapshot.feeQuote.observedAt)) * 1000n;
              const feeExpiry =
                BigInt(Date.parse(snapshot.feeQuote.expiresAt)) * 1000n;
              const balanceAt =
                BigInt(Date.parse(snapshot.balance.observedAt)) * 1000n;
              const freshness = BigInt(freshnessMs) * 1000n;
              if (
                current <
                  BigInt(Date.parse(snapshot.intent.createdAt)) * 1000n ||
                current < feeAt ||
                current - feeAt > freshness ||
                feeExpiry <= current ||
                feeExpiry - feeAt > freshness
              )
                fail("FEE_QUOTE_UNAVAILABLE", 409);
              if (current < balanceAt || current - balanceAt > freshness)
                fail("PROVIDER_BALANCE_UNAVAILABLE", 409);
              if (
                snapshot.feeQuote.provenance === "simulation" &&
                (mode !== "sandbox" ||
                  !isDemo ||
                  applicationEnvironment === "production")
              )
                fail("FEE_QUOTE_UNAVAILABLE", 409);
            };
            if (!previous) {
              requireConsent(databaseNow);
              if (!loadPresentation) return fail("DESTINATION_UNVERIFIED", 409);
              if (
                account.isCurrent !== true ||
                account.accountReference !== snapshot.accountReference ||
                account.recipientReference !== snapshot.recipientReference ||
                destination.isCurrent !== true ||
                destination.bankState !== "VERIFIED"
              )
                return fail("DESTINATION_UNVERIFIED", 409);
              freshSnapshot(databaseNow);
              if (
                !evidenceRows ||
                evidenceRows.rows.length < 1 ||
                evidenceRows.rows.length > 2
              )
                throw new ReceivingReadinessServiceError();
              const evidence = evidenceRows.rows.map((value) => record(value));
              for (const row of evidence) {
                id(row.id);
                if (
                  row.siteId !== actor.siteId ||
                  row.accountId !== snapshot.accountId ||
                  row.environment !== mode ||
                  row.destinationVersion !== snapshot.intent.destinationVersion
                )
                  return fail();
              }
              const createdProof = storedTime(evidence[0].createdAt);
              if (
                evidence[1] &&
                compareDatabaseTimestamps(
                  storedTime(evidence[1].createdAt),
                  createdProof,
                ) >= 0
              )
                return fail("DESTINATION_UNVERIFIED", 409);
              const rawObservations = [
                account.observedAt,
                evidence[0].observedAt,
                evidence[0].bankObservedAt,
              ];
              if (rawObservations.some((value) => value === null))
                throw new ReceivingReadinessServiceError();
              const observations = rawObservations.map((value) =>
                databaseTimestampEpochMicroseconds(storedTime(value)),
              );
              const requireReceivingTimes = (at: Date) => {
                const current = databaseTimestampEpochMicroseconds(at);
                if (
                  compareDatabaseTimestamps(createdProof, at) > 0 ||
                  observations.some(
                    (observed) =>
                      observed > current ||
                      current - observed > BigInt(freshnessMs) * 1000n,
                  )
                )
                  fail("DESTINATION_UNVERIFIED", 409);
              };
              requireReceivingTimes(databaseNow);
              const loaded = await loadReceivingContextInTransaction(
                tx as ReceivingTransaction,
                actor.siteId,
                {
                  mode,
                  applicationEnvironment,
                  freshnessMs,
                  now: () => new Date(databaseNow.getTime()),
                },
              );
              localCheck();
              databaseNow = await databaseClock();
              if (
                !loaded ||
                loaded.isDemo !== isDemo ||
                loaded.providerBinding?.provider !== "ASAAS" ||
                loaded.providerBinding.accountReference !==
                  snapshot.accountReference ||
                loaded.providerBinding.recipientReference !==
                  snapshot.recipientReference ||
                loaded.providerBinding.bankReference !==
                  snapshot.bankReference ||
                loaded.providerBinding.destinationVersion !==
                  snapshot.intent.destinationVersion ||
                loaded.providerBinding.operatorReference !==
                  account.operatorReference
              )
                return fail("DESTINATION_UNVERIFIED", 409);
              const readiness = evaluateReceivingReadiness({
                ...loaded,
                siteId: actor.siteId,
                now: new Date(databaseNow.getTime()),
              });
              context = {
                siteId: actor.siteId,
                isDemo,
                mode,
                verification: loaded.evidence?.verification ?? "unverified",
                accountId: snapshot.accountId,
                bankReference: snapshot.bankReference,
                recipientBinding: {
                  siteId: actor.siteId,
                  operatorUserId: actor.userId,
                  environment: mode,
                  accountReference: snapshot.accountReference,
                  recipientReference: snapshot.recipientReference,
                  destinationVersion: snapshot.intent.destinationVersion,
                },
                readiness,
              };
              const scope: WithdrawalFeeScope = {
                siteId: actor.siteId,
                accountId: snapshot.accountId,
                accountReference: snapshot.accountReference,
                environment: mode,
                bankReference: snapshot.bankReference,
                destinationVersion: snapshot.intent.destinationVersion,
                amountCents: snapshot.intent.amountCents,
                currency: "BRL",
              };
              const rawPresentation = await loadPresentation(
                tx as ReceivingTransaction,
                scope,
              );
              databaseNow = await databaseClock();
              const presentation = captureWithdrawalPresentation(
                rawPresentation,
                scope,
                context,
                actor.userId,
                Number(databaseTimestampEpochMicroseconds(databaseNow) / 1000n),
                freshnessMs,
                applicationEnvironment,
              );
              if (presentation.provenance !== loaded.evidence?.provenance)
                return fail("REQUEST_CONFLICT", 409);
              if (
                !association ||
                !sameWithdrawalConsentTerms(
                  association.consent.snapshot,
                  snapshot,
                  presentation,
                ) ||
                presentation.destinationId !== destination.id ||
                presentation.evidenceId !== evidence[0].id ||
                presentation.verificationReference !==
                  evidence[0].verificationReference ||
                databaseTimestampEpochMicroseconds(
                  presentation.evidenceObservedAt,
                ) !==
                  databaseTimestampEpochMicroseconds(
                    storedTime(evidence[0].observedAt),
                  ) ||
                databaseTimestampEpochMicroseconds(
                  presentation.bankObservedAt,
                ) !==
                  databaseTimestampEpochMicroseconds(
                    storedTime(evidence[0].bankObservedAt),
                  ) ||
                presentation.operatorDisplayName !==
                  users.rows[0].operatorDisplayName ||
                databaseTimestampEpochMicroseconds(
                  presentation.operatorProfileUpdatedAt,
                ) !==
                  databaseTimestampEpochMicroseconds(
                    storedTime(users.rows[0].operatorProfileUpdatedAt),
                  )
              )
                return fail("REQUEST_CONFLICT", 409);
              requireConsent(databaseNow);
              if (!context.recipientBinding) return fail();
              const recipientBinding = Object.freeze({
                ...context.recipientBinding,
              });
              requireReceiving = (at: Date) => {
                requireConsent(at);
                requireReceivingTimes(at);
                const currentReadiness = evaluateReceivingReadiness({
                  ...loaded,
                  siteId: actor.siteId,
                  now: new Date(at.getTime()),
                });
                assertRecipientFinancialAction({
                  action: "REQUEST_WITHDRAWAL",
                  siteId: actor.siteId,
                  environment: mode,
                  access,
                  actor,
                  recipientBinding,
                  recentAuth: proof,
                  readiness: currentReadiness,
                  now: new Date(at.getTime()),
                  maxAuthAgeMs,
                });
              };
              requireReceiving(databaseNow);
              requireConsent(databaseNow);
              freshSnapshot(databaseNow);
              await requireResolvedOwnScope();
              const totals = await execute(sql`SELECT
                COALESCE((SELECT SUM(w.reserved_cents)::text FROM ${withdrawalIntent} w WHERE w.site_id=${actor.siteId} AND w.account_id=${snapshot.accountId} AND w.environment=${mode} AND w.reservation_state='HELD' AND w.state IN ('REQUESTED','AWAITING_AUTHORIZATION','PROCESSING','UNKNOWN')),'0') AS "heldCents",
                ((SELECT COUNT(*) FROM ${financialEventInbox} ev WHERE ev.site_id=${actor.siteId} AND ev.account_id=${snapshot.accountId} AND ev.environment=${mode} AND ev.authenticated_at IS NOT NULL AND ev.state<>'PROCESSED' AND ev.event_type ~ '^(PAYMENT|CHECKOUT|TRANSFER|REFUND)_') +
                (SELECT COUNT(*) FROM ${financialOperation} op WHERE op.site_id=${actor.siteId} AND op.account_id=${snapshot.accountId} AND op.environment=${mode} AND op.state='UNKNOWN') +
                (SELECT COUNT(*) FROM ${giftPaymentRecord} p WHERE p.site_id=${actor.siteId} AND p.account_id=${snapshot.accountId} AND p.environment=${mode} AND (p.provider_status IS NULL OR p.verification_status<>'VERIFIED' OR p.provider_status NOT IN ('PENDING','AUTHORIZED','CONFIRMED','RECEIVED','OVERDUE'))))::text AS "unresolvedFinancialEventCount",
                ((SELECT COUNT(*) FROM ${withdrawalIntent} w WHERE w.site_id=${actor.siteId} AND w.account_id=${snapshot.accountId} AND w.environment=${mode} AND w.state='COMPLETED' AND w.updated_at>=${snapshot.balance.observedAt}::timestamptz) +
                (SELECT COUNT(*) FROM ${financialLedgerEntry} le WHERE le.site_id=${actor.siteId} AND le.account_id=${snapshot.accountId} AND le.environment=${mode} AND le.direction='DEBIT' AND le.created_at>=${snapshot.balance.observedAt}::timestamptz))::text AS "balanceEffectsAfterObservationCount"`);
              if (totals.rows.length !== 1) return fail();
              heldCents = count(totals.rows[0].heldCents);
              unresolvedFinancialEventCount = safeCount(
                totals.rows[0].unresolvedFinancialEventCount,
              );
              balanceEffectsAfterObservationCount = safeCount(
                totals.rows[0].balanceEffectsAfterObservationCount,
              );
              if (
                unresolvedFinancialEventCount !== 0 ||
                balanceEffectsAfterObservationCount !== 0
              )
                return fail("FINANCIAL_EVENTS_UNRESOLVED", 409);
              if (
                BigInt(snapshot.balance.balanceCents) - heldCents <
                BigInt(snapshot.intent.amountCents)
              )
                return fail("INSUFFICIENT_FUNDS", 409);
            }
            databaseNow = await databaseClock();
            if (!previous) {
              freshSnapshot(databaseNow);
              requireReceiving(databaseNow);
            }
            const callbackResult = await authorize({
              access,
              currentSession: actor,
              context,
              existingReservation: previous,
              heldCents,
              unresolvedFinancialEventCount,
              balanceEffectsAfterObservationCount,
            });
            localCheck();
            databaseNow = await databaseClock();
            if (callbackResult !== undefined) return fail();
            if (previous) return previous;
            await requireResolvedOwnScope();
            freshSnapshot(databaseNow);
            requireReceiving(databaseNow);
            const inserted = await execute(
              sql`INSERT INTO ${withdrawalIntent} ("id","site_id","account_id","environment","operator_user_id","destination_version","request_id","request_hash","authorization_reference","policy_version","amount_cents","fee_cents","net_cents","currency","state","reservation_state","reserved_cents","provider_reference","receipt_reference","resolution_observed_at","created_at","updated_at") VALUES (${snapshot.intent.id},${actor.siteId},${snapshot.accountId},${mode},${snapshot.operatorUserId},${snapshot.intent.destinationVersion},${snapshot.requestId},${snapshot.requestHash},${snapshot.authenticationAuditHash},${snapshot.feeQuote.policyVersion},${snapshot.intent.amountCents},${snapshot.intent.feeCents},${snapshot.intent.netCents},${snapshot.intent.currency},${"REQUESTED"},${"HELD"},${snapshot.intent.amountCents},${null},${null},${null},${snapshot.intent.createdAt},${snapshot.intent.createdAt}) RETURNING id`,
            );
            if (
              inserted.rows.length !== 1 ||
              inserted.rows[0].id !== snapshot.intent.id
            )
              return fail();
            databaseNow = await databaseClock();
            freshSnapshot(databaseNow);
            requireReceiving(databaseNow);
            const operation = await execute(
              sql`INSERT INTO ${financialOperation} ("id","site_id","account_id","environment","kind","withdrawal_intent_id","order_id","payment_id","state","request_id","request_hash","request_snapshot","provider_operation_reference","lease_owner","lease_token","lease_expires_at","attempts","next_attempt_at","last_error_code","created_at","updated_at") VALUES (${snapshot.operationId},${actor.siteId},${snapshot.accountId},${mode},${"WITHDRAWAL"},${snapshot.intent.id},${null},${null},${"REQUESTED"},${snapshot.requestId},${snapshot.requestHash},${JSON.stringify(snapshot)}::jsonb,${null},${null},${null},${null},${0},${snapshot.intent.createdAt},${null},${snapshot.intent.createdAt},${snapshot.intent.createdAt}) RETURNING id`,
            );
            if (
              operation.rows.length !== 1 ||
              operation.rows[0].id !== snapshot.operationId
            )
              return fail();
            databaseNow = await databaseClock();
            freshSnapshot(databaseNow);
            requireReceiving(databaseNow);
            if (!association || !confirmation)
              return fail("REQUEST_CONFLICT", 409);
            const committedRequest =
              await execute(sql`UPDATE ${withdrawalRequest} r SET state='COMMITTED',request_revision=2,withdrawal_intent_id=${snapshot.intent.id},updated_at=clock_timestamp()
              WHERE r.id=${association.row.id} AND r.site_id=${actor.siteId} AND r.account_id=${snapshot.accountId} AND r.environment=${mode} AND r.operator_user_id=${actor.userId} AND r.destination_version=${snapshot.intent.destinationVersion} AND r.request_id=${snapshot.requestId} AND r.preview_hash=${confirmation.previewHash} AND r.state='OPEN' AND r.request_revision=1 AND r.withdrawal_intent_id IS NULL AND r.sealed_at IS NULL AND r.expires_at>clock_timestamp() RETURNING r.id`);
            if (
              committedRequest.rows.length !== 1 ||
              committedRequest.rows[0].id !== association.row.id
            )
              return fail("REQUEST_CONFLICT", 409);
            databaseNow = await databaseClock();
            const persisted = await find(
              tx,
              actor.siteId,
              snapshot.requestId,
              databaseNow,
              true,
            );
            localCheck();
            databaseNow = await databaseClock();
            await requireResolvedOwnScope();
            freshSnapshot(databaseNow);
            requireReceiving(databaseNow);
            if (
              !persisted ||
              !isDeepStrictEqual(persisted, {
                snapshot,
                intent: snapshot.intent,
              })
            )
              return fail();
            return persisted;
          });
          localCheck();
          return result;
        } catch (error) {
          return safeError(error);
        }
      },
    };
  } catch (error) {
    return safeError(error);
  }
}
