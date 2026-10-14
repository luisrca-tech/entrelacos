import { isDeepStrictEqual } from "node:util";
import { siteAccessSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperation,
  receivingAccount,
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
import {
  ReceivingAccountProvisioningError,
  type ReceivingAccountProvisioningRepository,
  type ReceivingProvisioningObservation,
} from "./receivingAccountProvisioning";
import {
  type ReceivingNominationCurrentAuthorization,
  type ReceivingNominationSnapshot,
  type ReceivingProvisioningRecord,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
  readReceivingProvisioningResult,
} from "./receivingNomination";
import { resolveSiteAccess } from "./siteAccess";

type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
interface Options {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  maxAuthAgeMs: number;
  now(): Date;
  // Requires original parent/mode/consent/native evidence and retained key versions.
  readCurrentPolicy?: (
    record: ReceivingProvisioningRecord,
    tx: Transaction,
    authorization: ReceivingNominationCurrentAuthorization,
  ) => Promise<boolean>;
}
interface Scope {
  account: Row;
  operation: Row;
  record: ReceivingProvisioningRecord | null;
  result: ReceivingProvisioningResult | null;
}
function unavailable(): never {
  throw new ReceivingAccountProvisioningError();
}
function time(value: unknown): bigint {
  return databaseTimestampEpochMicroseconds(readDatabaseTimestamp(value));
}
function instant(value: bigint): string {
  const milliseconds = value / 1000n;
  return `${new Date(Number(milliseconds)).toISOString().slice(0, 19)}.${(value % 1000000n).toString().padStart(6, "0")}Z`;
}
const credentialFields = [
  "credential_version",
  "credential_key_id",
  "credential_nonce",
  "credential_ciphertext",
  "credential_tag",
] as const;
function unbound(account: Row): boolean {
  return (
    account.account_reference === null &&
    account.recipient_reference === null &&
    credentialFields.every((field) => account[field] === null)
  );
}
function canonicalResult(account: Row): ReceivingProvisioningResult {
  return readReceivingProvisioningResult({
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
}
function originalContext(
  actual: ReceivingProvisioningRecord,
  expected: ReceivingProvisioningRecord,
  unarmed = false,
) {
  const left = {
    ...actual.provision,
    dispatch: {
      ...actual.provision.dispatch,
      possibleDispatch: unarmed
        ? true
        : actual.provision.dispatch.possibleDispatch,
    },
  };
  if (
    !isDeepStrictEqual(actual.nomination, expected.nomination) ||
    !isDeepStrictEqual(left, expected.provision)
  )
    return unavailable();
}
export function createReceivingAccountProvisioningRepository(
  db: Database,
  options: Options,
): ReceivingAccountProvisioningRepository {
  if (
    !options ||
    !["sandbox", "live"].includes(options.mode) ||
    !["test", "development", "production"].includes(
      options.applicationEnvironment,
    ) ||
    !Number.isSafeInteger(options.maxAuthAgeMs) ||
    options.maxAuthAgeMs < 1 ||
    options.maxAuthAgeMs > 300000 ||
    typeof options.now !== "function"
  )
    return unavailable();
  const { mode, applicationEnvironment, maxAuthAgeMs, now, readCurrentPolicy } =
    options;
  async function clock(tx: Transaction): Promise<bigint> {
    const value = await tx.execute(
      sql`SELECT clock_timestamp() AS "currentTime"`,
    );
    if (value.rows.length !== 1) return unavailable();
    return time(value.rows[0].currentTime);
  }
  async function lockSite(
    tx: Transaction,
    nomination: ReceivingNominationSnapshot,
    currentAuthority: boolean,
  ): Promise<void> {
    if (nomination.environment !== mode) return unavailable();
    const locked = await tx.execute(
      sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${nomination.siteId} FOR UPDATE OF st`,
    );
    if (
      locked.rows.length !== 1 ||
      locked.rows[0].siteId !== nomination.siteId ||
      typeof locked.rows[0].isDemo !== "boolean" ||
      (currentAuthority &&
        mode === "live" &&
        (applicationEnvironment !== "production" || locked.rows[0].isDemo))
    )
      return unavailable();
  }
  async function scope(
    tx: Transaction,
    nomination: ReceivingNominationSnapshot,
    allowAbsent = false,
  ): Promise<Scope | null> {
    const accounts = await tx.execute(
      sql`SELECT to_jsonb(a) AS account FROM ${receivingAccount} a WHERE a.site_id=${nomination.siteId} AND a.environment=${mode} ORDER BY a.id LIMIT 2 FOR UPDATE OF a`,
    );
    const operations = await tx.execute(
      sql`SELECT to_jsonb(op) AS operation FROM ${financialOperation} op WHERE op.site_id=${nomination.siteId} AND op.environment=${mode} ORDER BY op.id LIMIT 2 FOR UPDATE OF op`,
    );
    if (
      allowAbsent &&
      accounts.rows.length === 0 &&
      operations.rows.length === 0
    )
      return null;
    if (accounts.rows.length !== 1 || operations.rows.length !== 1)
      return unavailable();
    const account = accounts.rows[0].account as Row;
    const operation = operations.rows[0].operation as Row;
    if (
      !account ||
      !operation ||
      account.id !== nomination.accountId ||
      account.site_id !== nomination.siteId ||
      account.environment !== mode ||
      account.provider !== "ASAAS" ||
      account.operator_user_id !== nomination.operatorUserId ||
      account.is_current !== true ||
      account.provider_account_state !== "UNVERIFIED" ||
      account.receiving_capability !== false ||
      account.withdrawal_capability !== false ||
      account.commercial_enabled !== false ||
      account.operator_reference !== null ||
      account.webhook_token_hash !== null ||
      account.observed_at !== null ||
      operation.id !== nomination.operationId ||
      operation.site_id !== nomination.siteId ||
      operation.account_id !== nomination.accountId ||
      operation.environment !== mode ||
      operation.kind !== "ACCOUNT_CREATE" ||
      operation.request_id !== nomination.requestId ||
      operation.request_hash !== nomination.requestHash ||
      operation.order_id !== null ||
      operation.payment_id !== null ||
      operation.withdrawal_intent_id !== null ||
      operation.last_error_code !== null ||
      time(account.created_at) !== time(nomination.createdAt) ||
      time(operation.created_at) !== time(nomination.createdAt) ||
      time(operation.next_attempt_at) !== time(nomination.createdAt)
    )
      return unavailable();
    if (
      !isDeepStrictEqual(
        readReceivingNominationSnapshot(operation.request_snapshot),
        nomination,
      )
    )
      return unavailable();
    if (operation.state === "REQUESTED") {
      if (
        !isDeepStrictEqual(operation.request_snapshot, nomination) ||
        operation.attempts !== 0 ||
        operation.lease_owner !== null ||
        operation.lease_token !== null ||
        operation.lease_expires_at !== null ||
        operation.provider_operation_reference !== null ||
        !unbound(account) ||
        time(account.updated_at) !== time(nomination.createdAt) ||
        time(operation.updated_at) !== time(nomination.createdAt)
      )
        return unavailable();
      return { account, operation, record: null, result: null };
    }
    const record = readReceivingProvisioningRecord(operation.request_snapshot);
    const dispatch = record.provision.dispatch;
    if (
      operation.lease_owner !== dispatch.leaseOwner ||
      operation.lease_token !== dispatch.leaseToken ||
      time(operation.lease_expires_at) !==
        BigInt(dispatch.leaseExpiresAtMicroseconds)
    )
      return unavailable();
    if (operation.state === "CLAIMED") {
      if (
        operation.attempts !== 0 ||
        dispatch.possibleDispatch ||
        record.sealedResult !== null ||
        operation.provider_operation_reference !== null ||
        !unbound(account)
      )
        return unavailable();
    } else if (operation.state === "UNKNOWN") {
      if (
        operation.attempts !== 1 ||
        !dispatch.possibleDispatch ||
        operation.provider_operation_reference !== null ||
        !unbound(account)
      )
        return unavailable();
    } else if (operation.state === "SUCCEEDED") {
      if (
        operation.attempts !== 1 ||
        !dispatch.possibleDispatch ||
        record.sealedResult !== null
      )
        return unavailable();
      const result = canonicalResult(account);
      if (operation.provider_operation_reference !== result.accountReference)
        return unavailable();
      return { account, operation, record, result };
    } else return unavailable();
    return { account, operation, record, result: record.sealedResult };
  }
  async function authority(
    tx: Transaction,
    record: ReceivingProvisioningRecord,
    incoming: ReceivingNominationCurrentAuthorization,
  ) {
    if (typeof readCurrentPolicy !== "function") return unavailable();
    const nomination = record.nomination;
    const actor = { ...incoming.actor };
    const proof = { ...incoming.recentAuth };
    const proofAt = time(proof.authenticatedAt);
    const proofExpiry = time(proof.expiresAt);
    if (
      actor.siteId !== nomination.siteId ||
      actor.userId !== nomination.operatorUserId ||
      typeof actor.sessionId !== "string" ||
      !actor.sessionId ||
      proof.userId !== actor.userId ||
      proof.siteId !== actor.siteId ||
      proof.sessionId !== actor.sessionId ||
      proof.provenance !== "backend" ||
      proof.verification !== "verified" ||
      !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
        proof.proofKind,
      ) ||
      proofExpiry <= proofAt ||
      proofExpiry - proofAt > 300000000n
    )
      return unavailable();
    const checkProof = (value: bigint) => {
      if (
        proofAt > value ||
        value - proofAt > BigInt(maxAuthAgeMs) * 1000n ||
        proofExpiry <= value
      )
        return unavailable();
    };
    checkProof(time(now()));
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
    const expires = time(currentSession.sessionExpiresAt);
    const lastActive = time(currentSession.lastActiveAt);
    const created = time(currentSession.sessionCreatedAt);
    const checkSession = (value: bigint) => {
      if (
        expires <= value ||
        lastActive > value ||
        created > value ||
        lastActive < created ||
        value - lastActive >= BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
        value - created >= BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n
      )
        return unavailable();
    };
    checkSession(started);
    const memberships = await tx.execute(
      sql`SELECT m.id FROM ${siteMembership} m WHERE m.site_id=${nomination.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR SHARE OF m`,
    );
    if (memberships.rows.length !== 1) return unavailable();
    const access = siteAccessSchema.safeParse(
      await resolveSiteAccess(tx, {
        userId: actor.userId,
        platformRole: currentUser.role as "SITE_ADMIN" | "SITE_ASSISTANT",
        siteId: nomination.siteId,
      }),
    );
    if (
      !access.success ||
      access.data.siteId !== nomination.siteId ||
      access.data.userId !== actor.userId ||
      access.data.membershipId !== memberships.rows[0].id ||
      access.data.membershipRole !== "SITE_ADMIN" ||
      !access.data.capabilities.configureReceiving
    )
      return unavailable();
    return async (
      selected: ReceivingProvisioningRecord,
      liveLease: boolean,
    ): Promise<bigint> => {
      if ((await readCurrentPolicy(selected, tx, incoming)) !== true)
        return unavailable();
      const final = await clock(tx);
      if (final < started || time(selected.nomination.createdAt) > final)
        return unavailable();
      checkProof(final);
      checkProof(time(now()));
      checkSession(final);
      if (
        liveLease &&
        BigInt(selected.provision.dispatch.leaseExpiresAtMicroseconds) <= final
      )
        return unavailable();
      return final;
    };
  }
  async function writeOperation(
    tx: Transaction,
    selected: Scope,
    next: ReceivingProvisioningRecord,
    state: "CLAIMED" | "UNKNOWN" | "SUCCEEDED",
    timestamp: bigint,
    providerReference: string | null = null,
  ) {
    const op = selected.operation;
    const nomination = next.nomination;
    const dispatch = next.provision.dispatch;
    const updated =
      await tx.execute(sql`UPDATE ${financialOperation} SET state=${state}, request_snapshot=${JSON.stringify(next)}::jsonb, attempts=${state === "CLAIMED" ? 0 : 1}, lease_owner=${dispatch.leaseOwner}, lease_token=${dispatch.leaseToken}, lease_expires_at=${instant(BigInt(dispatch.leaseExpiresAtMicroseconds))}::timestamptz, provider_operation_reference=${providerReference}, updated_at=${instant(timestamp)}::timestamptz
      WHERE id=${nomination.operationId} AND site_id=${nomination.siteId} AND account_id=${nomination.accountId} AND environment=${mode} AND kind='ACCOUNT_CREATE' AND request_id=${nomination.requestId} AND request_hash=${nomination.requestHash} AND request_snapshot=${JSON.stringify(op.request_snapshot)}::jsonb AND state=${op.state} AND attempts=${op.attempts}
      AND lease_owner IS NOT DISTINCT FROM ${op.lease_owner} AND lease_token IS NOT DISTINCT FROM ${op.lease_token} AND lease_expires_at IS NOT DISTINCT FROM ${op.lease_expires_at === null ? null : instant(time(op.lease_expires_at))}::timestamptz
      AND provider_operation_reference IS NOT DISTINCT FROM ${op.provider_operation_reference} AND order_id IS NULL AND payment_id IS NULL AND withdrawal_intent_id IS NULL RETURNING id`);
    if (
      updated.rows.length !== 1 ||
      updated.rows[0].id !== nomination.operationId
    )
      return unavailable();
  }
  async function transaction<T>(
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await db.transaction(operation, {
        isolationLevel: "read committed",
      });
    } catch {
      return unavailable();
    }
  }
  const currentTransition = async (
    input: ReceivingProvisioningRecord,
    authorization: ReceivingNominationCurrentAuthorization,
    action: "ARM" | "CONFIRM" | "ATTACH",
    result?: ReceivingProvisioningResult,
  ): Promise<void> => {
    const claim = readReceivingProvisioningRecord(input);
    if (!claim.provision.dispatch.possibleDispatch) return unavailable();
    if (action !== "ATTACH" && claim.sealedResult !== null)
      return unavailable();
    await transaction(async (tx) => {
      await lockSite(tx, claim.nomination, true);
      const check = await authority(tx, claim, authorization);
      const selected = await scope(tx, claim.nomination);
      if (!selected?.record) return unavailable();
      originalContext(selected.record, claim, action === "ARM");
      if (action === "ARM") {
        if (
          selected.operation.state !== "CLAIMED" ||
          selected.record.sealedResult !== null
        )
          return unavailable();
        const at = await check(claim, true);
        await writeOperation(tx, selected, claim, "UNKNOWN", at);
        await check(claim, true);
      } else if (action === "CONFIRM") {
        if (
          selected.operation.state !== "UNKNOWN" ||
          selected.record.sealedResult !== null ||
          !unbound(selected.account)
        )
          return unavailable();
        await check(claim, true);
      } else {
        const prepared = readReceivingProvisioningResult(result);
        if (selected.operation.state === "SUCCEEDED") {
          if (!isDeepStrictEqual(selected.result, prepared))
            return unavailable();
          await check(selected.record, false);
          return;
        }
        if (
          selected.operation.state !== "UNKNOWN" ||
          !isDeepStrictEqual(selected.record.sealedResult, prepared)
        )
          return unavailable();
        const at = await check(selected.record, false);
        const credentials = prepared.credential;
        const nomination = claim.nomination;
        const updated =
          await tx.execute(sql`UPDATE ${receivingAccount} SET account_reference=${prepared.accountReference}, recipient_reference=${prepared.recipientReference}, credential_version=${credentials.version}, credential_key_id=${credentials.keyId}, credential_nonce=${credentials.nonce}, credential_ciphertext=${credentials.ciphertext}, credential_tag=${credentials.tag}, updated_at=${instant(at)}::timestamptz
          WHERE id=${nomination.accountId} AND site_id=${nomination.siteId} AND environment=${mode} AND provider='ASAAS' AND operator_user_id=${nomination.operatorUserId} AND is_current=true AND provider_account_state='UNVERIFIED' AND receiving_capability=false AND withdrawal_capability=false AND commercial_enabled=false AND operator_reference IS NULL AND webhook_token_hash IS NULL AND observed_at IS NULL
          AND account_reference IS NULL AND recipient_reference IS NULL AND credential_version IS NULL AND credential_key_id IS NULL AND credential_nonce IS NULL AND credential_ciphertext IS NULL AND credential_tag IS NULL RETURNING id`);
        if (
          updated.rows.length !== 1 ||
          updated.rows[0].id !== nomination.accountId
        )
          return unavailable();
        const attached = readReceivingProvisioningRecord({
          ...selected.record,
          sealedResult: null,
        });
        await writeOperation(
          tx,
          selected,
          attached,
          "SUCCEEDED",
          at,
          prepared.accountReference,
        );
        await check(attached, false);
      }
    });
  };
  return Object.freeze<ReceivingAccountProvisioningRepository>({
    async claimOriginal(input, authorization) {
      const nomination = readReceivingNominationSnapshot(input.nomination);
      const draft = readReceivingProvisioningRecord({
        version: "receiving.account-provisioning.v1",
        nomination,
        provision: {
          ...input.provision,
          dispatch: {
            leaseOwner: input.leaseOwner,
            leaseToken: input.leaseToken,
            leaseExpiresAtMicroseconds: (time(now()) + 60000000n).toString(),
            possibleDispatch: false,
          },
        },
        sealedResult: null,
      });
      return transaction(async (tx) => {
        await lockSite(tx, nomination, true);
        const check = await authority(tx, draft, authorization);
        const selected = await scope(tx, nomination);
        if (selected?.operation.state !== "REQUESTED" || selected.record)
          return unavailable();
        const at = await check(draft, false);
        const claim = readReceivingProvisioningRecord({
          ...draft,
          provision: {
            ...draft.provision,
            dispatch: {
              ...draft.provision.dispatch,
              leaseExpiresAtMicroseconds: (at + 60000000n).toString(),
            },
          },
        });
        await writeOperation(tx, selected, claim, "CLAIMED", at);
        await check(claim, true);
        return claim;
      });
    },
    armOriginal: (claim, authorization) =>
      currentTransition(claim, authorization, "ARM"),
    confirmOriginalArmForDispatch: (claim, authorization) =>
      currentTransition(claim, authorization, "CONFIRM"),
    attachOriginal: (claim, result, authorization) =>
      currentTransition(claim, authorization, "ATTACH", result),
    async quarantineOriginal(input, result) {
      const claim = readReceivingProvisioningRecord(input);
      const prepared = readReceivingProvisioningResult(result);
      if (!claim.provision.dispatch.possibleDispatch) return unavailable();
      await transaction(async (tx) => {
        await lockSite(tx, claim.nomination, false);
        const selected = await scope(tx, claim.nomination);
        if (!selected?.record || selected.operation.state !== "UNKNOWN")
          return unavailable();
        originalContext(selected.record, claim);
        if (selected.record.sealedResult) {
          if (!isDeepStrictEqual(selected.record.sealedResult, prepared))
            return unavailable();
          return;
        }
        const retained = readReceivingProvisioningRecord({
          ...selected.record,
          sealedResult: prepared,
        });
        await writeOperation(
          tx,
          selected,
          retained,
          "UNKNOWN",
          await clock(tx),
        );
      });
    },
    async consultOriginal(
      input,
      expected,
    ): Promise<ReceivingProvisioningObservation | null> {
      const claim = readReceivingProvisioningRecord(input);
      const expectedResult =
        expected === null ? null : readReceivingProvisioningResult(expected);
      return transaction(async (tx) => {
        await lockSite(tx, claim.nomination, false);
        const selected = await scope(tx, claim.nomination, true);
        if (!selected) return null;
        if (!selected.record) return unavailable();
        originalContext(selected.record, claim);
        if (
          expectedResult &&
          !isDeepStrictEqual(expectedResult, selected.result)
        )
          return unavailable();
        return Object.freeze({
          record: selected.record,
          state: selected.operation
            .state as ReceivingProvisioningObservation["state"],
          result: selected.result,
        });
      });
    },
  });
}
