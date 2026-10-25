import { createHash } from "node:crypto";

// Operator-only repair for this exact release, whose live transport returned before fetch.
// Never expose this operation through HTTP or use it for an uncertain native dispatch.
export const legacyLiveDispatchRevision =
  "07fa027277d9f847945e644f66a6e9fe89e07752";
export const legacyLiveDispatchSourceHash =
  "fbbc420ee9dbcefda54e49a3a143c6a6f77a36e1f3104b3b6a533964f7bcc907";
export interface LegacyRecoveryTransaction {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export function legacyWithdrawalRecoveryDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function requireCondition(value: unknown): asserts value {
  if (!value) throw new Error("Legacy withdrawal recovery refused");
}
export async function readLegacyWithdrawalRecoveryCandidate(
  tx: LegacyRecoveryTransaction,
  siteId: string,
  operationId: string,
) {
  const result = await tx.query(
    `SELECT op.id AS "operationId",w.id AS "withdrawalId",w.site_id AS "siteId",w.account_id AS "accountId",a.account_reference AS "accountReference",
    op.request_id AS "requestId",op.request_hash AS "requestHash",w.environment,op.state AS "operationState",w.state AS "withdrawalState",op.attempts,
    w.reservation_state AS "reservationState",w.reserved_cents AS "reservedCents",w.amount_cents AS "amountCents",w.provider_reference AS "providerReference",
    op.provider_operation_reference AS "providerOperationReference",w.receipt_reference AS "receiptReference",w.resolution_observed_at AS "resolutionObservedAt",
    op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",r.state AS "requestState",
    op.request_snapshot AS "requestSnapshot",r.preview_snapshot AS "previewSnapshot",r.preview_hash AS "previewHash",w.authorization_reference AS "authorizationReference",
    w.fee_cents AS "feeCents",w.net_cents AS "netCents",w.policy_version AS "policyVersion",w.destination_version AS "destinationVersion",
    (SELECT count(*)::int FROM withdrawal_provider_observation x WHERE x.site_id=w.site_id AND x.environment=w.environment) AS "providerObservations",
    (SELECT count(*)::int FROM withdrawal_authorization_candidate x WHERE x.site_id=w.site_id AND x.environment=w.environment) AS "authorizationCandidates",
    (SELECT count(*)::int FROM financial_ledger_entry x WHERE x.site_id=w.site_id AND x.environment=w.environment AND x.direction='DEBIT') AS "debitEntries"
    FROM financial_operation op JOIN withdrawal_intent w ON w.id=op.withdrawal_intent_id AND w.site_id=op.site_id AND w.account_id=op.account_id AND w.environment=op.environment
    JOIN receiving_account a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment AND a.is_current=true AND a.provider='ASAAS'
    JOIN withdrawal_request r ON r.withdrawal_intent_id=w.id AND r.site_id=w.site_id AND r.account_id=w.account_id AND r.environment=w.environment AND r.request_id=op.request_id
    WHERE op.id=$2 AND op.site_id=$1 AND op.kind='WITHDRAWAL' AND op.environment='live' AND w.request_id=op.request_id AND w.request_hash=op.request_hash`,
    [siteId, operationId],
  );
  requireCondition(result.rows.length === 1);
  return result.rows[0];
}
export async function recoverLegacyLiveWithdrawal(options: {
  siteId: string;
  operationId: string;
  expectedDigest: string;
  sourceRevision: string;
  sourceHash: string;
  now(): Date;
  transaction<T>(
    work: (tx: LegacyRecoveryTransaction) => Promise<T>,
  ): Promise<T>;
  native(
    accountId: string,
    accountReference: string,
  ): Promise<{
    accountReference: string;
    totalCount: number;
    hasMore: boolean;
    balanceCents: number;
    observedAt: string;
  }>;
  retainAudit(audit: unknown): Promise<string>;
}) {
  requireCondition(
    options.siteId === "demo-wedding" &&
      options.sourceRevision === legacyLiveDispatchRevision &&
      options.sourceHash === legacyLiveDispatchSourceHash &&
      /^[a-f0-9]{64}$/.test(options.expectedDigest),
  );
  return options.transaction(async (tx) => {
    // Same scope and row locks used by the normal withdrawal writers.
    await tx.query("SELECT id FROM site WHERE id=$1 FOR UPDATE", [
      options.siteId,
    ]);
    await tx.query(
      "SELECT id FROM receiving_account WHERE site_id=$1 AND environment='live' FOR UPDATE",
      [options.siteId],
    );
    await tx.query(
      "SELECT id FROM withdrawal_request WHERE site_id=$1 AND environment='live' FOR UPDATE",
      [options.siteId],
    );
    await tx.query(
      "SELECT id FROM withdrawal_intent WHERE site_id=$1 AND environment='live' FOR UPDATE",
      [options.siteId],
    );
    await tx.query(
      "SELECT id FROM financial_operation WHERE site_id=$1 AND environment='live' FOR UPDATE",
      [options.siteId],
    );
    const before = await readLegacyWithdrawalRecoveryCandidate(
      tx,
      options.siteId,
      options.operationId,
    );
    const now = options.now();
    requireCondition(
      Number.isFinite(+now) &&
        before.siteId === options.siteId &&
        before.operationId === options.operationId &&
        before.environment === "live" &&
        legacyWithdrawalRecoveryDigest(before) === options.expectedDigest,
    );
    requireCondition(
      before.operationState === "UNKNOWN" &&
        before.withdrawalState === "UNKNOWN" &&
        before.attempts === 1 &&
        before.requestState === "COMMITTED" &&
        before.reservationState === "HELD" &&
        before.amountCents === 300 &&
        before.reservedCents === 300,
    );
    requireCondition(
      before.providerReference === null &&
        before.providerOperationReference === null &&
        before.receiptReference === null &&
        before.resolutionObservedAt === null &&
        before.providerObservations === 0 &&
        before.authorizationCandidates === 0 &&
        before.debitEntries === 0,
    );
    requireCondition(
      typeof before.leaseOwner === "string" &&
        typeof before.leaseToken === "string" &&
        before.leaseExpiresAt !== null &&
        new Date(before.leaseExpiresAt as string).getTime() <= +now - 30000,
    );
    const native = await options.native(
      before.accountId as string,
      before.accountReference as string,
    );
    const observed = new Date(native.observedAt).getTime();
    requireCondition(
      native.accountReference === before.accountReference &&
        native.totalCount === 0 &&
        native.hasMore === false &&
        Number.isSafeInteger(native.balanceCents) &&
        native.balanceCents >= 300 &&
        observed <= +options.now() &&
        observed >= +now - 60000,
    );
    const audit = {
      reason: "LEGACY_LIVE_POST_DISABLED",
      sourceRevision: options.sourceRevision,
      sourceHash: options.sourceHash,
      frozenDigest: options.expectedDigest,
      before,
      native,
      preparedAt: options.now().toISOString(),
    };
    requireCondition(
      (await options.retainAudit(audit)) ===
        legacyWithdrawalRecoveryDigest(audit),
    );
    const withdrawal = await tx.query(
      "UPDATE withdrawal_intent SET state='REQUESTED',updated_at=$3 WHERE id=$1 AND site_id=$2 AND environment='live' AND state='UNKNOWN' AND reservation_state='HELD' AND reserved_cents=300 AND provider_reference IS NULL RETURNING id",
      [before.withdrawalId, options.siteId, now],
    );
    requireCondition(
      withdrawal.rows.length === 1 &&
        withdrawal.rows[0].id === before.withdrawalId,
    );
    const operation = await tx.query(
      "UPDATE financial_operation SET state='REQUESTED',attempts=0,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=$3,last_error_code='LEGACY_LIVE_POST_DISABLED',updated_at=$3 WHERE id=$1 AND site_id=$2 AND environment='live' AND kind='WITHDRAWAL' AND state='UNKNOWN' AND attempts=1 AND provider_operation_reference IS NULL RETURNING id",
      [before.operationId, options.siteId, now],
    );
    requireCondition(
      operation.rows.length === 1 &&
        operation.rows[0].id === before.operationId,
    );
    return {
      state: "REQUESTED" as const,
      auditDigest: legacyWithdrawalRecoveryDigest(audit),
    };
  });
}
