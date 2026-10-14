import { isDeepStrictEqual } from "node:util";
import { withdrawalPreviewSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperation,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  session,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, ADMIN_IDLE_TIMEOUT_MS } from "./authHttp";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { assertRecipientFinancialAction } from "./financialAuthorization";
import {
  readReceivingProvisioningRecord,
  readReceivingProvisioningResult,
} from "./receivingNomination";
import {
  type PreparedReceivingVerificationObservation,
  prepareReceivingVerificationObservation,
  type ReceivingVerificationAuthorization,
  type ReceivingVerificationCandidate,
  ReceivingVerificationError,
  type ReceivingVerificationFence,
  type ReceivingVerificationRepository,
  type ReceivingVerificationScope,
  readReceivingVerificationCandidate,
  readReceivingVerificationReceipt,
  readReceivingVerificationScope,
  receivingVerificationData,
  verificationIdentifier,
  verificationTimestamp,
} from "./receivingVerification";
import { resolveSiteAccess } from "./siteAccess";

type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Readonly<Record<string, unknown>>;
export type ReceivingVerificationPolicyAction =
  | "SELECT"
  | "OBSERVE"
  | "ACCOUNT_RELEASE"
  | "BANK_RELEASE"
  | "CAPABILITY_RELEASE";
export interface ReceivingVerificationRepositoryOptions {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  maxAuthAgeMs: number;
  now(): Date;
  // Approval requires trusted original identity/bank/protocol/current policy; never a browser flag.
  readCurrentPolicy?: (
    action: ReceivingVerificationPolicyAction,
    fence: ReceivingVerificationFence,
    tx: Transaction,
    value:
      | ReceivingVerificationCandidate
      | PreparedReceivingVerificationObservation
      | null,
    authorization?: ReceivingVerificationAuthorization,
  ) => Promise<boolean>;
}
function unavailable(): never {
  throw new ReceivingVerificationError();
}
function micros(value: unknown): bigint {
  return databaseTimestampEpochMicroseconds(readDatabaseTimestamp(value));
}
function copy(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return Object.freeze(value.map(copy));
  const fields = receivingVerificationData(value);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, copy(value)]),
    ),
  );
}
function readFence(value: unknown): ReceivingVerificationFence {
  const data = receivingVerificationData(value, [
    "scope",
    "account",
    "operation",
    "destinations",
    "evidence",
  ]);
  if (!Array.isArray(data.destinations) || !Array.isArray(data.evidence))
    return unavailable();
  return Object.freeze({
    scope: readReceivingVerificationScope(data.scope),
    account: copy(data.account) as Row,
    operation: copy(data.operation) as Row,
    destinations: copy(data.destinations) as readonly Row[],
    evidence: copy(data.evidence) as readonly Row[],
  });
}
function scopeRow(row: Row, scope: ReceivingVerificationScope): boolean {
  return (
    row.site_id === scope.siteId &&
    row.account_id === scope.accountId &&
    row.environment === scope.environment
  );
}
function nextVersion(fence: ReceivingVerificationFence): number {
  const maximum = Math.max(
    0,
    ...fence.destinations.map((row) => Number(row.version)),
  );
  if (!Number.isSafeInteger(maximum) || maximum >= 2147483647)
    return unavailable();
  return maximum + 1;
}
function currentDestination(
  fence: ReceivingVerificationFence,
): Row | undefined {
  return fence.destinations.find((row) => row.is_current === true);
}
function evidenceObservation(
  row: Row,
  fence: ReceivingVerificationFence,
): PreparedReceivingVerificationObservation {
  if (
    !scopeRow(row, fence.scope) ||
    row.verification_status !== "VERIFIED" ||
    row.provenance !== "PROVIDER" ||
    row.operator_reference !== fence.scope.operatorReference ||
    row.account_reference !== fence.scope.accountReference ||
    row.recipient_reference !== fence.scope.recipientReference
  )
    return unavailable();
  const destination = fence.destinations.find(
    (value) => value.version === row.destination_version,
  );
  if (!destination || destination.bank_reference !== row.bank_reference)
    return unavailable();
  const identity = readReceivingVerificationReceipt(row.verification_reference);
  const result = prepareReceivingVerificationObservation({
    kind: "OBSERVATION",
    profile: "rv1",
    verifiable: true,
    scope: fence.scope,
    destination: {
      id: String(destination.id),
      version: Number(destination.version),
      bankReference: String(destination.bank_reference),
    },
    account: {
      sourceId: identity.accountSourceId,
      sourceOrder: identity.accountSourceOrder,
      state:
        row.provider_account_state as PreparedReceivingVerificationObservation["account"]["state"],
      observedAt: verificationTimestamp(row.observed_at),
      receiving: row.receiving_capability as boolean,
      withdrawal: row.withdrawal_capability as boolean,
      commercial: row.commercial_enabled as boolean,
    },
    bank: {
      sourceId: identity.bankSourceId,
      sourceOrder: identity.bankSourceOrder,
      state:
        row.bank_state as PreparedReceivingVerificationObservation["bank"]["state"],
      observedAt:
        row.bank_observed_at === null
          ? null
          : verificationTimestamp(row.bank_observed_at),
    },
  });
  if (
    row.id !== result.evidenceId ||
    micros(row.observed_at) > micros(row.created_at) ||
    (row.bank_observed_at !== null &&
      micros(row.bank_observed_at) > micros(row.created_at))
  )
    return unavailable();
  return result;
}
function nativeObservation(
  value: PreparedReceivingVerificationObservation,
): PreparedReceivingVerificationObservation {
  const data = receivingVerificationData(value, [
    "kind",
    "profile",
    "verifiable",
    "scope",
    "destination",
    "account",
    "bank",
    "evidenceId",
    "verificationReference",
  ]);
  const { evidenceId, verificationReference, ...original } = data;
  const prepared = prepareReceivingVerificationObservation(
    original as unknown as PreparedReceivingVerificationObservation,
  );
  if (
    prepared.evidenceId !== evidenceId ||
    prepared.verificationReference !== verificationReference
  )
    return unavailable();
  return prepared;
}
function accountRank(value: unknown): number {
  return value === "APPROVED"
    ? 0
    : value === "BLOCKED" || value === "SUSPENDED"
      ? 2
      : 1;
}
function bankRank(value: unknown): number {
  return value === "VERIFIED" ? 0 : value === "REJECTED" ? 2 : 1;
}
export function createReceivingVerificationRepository(
  db: Database,
  options: ReceivingVerificationRepositoryOptions,
): ReceivingVerificationRepository {
  const deny = async (): Promise<never> => unavailable();
  const inactive = () =>
    Object.freeze({
      captureSelection: deny,
      selectDestination: deny,
      captureObservation: deny,
      appendObservation: deny,
      consultSelection: deny,
      consultObservation: deny,
    });
  let mode: "sandbox" | "live";
  let environment: ReceivingVerificationRepositoryOptions["applicationEnvironment"];
  let maxAge: number;
  let now: () => Date;
  let policy: NonNullable<
    ReceivingVerificationRepositoryOptions["readCurrentPolicy"]
  >;
  try {
    const configuredPolicy = options.readCurrentPolicy;
    if (typeof configuredPolicy !== "function") return inactive();
    mode = options.mode;
    environment = options.applicationEnvironment;
    maxAge = options.maxAuthAgeMs;
    const clock = options.now;
    if (
      !["sandbox", "live"].includes(mode) ||
      !["test", "development", "production"].includes(environment) ||
      (environment === "production" && mode !== "live") ||
      (mode === "live" && environment !== "production") ||
      !Number.isSafeInteger(maxAge) ||
      maxAge <= 0 ||
      maxAge > 300000 ||
      typeof clock !== "function"
    )
      return inactive();
    policy = configuredPolicy.bind(options);
    now = clock.bind(options);
  } catch {
    return inactive();
  }
  async function transaction<T>(
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await db.transaction(work, { isolationLevel: "read committed" });
    } catch {
      return unavailable();
    }
  }
  async function clock(tx: Transaction): Promise<bigint> {
    const result = await tx.execute(
      sql`SELECT clock_timestamp() AS "currentTime"`,
    );
    if (result.rows.length !== 1) return unavailable();
    return micros(result.rows[0].currentTime);
  }
  async function siteLock(
    tx: Transaction,
    scope: ReceivingVerificationScope,
  ): Promise<void> {
    if (scope.environment !== mode) return unavailable();
    const result = await tx.execute(
      sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${scope.siteId} FOR UPDATE OF st`,
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].siteId !== scope.siteId ||
      typeof result.rows[0].isDemo !== "boolean" ||
      (mode === "live" && result.rows[0].isDemo)
    )
      return unavailable();
  }
  async function load(
    tx: Transaction,
    input: ReceivingVerificationScope,
  ): Promise<ReceivingVerificationFence> {
    const scope = readReceivingVerificationScope(input);
    const accounts = await tx.execute(
      sql`SELECT to_jsonb(a) AS account FROM ${receivingAccount} a WHERE a.site_id=${scope.siteId} AND a.environment=${mode} ORDER BY a.id LIMIT 2 FOR UPDATE OF a`,
    );
    const operations = await tx.execute(
      sql`SELECT to_jsonb(op) AS operation FROM ${financialOperation} op WHERE op.site_id=${scope.siteId} AND op.environment=${mode} AND op.kind='ACCOUNT_CREATE' ORDER BY op.id LIMIT 2 FOR UPDATE OF op`,
    );
    if (accounts.rows.length !== 1 || operations.rows.length !== 1)
      return unavailable();
    const account = receivingVerificationData(accounts.rows[0].account),
      operation = receivingVerificationData(operations.rows[0].operation);
    if (
      account.id !== scope.accountId ||
      account.site_id !== scope.siteId ||
      account.environment !== mode ||
      account.provider !== "ASAAS" ||
      account.operator_user_id !== scope.operatorUserId ||
      account.operator_reference !== scope.operatorReference ||
      account.account_reference !== scope.accountReference ||
      account.recipient_reference !== scope.recipientReference ||
      account.is_current !== true ||
      ![
        account.receiving_capability,
        account.withdrawal_capability,
        account.commercial_enabled,
      ].every((value) => typeof value === "boolean") ||
      ![
        "UNVERIFIED",
        "ONBOARDING",
        "UNDER_REVIEW",
        "APPROVED",
        "BLOCKED",
        "SUSPENDED",
      ].includes(account.provider_account_state as string)
    )
      return unavailable();
    readReceivingProvisioningResult({
      accountReference: account.account_reference,
      recipientReference: account.recipient_reference,
      credential: {
        version: account.credential_version,
        keyId: account.credential_key_id,
        nonce: account.credential_nonce,
        ciphertext: account.credential_ciphertext,
        tag: account.credential_tag,
      },
    });
    const original = readReceivingProvisioningRecord(
        operation.request_snapshot,
      ),
      nomination = original.nomination,
      dispatch = original.provision.dispatch;
    if (
      nomination.siteId !== scope.siteId ||
      nomination.accountId !== scope.accountId ||
      nomination.operatorUserId !== scope.operatorUserId ||
      nomination.environment !== mode ||
      operation.id !== nomination.operationId ||
      operation.site_id !== scope.siteId ||
      operation.account_id !== scope.accountId ||
      operation.environment !== mode ||
      operation.kind !== "ACCOUNT_CREATE" ||
      operation.state !== "SUCCEEDED" ||
      operation.attempts !== 1 ||
      operation.request_id !== nomination.requestId ||
      operation.request_hash !== nomination.requestHash ||
      operation.provider_operation_reference !== scope.accountReference ||
      original.sealedResult !== null ||
      !dispatch.possibleDispatch ||
      operation.lease_owner !== dispatch.leaseOwner ||
      operation.lease_token !== dispatch.leaseToken ||
      micros(operation.lease_expires_at) !==
        BigInt(dispatch.leaseExpiresAtMicroseconds) ||
      operation.order_id !== null ||
      operation.payment_id !== null ||
      operation.withdrawal_intent_id !== null ||
      operation.last_error_code !== null ||
      micros(account.created_at) !== micros(nomination.createdAt) ||
      micros(operation.created_at) !== micros(nomination.createdAt) ||
      micros(operation.next_attempt_at) !== micros(nomination.createdAt)
    )
      return unavailable();
    const destinations = await tx.execute(
      sql`SELECT to_jsonb(d) AS destination FROM ${receivingDestination} d WHERE d.site_id=${scope.siteId} AND d.account_id=${scope.accountId} AND d.environment=${mode} ORDER BY d.version,d.id FOR UPDATE OF d`,
    );
    const evidence = await tx.execute(
      sql`SELECT to_jsonb(ev) AS evidence FROM ${receivingVerificationEvidence} ev WHERE ev.site_id=${scope.siteId} AND ev.account_id=${scope.accountId} AND ev.environment=${mode} ORDER BY ev.created_at,ev.id FOR UPDATE OF ev`,
    );
    const fence = readFence({
      scope,
      account,
      operation,
      destinations: destinations.rows.map((row) => row.destination),
      evidence: evidence.rows.map((row) => row.evidence),
    });
    const ids = new Set<string>(),
      versions = new Set<number>();
    for (const destination of fence.destinations) {
      const id = verificationIdentifier(destination.id),
        version = Number(destination.version);
      if (
        !scopeRow(destination, scope) ||
        ids.has(id) ||
        versions.has(version) ||
        !Number.isSafeInteger(version) ||
        version <= 0 ||
        version > 2147483647 ||
        typeof destination.is_current !== "boolean" ||
        (destination.masked_descriptor !== null &&
          !withdrawalPreviewSchema.shape.maskedDestination.safeParse(
            destination.masked_descriptor,
          ).success) ||
        !["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].includes(
          destination.bank_state as string,
        )
      )
        return unavailable();
      verificationIdentifier(destination.bank_reference);
      micros(destination.created_at);
      ids.add(id);
      versions.add(version);
    }
    const selected = fence.destinations.filter(
      (row) => row.is_current === true,
    );
    if (
      (fence.destinations.length === 0 && fence.evidence.length !== 0) ||
      (fence.destinations.length > 0 && selected.length !== 1)
    )
      return unavailable();
    if (
      scope.operatorReference === null &&
      (fence.destinations.length !== 0 ||
        fence.evidence.length !== 0 ||
        account.provider_account_state !== "UNVERIFIED" ||
        account.receiving_capability !== false ||
        account.withdrawal_capability !== false ||
        account.commercial_enabled !== false ||
        account.observed_at !== null)
    )
      return unavailable();
    const seen = new Set<string>();
    const observed = await clock(tx);
    if (
      micros(account.created_at) > observed ||
      micros(account.updated_at) > observed ||
      (account.observed_at !== null && micros(account.observed_at) > observed)
    )
      return unavailable();
    for (const row of fence.evidence) {
      const prepared = evidenceObservation(row, fence);
      if (seen.has(prepared.evidenceId) || micros(row.created_at) > observed)
        return unavailable();
      seen.add(prepared.evidenceId);
    }
    if (
      fence.evidence.length === 0 &&
      (account.provider_account_state !== "UNVERIFIED" ||
        account.receiving_capability !== false ||
        account.withdrawal_capability !== false ||
        account.commercial_enabled !== false ||
        account.observed_at !== null)
    )
      return unavailable();
    return fence;
  }
  async function approve(
    tx: Transaction,
    action: ReceivingVerificationPolicyAction,
    fence: ReceivingVerificationFence,
    value:
      | ReceivingVerificationCandidate
      | PreparedReceivingVerificationObservation
      | null,
    authorization?: ReceivingVerificationAuthorization,
  ): Promise<bigint> {
    if ((await policy(action, fence, tx, value, authorization)) !== true)
      return unavailable();
    return clock(tx);
  }
  async function authority(
    tx: Transaction,
    scope: ReceivingVerificationScope,
    input: ReceivingVerificationAuthorization,
  ) {
    const data = receivingVerificationData(input, ["actor", "recentAuth"]),
      actor = receivingVerificationData(data.actor, [
        "userId",
        "siteId",
        "sessionId",
      ]),
      proof = receivingVerificationData(data.recentAuth, [
        "userId",
        "siteId",
        "sessionId",
        "proofKind",
        "provenance",
        "verification",
        "authenticatedAt",
        "expiresAt",
      ]);
    if (
      actor.userId !== scope.operatorUserId ||
      actor.siteId !== scope.siteId ||
      proof.userId !== actor.userId ||
      proof.siteId !== actor.siteId ||
      proof.sessionId !== actor.sessionId ||
      proof.provenance !== "backend" ||
      proof.verification !== "verified" ||
      (proof.proofKind !== "PASSWORD_REAUTHENTICATION" &&
        proof.proofKind !== "MFA_REAUTHENTICATION")
    )
      return unavailable();
    verificationIdentifier(actor.sessionId);
    const authenticatedAt = micros(proof.authenticatedAt),
      expiresAt = micros(proof.expiresAt);
    if (
      expiresAt <= authenticatedAt ||
      expiresAt - authenticatedAt > 300000000n
    )
      return unavailable();
    const checkProof = (time: bigint) => {
      if (
        authenticatedAt > time ||
        time - authenticatedAt > BigInt(maxAge) * 1000n ||
        expiresAt <= time
      )
        return unavailable();
    };
    checkProof(micros(now()));
    const started = await clock(tx);
    checkProof(started);
    const users = await tx.execute(
      sql`SELECT u.id AS "userId",u.role,u.state FROM ${user} u WHERE u.id=${actor.userId} AND u.state='ACTIVE' FOR SHARE OF u`,
    );
    const currentUser = users.rows[0];
    if (
      users.rows.length !== 1 ||
      currentUser.userId !== actor.userId ||
      currentUser.state !== "ACTIVE" ||
      !["SITE_ADMIN", "SITE_ASSISTANT"].includes(currentUser.role as string)
    )
      return unavailable();
    const sessions = await tx.execute(
      sql`SELECT se.user_id AS "userId",se.id AS "sessionId",se.expires_at AS "sessionExpiresAt",se.last_active_at AS "lastActiveAt",se.created_at AS "sessionCreatedAt" FROM ${session} se WHERE se.id=${actor.sessionId} AND se.user_id=${actor.userId} FOR SHARE OF se`,
    );
    const currentSession = sessions.rows[0];
    if (
      sessions.rows.length !== 1 ||
      currentSession.userId !== actor.userId ||
      currentSession.sessionId !== actor.sessionId
    )
      return unavailable();
    const expiry = micros(currentSession.sessionExpiresAt),
      lastActive = micros(currentSession.lastActiveAt),
      created = micros(currentSession.sessionCreatedAt);
    const checkSession = (time: bigint) => {
      if (
        expiry <= time ||
        created > time ||
        lastActive > time ||
        lastActive < created ||
        time - lastActive >= BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
        time - created >= BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n
      )
        return unavailable();
    };
    checkSession(started);
    const memberships = await tx.execute(
      sql`SELECT m.id FROM ${siteMembership} m WHERE m.site_id=${scope.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR SHARE OF m`,
    );
    if (memberships.rows.length !== 1) return unavailable();
    const access = await resolveSiteAccess(tx, {
      userId: String(actor.userId),
      platformRole: currentUser.role as "SITE_ADMIN" | "SITE_ASSISTANT",
      siteId: scope.siteId,
    });
    if (
      !access ||
      access.membershipId !== memberships.rows[0].id ||
      access.membershipRole !== "SITE_ADMIN" ||
      !access.capabilities.configureReceiving
    )
      return unavailable();
    return async (
      fence: ReceivingVerificationFence,
      version: number,
      candidate: ReceivingVerificationCandidate | null,
    ): Promise<bigint> => {
      const time = await approve(tx, "SELECT", fence, candidate, input);
      if (time < started) return unavailable();
      checkProof(time);
      checkProof(micros(now()));
      checkSession(time);
      assertRecipientFinancialAction({
        action: "CONFIGURE_RECEIVING",
        siteId: scope.siteId,
        environment: mode,
        access,
        actor: {
          userId: String(actor.userId),
          siteId: String(actor.siteId),
          sessionId: String(actor.sessionId),
        },
        recipientBinding: {
          siteId: scope.siteId,
          operatorUserId: scope.operatorUserId,
          environment: mode,
          accountReference: scope.accountReference,
          recipientReference: scope.recipientReference,
          destinationVersion: version,
        },
        recentAuth: {
          userId: String(actor.userId),
          siteId: String(actor.siteId),
          sessionId: String(actor.sessionId),
          proofKind: proof.proofKind as
            | "PASSWORD_REAUTHENTICATION"
            | "MFA_REAUTHENTICATION",
          provenance: "backend",
          verification: "verified",
          authenticatedAt: readDatabaseTimestamp(proof.authenticatedAt),
          expiresAt: readDatabaseTimestamp(proof.expiresAt),
        },
        now: readDatabaseTimestamp(verificationTimestamp(time)),
        maxAuthAgeMs: maxAge,
      });
      return time;
    };
  }
  function unchanged(
    actual: ReceivingVerificationFence,
    original: ReceivingVerificationFence,
  ): void {
    if (!isDeepStrictEqual(actual, original)) unavailable();
  }
  function candidateScope(
    candidate: ReceivingVerificationCandidate,
    scope: ReceivingVerificationScope,
  ): void {
    if (
      !isDeepStrictEqual(candidate.scope, {
        ...scope,
        operatorReference:
          scope.operatorReference === null
            ? candidate.scope.operatorReference
            : scope.operatorReference,
      })
    )
      unavailable();
  }
  async function updateAccount(
    tx: Transaction,
    fence: ReceivingVerificationFence,
    changes: {
      operatorReference?: string;
      observation?: PreparedReceivingVerificationObservation;
    },
    at: bigint,
  ): Promise<void> {
    const row = fence.account,
      scope = fence.scope;
    const result = changes.observation
      ? await tx.execute(
          sql`UPDATE ${receivingAccount} a SET provider_account_state=${changes.observation.account.state},receiving_capability=${changes.observation.account.receiving},withdrawal_capability=${changes.observation.account.withdrawal},commercial_enabled=${changes.observation.account.commercial},observed_at=${changes.observation.account.observedAt}::timestamptz,updated_at=${verificationTimestamp(at)}::timestamptz WHERE id=${scope.accountId} AND site_id=${scope.siteId} AND environment=${mode} AND provider='ASAAS' AND operator_user_id=${scope.operatorUserId} AND account_reference=${scope.accountReference} AND recipient_reference=${scope.recipientReference} AND to_jsonb(a)=${JSON.stringify(row)}::jsonb RETURNING id`,
        )
      : await tx.execute(
          sql`UPDATE ${receivingAccount} a SET operator_reference=${changes.operatorReference},updated_at=${verificationTimestamp(at)}::timestamptz WHERE id=${scope.accountId} AND site_id=${scope.siteId} AND environment=${mode} AND operator_reference IS NULL AND to_jsonb(a)=${JSON.stringify(row)}::jsonb RETURNING id`,
        );
    if (result.rows.length !== 1 || result.rows[0].id !== scope.accountId)
      return unavailable();
  }
  async function updateDestination(
    tx: Transaction,
    row: Row,
    scope: ReceivingVerificationScope,
    current: boolean,
    state: string,
  ): Promise<void> {
    const result = await tx.execute(
      sql`UPDATE ${receivingDestination} d SET is_current=${current},bank_state=${state} WHERE id=${row.id} AND site_id=${scope.siteId} AND account_id=${scope.accountId} AND environment=${mode} AND version=${row.version} AND to_jsonb(d)=${JSON.stringify(row)}::jsonb RETURNING id`,
    );
    if (result.rows.length !== 1 || result.rows[0].id !== row.id)
      return unavailable();
  }
  function floors(
    fence: ReceivingVerificationFence,
    value: PreparedReceivingVerificationObservation,
  ) {
    let accountFloor = 0n,
      bankFloor = 0n;
    let accountRestriction = 0,
      bankRestriction = 0,
      receiving = true,
      withdrawal = true,
      commercial = true;
    for (const row of fence.evidence) {
      const previous = evidenceObservation(row, fence);
      const accountOrder = BigInt(previous.account.sourceOrder);
      if (accountOrder > accountFloor) {
        accountFloor = accountOrder;
        accountRestriction = accountRank(previous.account.state);
        receiving = previous.account.receiving;
        withdrawal = previous.account.withdrawal;
        commercial = previous.account.commercial;
      } else if (accountOrder === accountFloor) {
        accountRestriction = Math.max(
          accountRestriction,
          accountRank(previous.account.state),
        );
        receiving = receiving && previous.account.receiving;
        withdrawal = withdrawal && previous.account.withdrawal;
        commercial = commercial && previous.account.commercial;
      }
      if (
        previous.account.sourceId === value.account.sourceId &&
        !isDeepStrictEqual(previous.account, value.account)
      )
        return unavailable();
      if (BigInt(value.account.sourceOrder) < accountOrder)
        return unavailable();
      if (
        previous.destination.bankReference === value.destination.bankReference
      ) {
        const bankOrder =
          previous.bank.sourceOrder === null
            ? 0n
            : BigInt(previous.bank.sourceOrder);
        if (bankOrder > bankFloor) {
          bankFloor = bankOrder;
          bankRestriction = bankRank(previous.bank.state);
        } else if (bankOrder === bankFloor) {
          bankRestriction = Math.max(
            bankRestriction,
            bankRank(previous.bank.state),
          );
        }
        if (
          previous.bank.sourceId !== null &&
          previous.bank.sourceId === value.bank.sourceId &&
          !isDeepStrictEqual(previous.bank, value.bank)
        )
          return unavailable();
        if (
          (value.bank.sourceOrder === null
            ? 0n
            : BigInt(value.bank.sourceOrder)) < bankOrder
        )
          return unavailable();
      }
    }
    return {
      account: accountFloor,
      bank: bankFloor,
      accountRestriction,
      bankRestriction,
      receiving,
      withdrawal,
      commercial,
    };
  }
  return Object.freeze<ReceivingVerificationRepository>({
    async captureSelection(input, authorization) {
      const scope = readReceivingVerificationScope(input);
      return transaction(async (tx) => {
        await siteLock(tx, scope);
        const check = await authority(tx, scope, authorization);
        const fence = await load(tx, scope);
        await check(fence, nextVersion(fence), null);
        return fence;
      });
    },
    async captureObservation(input) {
      const scope = readReceivingVerificationScope(input);
      return transaction(async (tx) => {
        await siteLock(tx, scope);
        const fence = await load(tx, scope);
        if (!currentDestination(fence) || scope.operatorReference === null)
          return unavailable();
        await approve(tx, "OBSERVE", fence, null);
        return fence;
      });
    },
    async selectDestination(input, selectionId, value, authorization) {
      const original = readFence(input),
        candidate = readReceivingVerificationCandidate(value);
      verificationIdentifier(selectionId);
      candidateScope(candidate, original.scope);
      await transaction(async (tx) => {
        await siteLock(tx, original.scope);
        const check = await authority(tx, original.scope, authorization);
        const actual = await load(tx, original.scope);
        unchanged(actual, original);
        const version = nextVersion(actual),
          previous = currentDestination(actual);
        if (actual.destinations.some((row) => row.id === selectionId))
          return unavailable();
        const at = await check(actual, version, candidate);
        if (previous)
          await updateDestination(
            tx,
            previous,
            actual.scope,
            false,
            String(previous.bank_state),
          );
        if (
          actual.scope.operatorReference === null &&
          candidate.scope.operatorReference !== null
        )
          await updateAccount(
            tx,
            actual,
            { operatorReference: candidate.scope.operatorReference },
            at,
          );
        const inserted = await tx.execute(
          sql`INSERT INTO ${receivingDestination} (id,site_id,account_id,environment,version,bank_reference,masked_descriptor,bank_state,is_current,created_at) VALUES (${selectionId},${actual.scope.siteId},${actual.scope.accountId},${mode},${version},${candidate.bankReference},${candidate.maskedDescriptor},${"PENDING"},${true},${verificationTimestamp(at)}::timestamptz) RETURNING id`,
        );
        if (inserted.rows.length !== 1 || inserted.rows[0].id !== selectionId)
          return unavailable();
        await check(actual, version, candidate);
      });
    },
    async appendObservation(input, value) {
      const original = readFence(input),
        prepared = nativeObservation(value);
      if (!isDeepStrictEqual(prepared.scope, original.scope))
        return unavailable();
      await transaction(async (tx) => {
        await siteLock(tx, original.scope);
        const actual = await load(tx, original.scope);
        unchanged(actual, original);
        const destination = currentDestination(actual);
        if (
          !destination ||
          destination.id !== prepared.destination.id ||
          destination.version !== prepared.destination.version ||
          destination.bank_reference !== prepared.destination.bankReference
        )
          return unavailable();
        const old = actual.evidence.find(
          (row) => row.id === prepared.evidenceId,
        );
        if (old) {
          if (!isDeepStrictEqual(evidenceObservation(old, actual), prepared))
            return unavailable();
          await approve(tx, "OBSERVE", actual, prepared);
          return;
        }
        const floor = floors(actual, prepared),
          accountOrder = BigInt(prepared.account.sourceOrder),
          bankOrder =
            prepared.bank.sourceOrder === null
              ? 0n
              : BigInt(prepared.bank.sourceOrder);
        const account = actual.account;
        const accountRelease =
          accountRank(prepared.account.state) <
          Math.max(
            accountRank(account.provider_account_state),
            floor.accountRestriction,
          );
        const capabilityRelease =
          ((account.receiving_capability !== true || !floor.receiving) &&
            prepared.account.receiving) ||
          ((account.withdrawal_capability !== true || !floor.withdrawal) &&
            prepared.account.withdrawal) ||
          ((account.commercial_enabled !== true || !floor.commercial) &&
            prepared.account.commercial);
        const bankRelease =
          bankRank(prepared.bank.state) <
          Math.max(bankRank(destination.bank_state), floor.bankRestriction);
        if (
          (accountRelease || capabilityRelease) &&
          accountOrder <= floor.account
        )
          return unavailable();
        if (bankRelease && bankOrder <= floor.bank) return unavailable();
        let at = await approve(tx, "OBSERVE", actual, prepared);
        if (accountRelease)
          at = await approve(tx, "ACCOUNT_RELEASE", actual, prepared);
        if (capabilityRelease)
          at = await approve(tx, "CAPABILITY_RELEASE", actual, prepared);
        if (bankRelease)
          at = await approve(tx, "BANK_RELEASE", actual, prepared);
        if (
          micros(prepared.account.observedAt) > at ||
          (prepared.bank.observedAt !== null &&
            micros(prepared.bank.observedAt) > at)
        )
          return unavailable();
        if (
          account.observed_at !== null &&
          micros(prepared.account.observedAt) < micros(account.observed_at)
        )
          return unavailable();
        const tighter =
          accountRank(prepared.account.state) >
            accountRank(account.provider_account_state) ||
          (account.receiving_capability === true &&
            !prepared.account.receiving) ||
          (account.withdrawal_capability === true &&
            !prepared.account.withdrawal) ||
          (account.commercial_enabled === true &&
            !prepared.account.commercial) ||
          bankRank(prepared.bank.state) > bankRank(destination.bank_state);
        const negativeOnly =
          tighter && !accountRelease && !capabilityRelease && !bankRelease;
        const latest = actual.evidence.reduce(
          (maximum, row) =>
            micros(row.created_at) > maximum ? micros(row.created_at) : maximum,
          -1n,
        );
        if (
          latest > at ||
          (!negativeOnly && latest >= 0n && at / 1000n <= latest / 1000n)
        )
          return unavailable();
        if (
          !negativeOnly &&
          ((accountOrder === floor.account &&
            !actual.evidence.some(
              (row) =>
                evidenceObservation(row, actual).account.sourceId ===
                prepared.account.sourceId,
            )) ||
            (bankOrder !== 0n &&
              bankOrder === floor.bank &&
              !actual.evidence.some(
                (row) =>
                  evidenceObservation(row, actual).bank.sourceId ===
                  prepared.bank.sourceId,
              )))
        )
          return unavailable();
        await updateAccount(tx, actual, { observation: prepared }, at);
        await updateDestination(
          tx,
          destination,
          actual.scope,
          true,
          prepared.bank.state,
        );
        const inserted = await tx.execute(
          sql`INSERT INTO ${receivingVerificationEvidence} (id,site_id,account_id,environment,destination_version,account_reference,recipient_reference,operator_reference,bank_reference,verification_status,provenance,verification_reference,provider_account_state,bank_state,receiving_capability,withdrawal_capability,commercial_enabled,observed_at,bank_observed_at,created_at) VALUES (${prepared.evidenceId},${actual.scope.siteId},${actual.scope.accountId},${mode},${prepared.destination.version},${actual.scope.accountReference},${actual.scope.recipientReference},${actual.scope.operatorReference},${prepared.destination.bankReference},${"VERIFIED"},${"PROVIDER"},${prepared.verificationReference},${prepared.account.state},${prepared.bank.state},${prepared.account.receiving},${prepared.account.withdrawal},${prepared.account.commercial},${prepared.account.observedAt}::timestamptz,${prepared.bank.observedAt}::timestamptz,${verificationTimestamp(at)}::timestamptz) RETURNING id`,
        );
        if (
          inserted.rows.length !== 1 ||
          inserted.rows[0].id !== prepared.evidenceId
        )
          return unavailable();
        let ended = await approve(tx, "OBSERVE", actual, prepared);
        if (ended < at) return unavailable();
        for (const action of [
          accountRelease ? "ACCOUNT_RELEASE" : null,
          capabilityRelease ? "CAPABILITY_RELEASE" : null,
          bankRelease ? "BANK_RELEASE" : null,
        ] as const) {
          if (action) {
            const checked = await approve(tx, action, actual, prepared);
            if (checked < ended) return unavailable();
            ended = checked;
          }
        }
      });
    },
    async consultSelection(input, selectionId, value) {
      const original = readFence(input),
        candidate = readReceivingVerificationCandidate(value);
      candidateScope(candidate, original.scope);
      return transaction(async (tx) => {
        await siteLock(tx, candidate.scope);
        const actual = await load(tx, candidate.scope);
        const row = actual.destinations.find((row) => row.id === selectionId);
        return (
          !!row &&
          row.version === nextVersion(original) &&
          row.bank_reference === candidate.bankReference &&
          row.masked_descriptor === candidate.maskedDescriptor &&
          micros(row.created_at) >= micros(original.account.updated_at)
        );
      });
    },
    async consultObservation(value) {
      const prepared = nativeObservation(value);
      return transaction(async (tx) => {
        await siteLock(tx, prepared.scope);
        const actual = await load(tx, prepared.scope);
        const row = actual.evidence.find(
          (row) => row.id === prepared.evidenceId,
        );
        return (
          !!row && isDeepStrictEqual(evidenceObservation(row, actual), prepared)
        );
      });
    },
  });
}
