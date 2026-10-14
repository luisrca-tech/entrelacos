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
  deriveReceivingNominationRequestId,
  type ReceivingNominationCurrentAuthorization,
  type ReceivingNominationRepository,
  type ReceivingNominationScope,
  ReceivingNominationServiceError,
  type ReceivingNominationSnapshot,
  readReceivingNominationSnapshot,
} from "./receivingNomination";
import { resolveSiteAccess } from "./siteAccess";

type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Reader = Pick<Database, "execute">;
interface Options {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  maxAuthAgeMs: number;
  now(): Date;
}
function fail(
  status: 403 | 409 | 503 = 503,
  code: ReceivingNominationServiceError["code"] = "RECEIVING_NOMINATION_UNAVAILABLE",
): never {
  throw new ReceivingNominationServiceError(status, code);
}
function timestamp(value: unknown): bigint {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()))
    fail();
  return databaseTimestampEpochMicroseconds(value);
}

async function find(
  reader: Reader,
  siteId: string,
  requestId: string,
  lock = false,
): Promise<ReceivingNominationSnapshot | null> {
  const result =
    await reader.execute(sql`SELECT op.id,op.site_id AS "siteId",op.account_id AS "accountId",op.environment,op.kind,op.state,op.request_id AS "requestId",op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",
    a.operator_user_id AS "accountOperatorUserId",a.site_id AS "accountSiteId",a.environment AS "accountEnvironment",a.provider AS "accountProvider"
    FROM ${financialOperation} op INNER JOIN ${receivingAccount} a ON a.id=op.account_id AND a.site_id=op.site_id AND a.environment=op.environment
    WHERE op.site_id=${siteId} AND op.kind='ACCOUNT_CREATE' AND op.request_id=${requestId} ${lock ? sql`FOR UPDATE OF op,a` : sql``}`);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) fail();
  const row = result.rows[0];
  const snapshot = readReceivingNominationSnapshot(row.requestSnapshot);
  if (
    row.id !== snapshot.operationId ||
    row.accountId !== snapshot.accountId ||
    row.siteId !== siteId ||
    row.requestId !== requestId ||
    snapshot.siteId !== siteId ||
    snapshot.requestId !== requestId ||
    row.kind !== "ACCOUNT_CREATE" ||
    row.environment !== snapshot.environment ||
    row.requestHash !== snapshot.requestHash ||
    row.accountOperatorUserId !== snapshot.operatorUserId ||
    row.accountSiteId !== siteId ||
    row.accountEnvironment !== snapshot.environment ||
    row.accountProvider !== "ASAAS"
  )
    fail();
  if (row.state !== "REQUESTED") fail(409, "RECEIVING_BINDING_EXISTS");
  return snapshot;
}

async function readScope(
  reader: Reader,
  selected: ReceivingNominationScope,
  databaseTime: bigint,
): Promise<ReceivingNominationSnapshot | null> {
  // Inspect both sides before filtering operator/current/kind. An orphan or
  // historical row must never become permission to create a new recipient.
  const result = await reader.execute(sql`SELECT
    (a.operator_reference IS NOT NULL OR a.webhook_token_hash IS NOT NULL OR a.account_reference IS NOT NULL OR a.recipient_reference IS NOT NULL
     OR a.credential_version IS NOT NULL OR a.credential_key_id IS NOT NULL OR a.credential_nonce IS NOT NULL OR a.credential_ciphertext IS NOT NULL OR a.credential_tag IS NOT NULL
     OR a.provider_account_state<>'UNVERIFIED' OR a.receiving_capability OR a.withdrawal_capability OR a.commercial_enabled OR a.observed_at IS NOT NULL) AS "hasProviderBinding",
    a.id AS "accountId",a.site_id AS "accountSiteId",a.environment AS "accountEnvironment",a.provider AS "accountProvider",a.operator_user_id AS "operatorUserId",a.is_current AS "isCurrent",a.created_at AS "accountCreatedAt",a.updated_at AS "accountUpdatedAt",
    op.id AS "operationId",op.site_id AS "operationSiteId",op.account_id AS "operationAccountId",op.environment AS "operationEnvironment",op.kind AS "kind",op.state AS "state",op.request_id AS "requestId",op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",
    op.order_id AS "orderId",op.payment_id AS "paymentId",op.withdrawal_intent_id AS "withdrawalIntentId",op.provider_operation_reference AS "providerOperationReference",op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",op.attempts AS "attempts",op.last_error_code AS "lastErrorCode",op.next_attempt_at AS "nextAttemptAt",op.created_at AS "operationCreatedAt",op.updated_at AS "operationUpdatedAt"
    FROM ${receivingAccount} a FULL OUTER JOIN ${financialOperation} op ON op.account_id=a.id AND op.site_id=a.site_id AND op.environment=a.environment
    WHERE (a.site_id=${selected.siteId} AND a.environment=${selected.environment}) OR (op.site_id=${selected.siteId} AND op.environment=${selected.environment})
    ORDER BY a.id,op.id LIMIT 2`);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) fail(409, "RECEIVING_BINDING_EXISTS");
  const row = result.rows[0];
  if (
    row.accountId === null ||
    row.operationId === null ||
    row.accountSiteId !== selected.siteId ||
    row.accountEnvironment !== selected.environment ||
    row.accountProvider !== "ASAAS" ||
    typeof row.hasProviderBinding !== "boolean" ||
    typeof row.isCurrent !== "boolean"
  )
    fail();
  if (row.hasProviderBinding || !row.isCurrent)
    fail(409, "RECEIVING_BINDING_EXISTS");
  if (row.operatorUserId !== selected.operatorUserId)
    fail(409, "RECIPIENT_CONFLICT");
  const snapshot = readReceivingNominationSnapshot(row.requestSnapshot);
  if (row.kind !== "ACCOUNT_CREATE" || row.state !== "REQUESTED")
    fail(409, "RECEIVING_BINDING_EXISTS");
  if (
    snapshot.siteId !== selected.siteId ||
    snapshot.operatorUserId !== selected.operatorUserId ||
    snapshot.environment !== selected.environment ||
    row.accountId !== snapshot.accountId ||
    row.operationId !== snapshot.operationId ||
    row.operationSiteId !== selected.siteId ||
    row.operationAccountId !== snapshot.accountId ||
    row.operationEnvironment !== selected.environment ||
    row.requestId !== snapshot.requestId ||
    row.requestHash !== snapshot.requestHash ||
    row.orderId !== null ||
    row.paymentId !== null ||
    row.withdrawalIntentId !== null ||
    row.providerOperationReference !== null ||
    row.leaseOwner !== null ||
    row.leaseToken !== null ||
    row.leaseExpiresAt !== null ||
    row.attempts !== 0 ||
    row.lastErrorCode !== null
  )
    fail();
  const originalTime = timestamp(new Date(snapshot.createdAt));
  if (originalTime > databaseTime) fail();
  // An untouched local REQUESTED intent has one immutable creation timestamp.
  // Compare driver dates at full precision rather than their public ISO millis.
  for (const field of [
    "accountCreatedAt",
    "accountUpdatedAt",
    "operationCreatedAt",
    "operationUpdatedAt",
    "nextAttemptAt",
  ]) {
    if (timestamp(readDatabaseTimestamp(row[field])) !== originalTime) fail();
  }
  return snapshot;
}

export function createReceivingNominationRepository(
  db: Database,
  options: Options,
): ReceivingNominationRepository {
  if (
    !["sandbox", "live"].includes(options.mode) ||
    !["test", "development", "production"].includes(
      options.applicationEnvironment,
    ) ||
    !Number.isSafeInteger(options.maxAuthAgeMs) ||
    options.maxAuthAgeMs < 1 ||
    options.maxAuthAgeMs > 300000 ||
    typeof options.now !== "function"
  )
    fail();
  const { mode, applicationEnvironment, maxAuthAgeMs, now } = options;
  return {
    async readNominationScope(input) {
      try {
        deriveReceivingNominationRequestId(input);
        const selected = { ...input };
        if (
          selected.environment !== mode ||
          (mode === "live" && applicationEnvironment !== "production")
        )
          fail(409, "PROVIDER_MODE_UNAVAILABLE");
        const startedAt = timestamp(now());
        return await db.transaction(
          async (tx) => {
            const sites = await tx.execute(
              sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo",clock_timestamp() AS "currentTime" FROM ${site} st WHERE st.id=${selected.siteId}`,
            );
            const storedSite = sites.rows[0];
            if (
              sites.rows.length !== 1 ||
              storedSite.siteId !== selected.siteId ||
              typeof storedSite.isDemo !== "boolean"
            )
              fail();
            if (mode === "live" && storedSite.isDemo)
              fail(409, "PROVIDER_MODE_UNAVAILABLE");
            const databaseTime = timestamp(
              readDatabaseTimestamp(storedSite.currentTime),
            );
            const snapshot = await readScope(tx, selected, databaseTime);
            const finishedAt = timestamp(now());
            if (finishedAt < startedAt || databaseTime > finishedAt) fail();
            return snapshot;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (error instanceof ReceivingNominationServiceError) throw error;
        return fail();
      }
    },
    async findByRequest(siteId, requestId) {
      try {
        return await find(db, siteId, requestId);
      } catch (e) {
        if (e instanceof ReceivingNominationServiceError) throw e;
        return fail();
      }
    },
    async reserveNomination(input, authorize, currentAuthorization) {
      try {
        const snapshot = readReceivingNominationSnapshot(input);
        const authorization = structuredClone(
          currentAuthorization,
        ) as ReceivingNominationCurrentAuthorization;
        const actor = Object.freeze({ ...authorization.actor });
        const proof = authorization.recentAuth;
        const proofAt = timestamp(proof.authenticatedAt);
        const proofExpiry = timestamp(proof.expiresAt);
        if (
          snapshot.environment !== mode ||
          (mode === "live" && applicationEnvironment !== "production")
        )
          fail(409, "PROVIDER_MODE_UNAVAILABLE");
        if (
          actor.siteId !== snapshot.siteId ||
          actor.userId !== snapshot.operatorUserId ||
          proof.siteId !== actor.siteId ||
          proof.userId !== actor.userId ||
          proof.sessionId !== actor.sessionId ||
          proof.provenance !== "backend" ||
          proof.verification !== "verified" ||
          !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
            proof.proofKind,
          ) ||
          proofExpiry <= proofAt ||
          proofExpiry - proofAt > 300000000n ||
          typeof authorize !== "function"
        )
          fail(403, "RECENT_AUTH_REQUIRED");
        const requireProofTime = (clock: bigint) => {
          if (
            proofAt > clock ||
            clock - proofAt > BigInt(maxAuthAgeMs) * 1000n ||
            proofExpiry <= clock
          )
            fail(403, "RECENT_AUTH_REQUIRED");
        };
        requireProofTime(timestamp(now()));
        return await db.transaction(
          async (tx) => {
            const lockedSite = await tx.execute(
              sql`SELECT st.id AS "siteId",st.is_demo AS "isDemo" FROM ${site} st WHERE st.id=${snapshot.siteId} FOR UPDATE OF st`,
            );
            if (
              lockedSite.rows.length !== 1 ||
              lockedSite.rows[0].siteId !== snapshot.siteId ||
              typeof lockedSite.rows[0].isDemo !== "boolean"
            )
              fail();
            if (mode === "live" && lockedSite.rows[0].isDemo)
              fail(409, "PROVIDER_MODE_UNAVAILABLE");
            const clock = await tx.execute(
              sql`SELECT clock_timestamp() AS "currentTime"`,
            );
            if (clock.rows.length !== 1) fail();
            const databaseTime = timestamp(
              readDatabaseTimestamp(clock.rows[0].currentTime),
            );
            requireProofTime(databaseTime);
            // Account revocation locks user before deleting sessions. Keep the
            // same explicit order rather than relying on joined row marks.
            const users = await tx.execute(
              sql`SELECT u.id AS "userId",u.role,u.state FROM ${user} u WHERE u.id=${actor.userId} AND u.state='ACTIVE' FOR SHARE OF u`,
            );
            const currentUser = users.rows[0];
            if (
              users.rows.length !== 1 ||
              currentUser.userId !== actor.userId ||
              currentUser.state !== "ACTIVE" ||
              currentUser.role === "OWNER" ||
              !["SITE_ADMIN", "SITE_ASSISTANT"].includes(
                currentUser.role as string,
              )
            )
              fail(403, "MEMBERSHIP_DENIED");
            const sessions =
              await tx.execute(sql`SELECT se.user_id AS "userId",se.id AS "sessionId",se.expires_at AS "sessionExpiresAt",se.last_active_at AS "lastActiveAt",se.created_at AS "sessionCreatedAt"
              FROM ${session} se WHERE se.id=${actor.sessionId} AND se.user_id=${actor.userId} FOR SHARE OF se`);
            const rawSession = sessions.rows[0];
            const current = rawSession
              ? {
                  userId: rawSession.userId,
                  sessionId: rawSession.sessionId,
                  state: currentUser.state,
                  role: currentUser.role,
                  sessionExpiresAt: readDatabaseTimestamp(
                    rawSession.sessionExpiresAt,
                  ),
                  lastActiveAt: readDatabaseTimestamp(rawSession.lastActiveAt),
                  sessionCreatedAt: readDatabaseTimestamp(
                    rawSession.sessionCreatedAt,
                  ),
                }
              : null;
            const requireSessionTime = (clock: bigint) => {
              if (
                !current ||
                timestamp(current.sessionExpiresAt) <= clock ||
                timestamp(current.lastActiveAt) > clock ||
                clock - timestamp(current.lastActiveAt) >=
                  BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n ||
                timestamp(current.sessionCreatedAt) > clock ||
                clock - timestamp(current.sessionCreatedAt) >=
                  BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n
              )
                fail(403, "MEMBERSHIP_DENIED");
            };
            if (
              sessions.rows.length !== 1 ||
              current === null ||
              current.userId !== actor.userId ||
              current.sessionId !== actor.sessionId ||
              current.state !== "ACTIVE" ||
              current.role === "OWNER" ||
              !["SITE_ADMIN", "SITE_ASSISTANT"].includes(current.role as string)
            )
              fail(403, "MEMBERSHIP_DENIED");
            requireSessionTime(databaseTime);
            const membership = await tx.execute(
              sql`SELECT m.id FROM ${siteMembership} m WHERE m.site_id=${snapshot.siteId} AND m.user_id=${actor.userId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR SHARE OF m`,
            );
            if (membership.rows.length !== 1) fail(403, "MEMBERSHIP_DENIED");
            const access = siteAccessSchema.safeParse(
              await resolveSiteAccess(tx, {
                userId: actor.userId,
                platformRole: current.role as "SITE_ADMIN" | "SITE_ASSISTANT",
                siteId: snapshot.siteId,
              }),
            );
            if (
              !access.success ||
              access.data.siteId !== snapshot.siteId ||
              access.data.userId !== actor.userId ||
              access.data.membershipRole !== "SITE_ADMIN" ||
              access.data.membershipId !== membership.rows[0].id ||
              !access.data.capabilities.configureReceiving
            )
              fail(403, "MEMBERSHIP_DENIED");
            const accounts =
              await tx.execute(sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.is_current AS "isCurrent",
      (a.operator_reference IS NOT NULL OR a.webhook_token_hash IS NOT NULL OR a.account_reference IS NOT NULL OR a.recipient_reference IS NOT NULL OR a.credential_version IS NOT NULL OR a.provider_account_state<>'UNVERIFIED'
       OR a.receiving_capability OR a.withdrawal_capability OR a.commercial_enabled OR a.observed_at IS NOT NULL) AS "hasProviderBinding"
      FROM ${receivingAccount} a WHERE a.site_id=${snapshot.siteId} AND a.environment=${mode} ORDER BY a.id LIMIT 2 FOR UPDATE OF a`);
            if (accounts.rows.length > 1) fail(409, "RECEIVING_BINDING_EXISTS");
            const account = accounts.rows[0];
            if (
              account &&
              (account.siteId !== snapshot.siteId ||
                account.environment !== mode ||
                account.provider !== "ASAAS" ||
                typeof account.hasProviderBinding !== "boolean")
            )
              fail();
            if (account?.hasProviderBinding)
              fail(409, "RECEIVING_BINDING_EXISTS");
            if (account && account.operatorUserId !== actor.userId)
              fail(409, "RECIPIENT_CONFLICT");
            const previous = await find(
              tx,
              snapshot.siteId,
              snapshot.requestId,
              true,
            );
            if (previous && !isDeepStrictEqual(previous, snapshot))
              fail(409, "REQUEST_CONFLICT");
            if (
              account &&
              (!previous ||
                account.id !== snapshot.accountId ||
                account.isCurrent !== true)
            )
              fail(409, "RECIPIENT_CONFLICT");
            if (previous && !account) fail();
            if (
              (await authorize({
                access: access.data,
                currentSession: actor,
                designatedOperatorUserId: account
                  ? (account.operatorUserId as string)
                  : null,
                hasProviderBinding: account?.hasProviderBinding === true,
              })) !== undefined
            )
              fail();
            const final = await tx.execute(
              sql`SELECT clock_timestamp() AS "currentTime"`,
            );
            if (final.rows.length !== 1) fail();
            const finalTime = timestamp(
              readDatabaseTimestamp(final.rows[0].currentTime),
            );
            if (finalTime < databaseTime) fail();
            requireProofTime(finalTime);
            requireProofTime(timestamp(now()));
            requireSessionTime(finalTime);
            if (previous) return previous;
            if (
              !account &&
              snapshot.requestId !==
                deriveReceivingNominationRequestId({
                  siteId: snapshot.siteId,
                  operatorUserId: snapshot.operatorUserId,
                  environment: snapshot.environment,
                })
            )
              fail(409, "REQUEST_CONFLICT");
            if (BigInt(Date.parse(snapshot.createdAt)) * 1000n > finalTime)
              fail();
            const createdAt = new Date(snapshot.createdAt);
            const savedAccount = await tx
              .insert(receivingAccount)
              .values({
                id: snapshot.accountId,
                siteId: snapshot.siteId,
                environment: mode,
                provider: "ASAAS",
                operatorUserId: actor.userId,
                operatorReference: null,
                accountReference: null,
                recipientReference: null,
                providerAccountState: "UNVERIFIED",
                receivingCapability: false,
                withdrawalCapability: false,
                commercialEnabled: false,
                isCurrent: true,
                credentialVersion: null,
                credentialKeyId: null,
                credentialNonce: null,
                credentialCiphertext: null,
                credentialTag: null,
                webhookTokenHash: null,
                observedAt: null,
                createdAt,
                updatedAt: createdAt,
              })
              .returning({ id: receivingAccount.id });
            if (
              savedAccount.length !== 1 ||
              savedAccount[0].id !== snapshot.accountId
            )
              fail();
            const savedOperation = await tx
              .insert(financialOperation)
              .values({
                id: snapshot.operationId,
                siteId: snapshot.siteId,
                accountId: snapshot.accountId,
                environment: mode,
                kind: "ACCOUNT_CREATE",
                state: "REQUESTED",
                requestId: snapshot.requestId,
                requestHash: snapshot.requestHash,
                requestSnapshot: snapshot as unknown as Record<string, unknown>,
                orderId: null,
                withdrawalIntentId: null,
                paymentId: null,
                providerOperationReference: null,
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                attempts: 0,
                nextAttemptAt: createdAt,
                lastErrorCode: null,
                createdAt,
                updatedAt: createdAt,
              })
              .returning({ id: financialOperation.id });
            if (
              savedOperation.length !== 1 ||
              savedOperation[0].id !== snapshot.operationId
            )
              fail();
            const committedClock = await tx.execute(
              sql`SELECT clock_timestamp() AS "currentTime"`,
            );
            if (committedClock.rows.length !== 1) fail();
            const committedTime = timestamp(
              readDatabaseTimestamp(committedClock.rows[0].currentTime),
            );
            if (committedTime < finalTime) fail();
            requireProofTime(committedTime);
            requireProofTime(timestamp(now()));
            requireSessionTime(committedTime);
            return snapshot;
          },
          { isolationLevel: "read committed" },
        );
      } catch (e) {
        if (e instanceof ReceivingNominationServiceError) throw e;
        return fail();
      }
    },
  };
}
