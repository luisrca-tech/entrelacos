import { isDeepStrictEqual } from "node:util";
import { siteAccessSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialLedgerEntry,
  financialOperation,
  receivingAccount,
  receivingDestination,
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
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { assertRecipientFinancialAction } from "./financialAuthorization";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  captureDispatchFence,
  captureOriginalHolderBinding,
  captureOriginalWithdrawal,
  captureWithdrawalCallable,
  captureWithdrawalObservation,
  captureWithdrawalValue,
  type DispatchFence,
  genuineWithdrawalPromise,
  type OriginalHolderConsentBinding,
  type OriginalWithdrawal,
  type StoredWithdrawalExecution,
  type WithdrawalArmResult,
  type WithdrawalCompletionProof,
  type WithdrawalDispatchAuthority,
  type WithdrawalPostingRepository,
  type WithdrawalPostingResult,
  withdrawalCompletedEffectKey,
  withdrawalCorrelation,
  withdrawalInstant,
  withdrawalObject,
  withdrawalReference,
} from "./withdrawalExecution";
import {
  captureWithdrawalPresentation,
  readWithdrawalConsentRecord,
  readWithdrawalReservationSnapshot,
  sameWithdrawalConsentTerms,
  type WithdrawalConsentRecord,
  type WithdrawalProtectedRequestAttempt,
  type WithdrawalReservationSnapshot,
} from "./withdrawalReservations";

export type WithdrawalPostingDatabase = Pick<
  DatabaseConnection["db"],
  "execute" | "transaction"
>;
export interface WithdrawalPostingPorts {
  loadOriginalHolderConsentInTransaction(
    tx: ReceivingTransaction,
    snapshot: WithdrawalReservationSnapshot,
    consent: WithdrawalConsentRecord,
  ): Promise<OriginalHolderConsentBinding | null>;
  loadDispatchAuthorityInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    attempt: WithdrawalProtectedRequestAttempt,
    databaseNow: Date,
  ): Promise<WithdrawalDispatchAuthority | null>;
  loadCompletionProofInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    proofReference: string,
  ): Promise<WithdrawalCompletionProof | null>;
}
export type WithdrawalPostingRepositoryOptions =
  | { mode: "disabled" }
  | {
      mode: "sandbox" | "live";
      applicationEnvironment: "development" | "test" | "production";
      maxAuthAgeMs: number;
      freshnessMs: number;
      leaseOwner: string;
      leaseDurationMs: number;
      now(): Date;
      generateLeaseToken(): string;
      ports?: WithdrawalPostingPorts;
    };
class Denied extends Error {
  constructor() {
    super("Withdrawal posting denied");
  }
}
function deny(): never {
  throw new Denied();
}
function micros(value: unknown): bigint {
  return databaseTimestampEpochMicroseconds(value);
}
function same(left: unknown, right: unknown): void {
  if (!isDeepStrictEqual(left, right)) deny();
}
function nullableReference(value: unknown): string | null {
  return value === null ? null : withdrawalReference(value);
}
function one(result: { rows: unknown[] }): Record<string, unknown> {
  if (result.rows.length !== 1) return deny();
  return withdrawalObject(captureWithdrawalValue(result.rows[0]));
}
function cents(value: unknown, positive = false): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < (positive ? 1 : 0) ||
    (value as number) > 2147483647
  )
    return deny();
  return value as number;
}
function effectKey(original: OriginalWithdrawal): string {
  return withdrawalCompletedEffectKey(original.correlation);
}
function identity(value: unknown): { siteId: string; requestId: string } {
  const raw = withdrawalObject(captureWithdrawalValue(value), [
    "siteId",
    "requestId",
  ]);
  return {
    siteId: withdrawalReference(raw.siteId, 128),
    requestId: withdrawalReference(raw.requestId, 128),
  };
}
type Enabled = Exclude<
  WithdrawalPostingRepositoryOptions,
  { mode: "disabled" }
>;
type Execute = (statement: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
interface Unit {
  tx: ReceivingTransaction;
  execute: Execute;
  clock(): Promise<Date>;
  local(): Date;
  siteRow: Record<string, unknown> | null;
}

export function createWithdrawalPostingRepository(
  db: WithdrawalPostingDatabase,
  options: WithdrawalPostingRepositoryOptions,
): WithdrawalPostingRepository {
  let configuration:
    | (Omit<Enabled, "ports"> & {
        ports: WithdrawalPostingPorts;
        transaction: WithdrawalPostingDatabase["transaction"];
      })
    | null = null;
  try {
    const fields = Object.getOwnPropertyDescriptors(options);
    if (Object.values(fields).some((field) => !Object.hasOwn(field, "value")))
      throw new TypeError("Accessor withdrawal configuration denied");
    const mode: unknown = fields.mode?.value;
    const applicationEnvironment: unknown =
      fields.applicationEnvironment?.value;
    const maxAuthAgeMs: unknown = fields.maxAuthAgeMs?.value;
    const freshnessMs: unknown = fields.freshnessMs?.value;
    const leaseOwner: unknown = fields.leaseOwner?.value;
    const leaseDurationMs: unknown = fields.leaseDurationMs?.value;
    if (
      ((mode === "live" && applicationEnvironment === "production") ||
        (mode === "sandbox" &&
          (applicationEnvironment === "development" ||
            applicationEnvironment === "test"))) &&
      typeof maxAuthAgeMs === "number" &&
      typeof freshnessMs === "number" &&
      typeof leaseDurationMs === "number" &&
      [maxAuthAgeMs, freshnessMs, leaseDurationMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      const owner = withdrawalReference(leaseOwner, 128);
      const ports = fields.ports?.value;
      configuration = {
        mode,
        applicationEnvironment,
        maxAuthAgeMs,
        freshnessMs,
        leaseOwner: owner,
        leaseDurationMs,
        now: captureWithdrawalCallable(options, "now", false),
        generateLeaseToken: captureWithdrawalCallable(
          options,
          "generateLeaseToken",
          false,
        ),
        transaction: captureWithdrawalCallable(db, "transaction", false),
        ports: {
          loadOriginalHolderConsentInTransaction: captureWithdrawalCallable(
            ports,
            "loadOriginalHolderConsentInTransaction",
            true,
          ),
          loadDispatchAuthorityInTransaction: captureWithdrawalCallable(
            ports,
            "loadDispatchAuthorityInTransaction",
            true,
          ),
          loadCompletionProofInTransaction: captureWithdrawalCallable(
            ports,
            "loadCompletionProofInTransaction",
            true,
          ),
        },
      };
    }
  } catch {
    configuration = null;
  }
  const c = configuration;
  function local(): Date {
    const value = c!.now();
    if (!(value instanceof Date) || micros(value) < 0n) return deny();
    return readDatabaseTimestamp(value);
  }
  function unit(tx: ReceivingTransaction, check?: () => void): Unit {
    const nativeExecute = captureWithdrawalCallable<Execute>(
      tx,
      "execute",
      false,
    );
    let previous: bigint | null = null;
    let previousLocal: bigint | null = null;
    const guard = () => {
      const at = local();
      const value = micros(at);
      if (previousLocal !== null && value < previousLocal) deny();
      previousLocal = value;
      check?.();
      return at;
    };
    const execute: Execute = async (statement) => {
      guard();
      const result = await genuineWithdrawalPromise(nativeExecute(statement));
      guard();
      if (!result || !Array.isArray(result.rows)) return deny();
      return result;
    };
    const u: Unit = {
      tx,
      execute,
      local: guard,
      siteRow: null,
      async clock() {
        const at = readDatabaseTimestamp(
          one(await execute(sql`SELECT clock_timestamp() AS "currentTime"`))
            .currentTime,
        );
        if (micros(at) < 0n || (previous !== null && micros(at) < previous))
          return deny();
        previous = micros(at);
        return at;
      },
    };
    return u;
  }
  async function transaction<T>(
    callback: (u: Unit) => Promise<T>,
    check?: () => void,
  ): Promise<T> {
    return (await genuineWithdrawalPromise(
      c!.transaction(async (tx) => callback(unit(tx, check)), {
        isolationLevel: "read committed",
      }),
    )) as T;
  }
  async function lockSite(u: Unit, key: { siteId: string; requestId: string }) {
    await u.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["withdrawal-reservation", key.siteId, key.requestId])},0))`,
    );
    const row = one(
      await u.execute(
        sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${key.siteId} FOR UPDATE OF st`,
      ),
    );
    if (row.siteId !== key.siteId || typeof row.isDemo !== "boolean") deny();
    u.siteRow = row;
  }
  async function selectIntent(
    u: Unit,
    key: { siteId: string; requestId: string },
    lock = false,
  ) {
    const result = await u.execute(
      sql`SELECT w.id,w.site_id AS "siteId",w.account_id AS "accountId",w.environment,w.operator_user_id AS "operatorUserId",w.destination_version AS "destinationVersion",w.request_id AS "requestId",w.request_hash AS "requestHash",w.authorization_reference AS "authorizationReference",w.policy_version AS "policyVersion",w.amount_cents AS "amountCents",w.fee_cents AS "feeCents",w.net_cents AS "netCents",w.currency,w.state,w.reservation_state AS "reservationState",w.reserved_cents AS "reservedCents",w.provider_reference AS "providerReference",w.receipt_reference AS "receiptReference",w.resolution_observed_at AS "resolutionObservedAt",w.created_at AS "createdAt",w.updated_at AS "updatedAt" FROM ${withdrawalIntent} w WHERE w.site_id=${key.siteId} AND w.request_id=${key.requestId} LIMIT 2 ${lock ? sql`FOR UPDATE OF w` : sql``}`,
    );
    return result.rows.length === 0 ? null : one(result);
  }
  async function lockAccount(u: Unit, row: Record<string, unknown>) {
    const account = one(
      await u.execute(
        sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.is_current AS "isCurrent" FROM ${receivingAccount} a WHERE a.id=${row.accountId} AND a.site_id=${row.siteId} AND a.environment=${row.environment} FOR UPDATE OF a`,
      ),
    );
    if (
      account.id !== row.accountId ||
      account.siteId !== row.siteId ||
      account.environment !== row.environment ||
      account.provider !== "ASAAS"
    )
      deny();
    return account;
  }
  async function load(
    u: Unit,
    key: { siteId: string; requestId: string },
    lock = false,
  ): Promise<StoredWithdrawalExecution | null> {
    // Reservation writers lock the committed request before its monetary rows.
    if (lock)
      one(
        await u.execute(
          sql`SELECT r.id FROM ${withdrawalRequest} r WHERE r.site_id=${key.siteId} AND r.request_id=${key.requestId} LIMIT 2 FOR UPDATE OF r`,
        ),
      );
    const row = await selectIntent(u, key, lock);
    if (!row) return null;
    const operation = one(
      await u.execute(
        sql`SELECT op.id,op.site_id AS "siteId",op.account_id AS "accountId",op.environment,op.kind,op.state,op.request_id AS "requestId",op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",op.withdrawal_intent_id AS "withdrawalIntentId",op.order_id AS "orderId",op.payment_id AS "paymentId",op.provider_operation_reference AS "providerOperationReference",op.attempts,op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",op.next_attempt_at AS "nextAttemptAt",op.last_error_code AS "lastErrorCode",op.created_at AS "createdAt",op.updated_at AS "updatedAt" FROM ${financialOperation} op WHERE op.site_id=${key.siteId} AND op.withdrawal_intent_id=${row.id} LIMIT 2 ${lock ? sql`FOR UPDATE OF op` : sql``}`,
      ),
    );
    const association = one(
      await u.execute(
        sql`SELECT r.id,r.site_id AS "siteId",r.account_id AS "accountId",r.environment,r.operator_user_id AS "operatorUserId",r.destination_version AS "destinationVersion",r.request_id AS "requestId",r.preview_snapshot AS "previewSnapshot",r.preview_hash AS "previewHash",r.expires_at AS "expiresAt",r.state,r.request_revision::text AS "requestRevision",r.withdrawal_intent_id AS "withdrawalIntentId",r.sealed_at AS "sealedAt",r.created_at AS "createdAt",r.updated_at AS "updatedAt" FROM ${withdrawalRequest} r WHERE r.site_id=${key.siteId} AND r.request_id=${key.requestId} LIMIT 2 ${lock ? sql`FOR UPDATE OF r` : sql``}`,
      ),
    );
    const at = await u.clock();
    const snapshot = readWithdrawalReservationSnapshot(
      operation.requestSnapshot,
    );
    const consent = readWithdrawalConsentRecord({
      snapshot: association.previewSnapshot,
      previewHash: association.previewHash,
      requestRevision: association.requestRevision,
      state: association.state,
    });
    const correlation = withdrawalCorrelation(snapshot);
    if (
      snapshot.intent.siteId !== key.siteId ||
      snapshot.requestId !== key.requestId ||
      snapshot.environment !== c!.mode ||
      row.id !== snapshot.intent.id ||
      row.siteId !== key.siteId ||
      row.requestId !== key.requestId ||
      row.accountId !== snapshot.accountId ||
      row.environment !== snapshot.environment ||
      row.operatorUserId !== snapshot.operatorUserId ||
      row.destinationVersion !== snapshot.intent.destinationVersion ||
      row.requestHash !== snapshot.requestHash ||
      row.authorizationReference !== snapshot.authenticationAuditHash ||
      row.policyVersion !== snapshot.feeQuote.policyVersion ||
      cents(row.amountCents, true) !== snapshot.intent.amountCents ||
      cents(row.feeCents) !== snapshot.intent.feeCents ||
      cents(row.netCents, true) !== snapshot.intent.netCents ||
      row.currency !== "BRL"
    )
      deny();
    if (
      operation.id !== snapshot.operationId ||
      operation.siteId !== key.siteId ||
      operation.accountId !== snapshot.accountId ||
      operation.environment !== snapshot.environment ||
      operation.kind !== "WITHDRAWAL" ||
      operation.requestId !== snapshot.requestId ||
      operation.requestHash !== snapshot.requestHash ||
      operation.withdrawalIntentId !== row.id ||
      operation.orderId !== null ||
      operation.paymentId !== null ||
      ![0, 1].includes(operation.attempts as number)
    )
      deny();
    if (
      consent.state !== "COMMITTED" ||
      association.withdrawalIntentId !== row.id ||
      association.sealedAt !== null ||
      association.siteId !== key.siteId ||
      association.requestId !== key.requestId ||
      association.accountId !== snapshot.accountId ||
      association.environment !== snapshot.environment ||
      association.operatorUserId !== snapshot.operatorUserId ||
      association.destinationVersion !== snapshot.intent.destinationVersion ||
      micros(association.expiresAt) !==
        micros(consent.snapshot.preview.expiresAt)
    )
      deny();
    for (const [created, updated] of [
      [row.createdAt, row.updatedAt],
      [operation.createdAt, operation.updatedAt],
      [association.createdAt, association.updatedAt],
    ])
      if (
        micros(updated) < micros(created) ||
        micros(updated) > micros(at) ||
        micros(created) > micros(at)
      )
        deny();
    if (
      micros(row.createdAt) !== micros(snapshot.intent.createdAt) ||
      micros(operation.createdAt) !== micros(snapshot.intent.createdAt) ||
      micros(association.createdAt) < micros(consent.snapshot.preview.issuedAt)
    )
      deny();
    withdrawalInstant(operation.nextAttemptAt);
    if (
      operation.lastErrorCode !== null &&
      (typeof operation.lastErrorCode !== "string" ||
        !/^[A-Z0-9_]{1,64}$/.test(operation.lastErrorCode))
    )
      deny();
    const holder = await genuineWithdrawalPromise(
      c!.ports.loadOriginalHolderConsentInTransaction(
        u.tx,
        captureWithdrawalValue(snapshot),
        captureWithdrawalValue(consent),
      ),
    );
    const original = captureOriginalWithdrawal({
      snapshot,
      consent,
      associationId: association.id,
      correlation,
      holderBinding: captureOriginalHolderBinding(
        holder,
        correlation,
        consent.previewHash,
      ),
    });
    const current = await u.clock();
    if (micros(at) > micros(current)) deny();
    // Custody readers cannot silently change the monetary row they just bound.
    const retainedRow = await selectIntent(u, key, lock);
    if (!retainedRow) return deny();
    same(retainedRow, row);
    const providerReference = nullableReference(row.providerReference);
    same(
      providerReference,
      nullableReference(operation.providerOperationReference),
    );
    const receiptReference = nullableReference(row.receiptReference);
    const resolutionObservedAt =
      row.resolutionObservedAt === null
        ? null
        : withdrawalInstant(row.resolutionObservedAt);
    let fence: DispatchFence | null = null;
    if (operation.attempts === 0) {
      if (
        !["REQUESTED", "AWAITING_AUTHORIZATION", "UNKNOWN"].includes(
          String(row.state),
        ) ||
        operation.state !== "REQUESTED" ||
        [
          operation.leaseOwner,
          operation.leaseToken,
          operation.leaseExpiresAt,
          providerReference,
          receiptReference,
          resolutionObservedAt,
        ].some((value) => value !== null)
      )
        deny();
    } else {
      fence = captureDispatchFence(
        {
          operationId: operation.id,
          attempts: operation.attempts,
          leaseOwner: operation.leaseOwner,
          leaseToken: operation.leaseToken,
          leaseExpiresAt: operation.leaseExpiresAt,
        },
        original,
      );
      if (micros(fence.leaseExpiresAt) <= micros(operation.createdAt)) deny();
      if (row.state === "COMPLETED") {
        if (
          operation.state !== "SUCCEEDED" ||
          row.reservationState !== "CONSUMED" ||
          row.reservedCents !== 0 ||
          !providerReference ||
          !receiptReference ||
          resolutionObservedAt === null ||
          micros(resolutionObservedAt) < micros(snapshot.intent.createdAt) ||
          micros(resolutionObservedAt) > micros(current)
        )
          deny();
      } else if (
        !(
          (row.state === "PROCESSING" && operation.state === "PROCESSING") ||
          (row.state === "UNKNOWN" &&
            ["PROCESSING", "UNKNOWN"].includes(String(operation.state)))
        ) ||
        receiptReference !== null ||
        resolutionObservedAt !== null
      )
        deny();
    }
    if (
      row.state !== "COMPLETED" &&
      (row.reservationState !== "HELD" ||
        row.reservedCents !== snapshot.intent.amountCents)
    )
      deny();
    return Object.freeze({
      original,
      state: row.state as StoredWithdrawalExecution["state"],
      operationState:
        operation.state as StoredWithdrawalExecution["operationState"],
      reservationState:
        row.reservationState as StoredWithdrawalExecution["reservationState"],
      reservedCents: cents(row.reservedCents),
      fence,
      providerReference,
      receiptReference,
      resolutionObservedAt,
    });
  }
  async function lockedExisting(
    u: Unit,
    original: OriginalWithdrawal,
  ): Promise<StoredWithdrawalExecution> {
    const key = identity({
      siteId: original.correlation.siteId,
      requestId: original.correlation.requestId,
    });
    await lockSite(u, key);
    const preliminary = await selectIntent(u, key);
    if (!preliminary) return deny();
    await lockAccount(u, preliminary);
    const stored = await load(u, key, true);
    if (!stored) return deny();
    same(stored.original, original);
    return stored;
  }
  async function write(u: Unit, statement: SQL, id: string) {
    const result = await u.execute(statement);
    if (result.rows.length !== 1 || result.rows[0].id !== id)
      throw new Error("Withdrawal CAS not acknowledged");
  }
  async function noReferenceCollision(
    u: Unit,
    original: OriginalWithdrawal,
    providerReference: string,
    receiptReference?: string,
  ) {
    const c = original.correlation;
    const collisions = await u.execute(
      sql`SELECT w.id AS "collisionId" FROM ${withdrawalIntent} w WHERE w.provider_reference=${providerReference} AND w.id<>${c.withdrawalId} AND w.site_id=${c.siteId} AND w.account_id=${c.accountId} AND w.environment=${c.environment} LIMIT 2`,
    );
    const operations = await u.execute(
      sql`SELECT op.id AS "collisionId" FROM ${financialOperation} op WHERE op.provider_operation_reference=${providerReference} AND op.id<>${c.operationId} AND op.site_id=${c.siteId} AND op.account_id=${c.accountId} AND op.environment=${c.environment} LIMIT 2`,
    );
    if (collisions.rows.length || operations.rows.length) deny();
    if (
      receiptReference &&
      (
        await u.execute(
          sql`SELECT w.id AS "collisionId" FROM ${withdrawalIntent} w WHERE w.receipt_reference=${receiptReference} AND w.id<>${c.withdrawalId} LIMIT 2`,
        )
      ).rows.length
    )
      deny();
  }
  function checkAttempt(attempt: WithdrawalProtectedRequestAttempt, at: Date) {
    const actor = attempt.actor;
    const proof = attempt.recentAuth;
    if (
      !actor ||
      !proof ||
      proof.userId !== actor.userId ||
      proof.siteId !== actor.siteId ||
      proof.sessionId !== actor.sessionId ||
      proof.provenance !== "backend" ||
      proof.verification !== "verified" ||
      !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
        proof.proofKind,
      )
    )
      deny();
    if (
      micros(proof.authenticatedAt) > micros(at) ||
      micros(proof.expiresAt) <= micros(at) ||
      micros(at) - micros(proof.authenticatedAt) >
        BigInt(c!.maxAuthAgeMs) * 1000n ||
      micros(proof.expiresAt) - micros(proof.authenticatedAt) >
        BigInt(c!.maxAuthAgeMs) * 1000n
    )
      deny();
  }
  async function arm(
    attempt: WithdrawalProtectedRequestAttempt,
  ): Promise<WithdrawalArmResult> {
    const key = identity({
      siteId: attempt.actor?.siteId,
      requestId: attempt.requestId,
    });
    return transaction(async (u) => {
      await lockSite(u, key);
      const preliminary = await selectIntent(u, key);
      if (!preliminary) return deny();
      // Existing admission is read without granting fresh dispatch authority.
      const initialOperation = one(
        await u.execute(
          sql`SELECT op.attempts FROM ${financialOperation} op WHERE op.site_id=${key.siteId} AND op.withdrawal_intent_id=${preliminary.id} LIMIT 2`,
        ),
      );
      if (initialOperation.attempts === 1) {
        await lockAccount(u, preliminary);
        const stored = await load(u, key, true);
        if (!stored) return deny();
        return { outcome: "EXISTING", stored };
      }
      const actor = attempt.actor!;
      checkAttempt(attempt, await u.clock());
      const activeUser = one(
        await u.execute(
          sql`SELECT u.id AS "userId",u.role,u.state FROM ${user} u WHERE u.id=${actor.userId} AND u.state='ACTIVE' FOR SHARE OF u`,
        ),
      );
      if (
        activeUser.userId !== actor.userId ||
        activeUser.state !== "ACTIVE" ||
        !["SITE_ADMIN", "SITE_ASSISTANT"].includes(String(activeUser.role))
      )
        deny();
      const activeSession = one(
        await u.execute(
          sql`SELECT se.user_id AS "userId",se.id AS "sessionId",se.expires_at AS "sessionExpiresAt",se.last_active_at AS "lastActiveAt",se.created_at AS "sessionCreatedAt" FROM ${session} se WHERE se.id=${actor.sessionId} AND se.user_id=${actor.userId} FOR SHARE OF se`,
        ),
      );
      if (
        activeSession.userId !== actor.userId ||
        activeSession.sessionId !== actor.sessionId
      )
        deny();
      const membership = one(
        await u.execute(
          sql`SELECT m.id,m.site_id AS "siteId",m.user_id AS "userId",m.role,m.revoked_at AS "revokedAt" FROM ${siteMembership} m WHERE m.site_id=${actor.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR SHARE OF m`,
        ),
      );
      if (
        membership.siteId !== actor.siteId ||
        membership.userId !== actor.userId ||
        membership.role !== "SITE_ADMIN" ||
        membership.revokedAt !== null
      )
        deny();
      const account = await lockAccount(u, preliminary);
      const stored = await load(u, key, true);
      if (!stored) return deny();
      if (
        stored.state !== "REQUESTED" ||
        stored.operationState !== "REQUESTED" ||
        stored.fence !== null ||
        stored.providerReference !== null ||
        stored.receiptReference !== null ||
        stored.resolutionObservedAt !== null ||
        account.isCurrent !== true ||
        account.operatorUserId !== actor.userId ||
        stored.original.correlation.operatorUserId !== actor.userId ||
        account.accountReference !==
          stored.original.correlation.accountReference ||
        account.recipientReference !==
          stored.original.correlation.recipientReference
      )
        deny();
      const original = stored.original;
      const scope = original.consent.snapshot.scope;
      const destination = one(
        await u.execute(
          sql`SELECT d.id,d.site_id AS "siteId",d.account_id AS "accountId",d.environment,d.version,d.bank_reference AS "bankReference",d.bank_state AS "bankState",d.is_current AS "isCurrent" FROM ${receivingDestination} d WHERE d.site_id=${scope.siteId} AND d.account_id=${scope.accountId} AND d.environment=${scope.environment} AND d.version=${scope.destinationVersion} LIMIT 2 FOR SHARE OF d`,
        ),
      );
      if (
        destination.id !==
          original.consent.snapshot.presentation.destinationId ||
        destination.bankReference !== scope.bankReference ||
        destination.bankState !== "VERIFIED" ||
        destination.isCurrent !== true
      )
        deny();
      const before = await u.clock();
      const authority = captureWithdrawalValue(
        await genuineWithdrawalPromise(
          c!.ports.loadDispatchAuthorityInTransaction(
            u.tx,
            original,
            captureWithdrawalValue(attempt),
            readDatabaseTimestamp(before),
          ),
        ),
      );
      if (!authority) return deny();
      const after = await u.clock();
      const validate = (at: Date) => {
        checkAttempt(attempt, at);
        same(authority.actor, actor);
        same(authority.holderBinding, original.holderBinding);
        const access = siteAccessSchema.parse(authority.access);
        const offered = siteAccessSchema.parse(attempt.access);
        same(access, offered);
        if (
          access.membershipId !== membership.id ||
          access.userId !== actor.userId ||
          authority.context.siteId !== key.siteId ||
          authority.context.mode !== c!.mode ||
          authority.context.isDemo !== u.siteRow?.isDemo ||
          authority.context.verification !== "verified" ||
          authority.context.accountId !== scope.accountId ||
          authority.context.bankReference !== scope.bankReference ||
          (c!.mode === "live" && authority.context.isDemo)
        )
          deny();
        same(authority.recentAuth, attempt.recentAuth);
        const binding = authority.context.recipientBinding;
        if (
          !binding ||
          binding.accountReference !== scope.accountReference ||
          binding.recipientReference !==
            original.correlation.recipientReference ||
          binding.operatorUserId !== actor.userId ||
          binding.destinationVersion !== scope.destinationVersion ||
          binding.environment !== scope.environment
        )
          deny();
        assertRecipientFinancialAction({
          action: "REQUEST_WITHDRAWAL",
          siteId: key.siteId,
          environment: c!.mode,
          access,
          actor: authority.actor,
          recipientBinding: binding,
          recentAuth: authority.recentAuth,
          readiness: authority.context.readiness,
          now: at,
          maxAuthAgeMs: c!.maxAuthAgeMs,
        });
        const created = micros(activeSession.sessionCreatedAt),
          last = micros(activeSession.lastActiveAt),
          expiry = micros(activeSession.sessionExpiresAt),
          current = micros(at);
        if (
          created > last ||
          created >= expiry ||
          last > current ||
          current >= expiry ||
          current - last >= BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
          current - created >= BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n ||
          current >= micros(original.consent.snapshot.preview.expiresAt) ||
          current >= micros(original.snapshot.feeQuote.expiresAt)
        )
          deny();
        const presentation = captureWithdrawalPresentation(
          authority.presentation,
          scope,
          authority.context,
          actor.userId,
          at.getTime(),
          c!.freshnessMs,
          c!.applicationEnvironment,
        );
        if (
          !sameWithdrawalConsentTerms(
            original.consent.snapshot,
            original.snapshot,
            presentation,
          ) ||
          !isDeepStrictEqual(
            presentation,
            original.consent.snapshot.presentation,
          )
        )
          deny();
        const ready = authority.context.readiness!;
        if (
          micros(ready.observedAt) > current ||
          current - micros(ready.observedAt) > BigInt(c!.freshnessMs) * 1000n
        )
          deny();
      };
      validate(before);
      validate(after);
      same(
        captureOriginalHolderBinding(
          await genuineWithdrawalPromise(
            c!.ports.loadOriginalHolderConsentInTransaction(
              u.tx,
              original.snapshot,
              original.consent,
            ),
          ),
          original.correlation,
          original.consent.previewHash,
        ),
        original.holderBinding,
      );
      const retained = await load(u, key, true);
      if (!retained) return deny();
      same(retained, stored);
      const at = await u.clock();
      validate(at);
      const validUntil = [
        readDatabaseTimestamp(attempt.recentAuth?.expiresAt),
        new Date(
          Number(micros(attempt.recentAuth?.authenticatedAt) / 1000n) +
            c!.maxAuthAgeMs,
        ),
        new Date(original.consent.snapshot.preview.expiresAt),
        new Date(original.snapshot.feeQuote.expiresAt),
      ].reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
      const leaseToken = withdrawalReference(c!.generateLeaseToken(), 128);
      const fence: DispatchFence = Object.freeze({
        operationId: original.correlation.operationId,
        attempts: 1,
        leaseOwner: c!.leaseOwner,
        leaseToken,
        leaseExpiresAt: new Date(
          Math.min(at.getTime() + c!.leaseDurationMs, validUntil.getTime()),
        ).toISOString(),
      });
      const s = original.correlation;
      await write(
        u,
        sql`UPDATE ${withdrawalIntent} w SET state='PROCESSING',updated_at=${withdrawalInstant(at)}::timestamptz WHERE w.id=${s.withdrawalId} AND w.site_id=${s.siteId} AND w.account_id=${s.accountId} AND w.environment=${s.environment} AND w.request_hash=${s.requestHash} AND w.state='REQUESTED' AND w.reservation_state='HELD' AND w.reserved_cents=${s.amountCents} AND w.provider_reference IS NULL AND w.receipt_reference IS NULL AND w.resolution_observed_at IS NULL RETURNING id`,
        s.withdrawalId,
      );
      validate(await u.clock());
      await write(
        u,
        sql`UPDATE ${financialOperation} op SET state='PROCESSING',attempts=1,lease_owner=${fence.leaseOwner},lease_token=${fence.leaseToken},lease_expires_at=${fence.leaseExpiresAt}::timestamptz,updated_at=${withdrawalInstant(at)}::timestamptz WHERE op.id=${s.operationId} AND op.site_id=${s.siteId} AND op.account_id=${s.accountId} AND op.environment=${s.environment} AND op.request_hash=${s.requestHash} AND op.request_snapshot=${JSON.stringify(original.snapshot)}::jsonb AND op.state='REQUESTED' AND op.attempts=0 AND op.lease_owner IS NULL AND op.lease_token IS NULL AND op.lease_expires_at IS NULL AND op.provider_operation_reference IS NULL RETURNING id`,
        s.operationId,
      );
      const armed = await load(u, key, true);
      if (!armed) return deny();
      same(armed.original, original);
      same(armed.fence, fence);
      if (
        armed.state !== "PROCESSING" ||
        armed.providerReference !== null ||
        armed.reservedCents !== original.correlation.amountCents
      )
        deny();
      validate(await u.clock());
      return {
        outcome: "ARMED",
        original,
        fence,
        dispatchValidUntil: validUntil.toISOString(),
      };
    });
  }
  function proof(
    value: unknown,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
    at: Date,
    isDemo: boolean,
  ): WithdrawalCompletionProof {
    const raw = withdrawalObject(captureWithdrawalValue(value), [
      "outcome",
      "correlation",
      "holderBinding",
      "fence",
      "proofReference",
      "receiptReference",
      "providerReference",
      "totalDebitCents",
      "feeCents",
      "netCents",
      "currency",
      "bankCompleted",
      "custody",
      "verification",
      "provenance",
      "observedAt",
      "recordedAt",
    ]);
    same(raw.correlation, original.correlation);
    same(
      captureOriginalHolderBinding(
        raw.holderBinding,
        original.correlation,
        original.consent.previewHash,
      ),
      original.holderBinding,
    );
    same(captureDispatchFence(raw.fence, original), fence);
    if (
      raw.outcome !== "COMPLETED" ||
      raw.proofReference !== reference ||
      raw.receiptReference !== reference ||
      raw.custody !== "immutable-durable" ||
      raw.verification !== "verified" ||
      raw.bankCompleted !== true ||
      raw.currency !== "BRL" ||
      (original.snapshot.feeQuote.feeSemantics === "MAXIMUM"
        ? cents(raw.totalDebitCents, true) > original.correlation.amountCents ||
          cents(raw.feeCents) > original.correlation.feeCents
        : cents(raw.totalDebitCents, true) !==
            original.correlation.amountCents ||
          cents(raw.feeCents) !== original.correlation.feeCents) ||
      cents(raw.netCents, true) !== original.correlation.netCents ||
      cents(raw.totalDebitCents, true) !==
        cents(raw.feeCents) + cents(raw.netCents, true) ||
      !["provider", "simulation"].includes(String(raw.provenance)) ||
      (raw.provenance === "simulation" &&
        (c!.mode !== "sandbox" ||
          !isDemo ||
          c!.applicationEnvironment === "production"))
    )
      deny();
    withdrawalReference(raw.providerReference);
    withdrawalReference(raw.receiptReference);
    if (
      micros(raw.observedAt) < micros(original.snapshot.intent.createdAt) ||
      micros(raw.recordedAt) < micros(raw.observedAt) ||
      micros(raw.recordedAt) > micros(at)
    )
      deny();
    return {
      ...raw,
      observedAt: withdrawalInstant(raw.observedAt),
      recordedAt: withdrawalInstant(raw.recordedAt),
    } as unknown as WithdrawalCompletionProof;
  }
  async function post(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
  ): Promise<WithdrawalPostingResult> {
    return transaction(async (u) => {
      const stored = await lockedExisting(u, original);
      same(stored.fence, fence);
      const raw = await genuineWithdrawalPromise(
        c!.ports.loadCompletionProofInTransaction(
          u.tx,
          original,
          fence,
          reference,
        ),
      );
      const at = await u.clock();
      const p = proof(
        raw,
        original,
        fence,
        reference,
        at,
        u.siteRow?.isDemo as boolean,
      );
      same(
        captureOriginalHolderBinding(
          await genuineWithdrawalPromise(
            c!.ports.loadOriginalHolderConsentInTransaction(
              u.tx,
              original.snapshot,
              original.consent,
            ),
          ),
          original.correlation,
          original.consent.previewHash,
        ),
        original.holderBinding,
      );
      if (
        stored.providerReference !== null &&
        stored.providerReference !== p.providerReference
      )
        deny();
      await noReferenceCollision(u, original, p.providerReference, reference);
      const s = original.correlation;
      const key = effectKey(original);
      const effects = await u.execute(
        sql`SELECT le.id,le.site_id AS "siteId",le.account_id AS "accountId",le.environment,le.effect_key AS "effectKey",le.kind,le.direction,le.currency,le.amount_cents AS "amountCents",le.payment_id AS "paymentId",le.withdrawal_intent_id AS "withdrawalIntentId",le.operation_id AS "operationId",le.event_id AS "eventId",le.compensates_entry_id AS "compensatesEntryId",le.created_at AS "createdAt" FROM ${financialLedgerEntry} le WHERE le.site_id=${s.siteId} AND le.account_id=${s.accountId} AND le.environment=${s.environment} AND (le.effect_key=${key} OR le.withdrawal_intent_id=${s.withdrawalId} OR le.operation_id=${s.operationId}) LIMIT 2 FOR UPDATE OF le`,
      );
      const retainedProof = await genuineWithdrawalPromise(
        c!.ports.loadCompletionProofInTransaction(
          u.tx,
          original,
          fence,
          reference,
        ),
      );
      same(
        proof(
          retainedProof,
          original,
          fence,
          reference,
          await u.clock(),
          u.siteRow?.isDemo as boolean,
        ),
        p,
      );
      const debit = {
        id: `withdrawal-debit:${key.slice("withdrawal.completed.v1:".length)}`,
        siteId: s.siteId,
        accountId: s.accountId,
        environment: s.environment,
        effectKey: key,
        kind: "WITHDRAWAL_COMPLETED",
        direction: "DEBIT",
        currency: "BRL",
        amountCents: p.totalDebitCents,
        paymentId: null,
        withdrawalIntentId: s.withdrawalId,
        operationId: s.operationId,
        eventId: null,
        compensatesEntryId: null,
      };
      if (stored.state === "COMPLETED") {
        if (
          effects.rows.length !== 1 ||
          stored.receiptReference !== reference ||
          stored.providerReference !== p.providerReference ||
          micros(stored.resolutionObservedAt) !== micros(p.observedAt)
        )
          deny();
        const effect = one(effects);
        same(
          Object.fromEntries(
            Object.keys(debit).map((key) => [key, effect[key]]),
          ),
          debit,
        );
        if (
          micros(effect.createdAt) < micros(p.recordedAt) ||
          micros(effect.createdAt) > micros(await u.clock())
        )
          deny();
        return { outcome: "DUPLICATE", stored };
      }
      if (
        effects.rows.length !== 0 ||
        !["PROCESSING", "UNKNOWN"].includes(stored.state) ||
        stored.reservationState !== "HELD" ||
        stored.reservedCents !== s.amountCents
      )
        deny();
      const postedAt = await u.clock();
      proof(
        raw,
        original,
        fence,
        reference,
        postedAt,
        u.siteRow?.isDemo as boolean,
      );
      await write(
        u,
        sql`INSERT INTO ${financialLedgerEntry} (id,site_id,account_id,environment,effect_key,kind,direction,currency,amount_cents,payment_id,withdrawal_intent_id,operation_id,event_id,compensates_entry_id,created_at) VALUES (${debit.id},${s.siteId},${s.accountId},${s.environment},${key},'WITHDRAWAL_COMPLETED','DEBIT','BRL',${p.totalDebitCents},NULL,${s.withdrawalId},${s.operationId},NULL,NULL,${withdrawalInstant(postedAt)}::timestamptz) RETURNING id`,
        debit.id,
      );
      await u.clock();
      await write(
        u,
        sql`UPDATE ${withdrawalIntent} w SET state='COMPLETED',reservation_state='CONSUMED',reserved_cents=0,provider_reference=${p.providerReference},receipt_reference=${reference},resolution_observed_at=${p.observedAt}::timestamptz,updated_at=${withdrawalInstant(postedAt)}::timestamptz WHERE w.id=${s.withdrawalId} AND w.site_id=${s.siteId} AND w.account_id=${s.accountId} AND w.environment=${s.environment} AND w.request_hash=${s.requestHash} AND w.state IN ('PROCESSING','UNKNOWN') AND w.reservation_state='HELD' AND w.reserved_cents=${s.amountCents} AND w.receipt_reference IS NULL AND w.resolution_observed_at IS NULL RETURNING id`,
        s.withdrawalId,
      );
      await u.clock();
      await write(
        u,
        sql`UPDATE ${financialOperation} op SET state='SUCCEEDED',provider_operation_reference=${p.providerReference},last_error_code=NULL,updated_at=${withdrawalInstant(postedAt)}::timestamptz WHERE op.id=${s.operationId} AND op.site_id=${s.siteId} AND op.account_id=${s.accountId} AND op.environment=${s.environment} AND op.request_hash=${s.requestHash} AND op.request_snapshot=${JSON.stringify(original.snapshot)}::jsonb AND op.state IN ('PROCESSING','UNKNOWN') AND op.attempts=1 AND op.lease_owner=${fence.leaseOwner} AND op.lease_token=${fence.leaseToken} AND op.lease_expires_at=${fence.leaseExpiresAt}::timestamptz RETURNING id`,
        s.operationId,
      );
      const result = await load(
        u,
        identity({ siteId: s.siteId, requestId: s.requestId }),
        true,
      );
      if (!result) return deny();
      same(result.original, original);
      same(result.fence, fence);
      if (
        result.state !== "COMPLETED" ||
        result.providerReference !== p.providerReference ||
        result.receiptReference !== reference ||
        micros(result.resolutionObservedAt) !== micros(p.observedAt)
      )
        deny();
      return { outcome: "COMPLETED", stored: result };
    });
  }
  return {
    async readExisting(input) {
      if (!c) return null;
      try {
        const key = identity(input);
        return await transaction((u) => load(u, key));
      } catch {
        return null;
      }
    },
    async armExisting(input) {
      if (!c) return { outcome: "DENIED" };
      try {
        const attempt = captureWithdrawalValue(input);
        return await arm(attempt);
      } catch (error) {
        return {
          outcome:
            error instanceof Denied ||
            error instanceof TypeError ||
            (error instanceof Error &&
              [
                "FinancialAuthorizationError",
                "WithdrawalReservationServiceError",
                "ZodError",
              ].includes(error.name))
              ? "DENIED"
              : "UNRESOLVED",
        };
      }
    },
    async recordObservation(originalInput, fenceInput, observationInput) {
      if (!c) throw new Error("Withdrawal posting unavailable");
      const original = captureOriginalWithdrawal(originalInput);
      const fence = captureDispatchFence(fenceInput, original);
      const raw = captureWithdrawalValue(observationInput);
      try {
        return await transaction(async (u) => {
          const stored = await lockedExisting(u, original);
          same(stored.fence, fence);
          const observation = captureWithdrawalObservation(
            raw,
            original,
            fence,
            await u.clock(),
          );
          const provider =
            observation.outcome === "ACCEPTED"
              ? observation.providerReference
              : stored.providerReference;
          if (
            stored.providerReference !== null &&
            stored.providerReference !== provider
          )
            deny();
          if (provider !== null)
            await noReferenceCollision(u, original, provider);
          if (stored.state === "COMPLETED") return stored;
          const s = original.correlation;
          const state =
            observation.outcome === "ACCEPTED" && stored.state !== "UNKNOWN"
              ? "PROCESSING"
              : "UNKNOWN";
          const at = await u.clock();
          await write(
            u,
            sql`UPDATE ${withdrawalIntent} w SET state=${state},provider_reference=${provider},updated_at=${withdrawalInstant(at)}::timestamptz WHERE w.id=${s.withdrawalId} AND w.site_id=${s.siteId} AND w.account_id=${s.accountId} AND w.environment=${s.environment} AND w.request_hash=${s.requestHash} AND w.state IN ('PROCESSING','UNKNOWN') AND w.reservation_state='HELD' AND w.reserved_cents=${s.amountCents} AND w.receipt_reference IS NULL AND w.resolution_observed_at IS NULL RETURNING id`,
            s.withdrawalId,
          );
          await write(
            u,
            sql`UPDATE ${financialOperation} op SET state=${state},provider_operation_reference=${provider},last_error_code=${observation.outcome === "ACCEPTED" ? null : observation.outcome === "REJECTED" ? observation.reason : "WITHDRAWAL_UNRESOLVED"},updated_at=${withdrawalInstant(at)}::timestamptz WHERE op.id=${s.operationId} AND op.site_id=${s.siteId} AND op.account_id=${s.accountId} AND op.environment=${s.environment} AND op.request_hash=${s.requestHash} AND op.request_snapshot=${JSON.stringify(original.snapshot)}::jsonb AND op.state IN ('PROCESSING','UNKNOWN') AND op.attempts=1 AND op.lease_owner=${fence.leaseOwner} AND op.lease_token=${fence.leaseToken} AND op.lease_expires_at=${fence.leaseExpiresAt}::timestamptz RETURNING id`,
            s.operationId,
          );
          const result = await load(
            u,
            identity({ siteId: s.siteId, requestId: s.requestId }),
            true,
          );
          if (!result) return deny();
          same(result.original, original);
          same(result.fence, fence);
          same(result.providerReference, provider);
          return result;
        });
      } catch {
        throw new Error("Withdrawal observation unresolved");
      }
    },
    async postCompleted(originalInput, fenceInput, proofReference) {
      if (!c) return { outcome: "DENIED" };
      try {
        const original = captureOriginalWithdrawal(originalInput);
        const fence = captureDispatchFence(fenceInput, original);
        return await post(original, fence, withdrawalReference(proofReference));
      } catch (error) {
        return {
          outcome:
            error instanceof Denied ||
            error instanceof TypeError ||
            (error instanceof Error &&
              ["WithdrawalReservationServiceError", "ZodError"].includes(
                error.name,
              ))
              ? "DENIED"
              : "UNRESOLVED",
        };
      }
    },
  };
}
