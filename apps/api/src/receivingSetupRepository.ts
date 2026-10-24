import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  receivingSetupConsentVersion,
  receivingSetupDisclosure,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { receivingSetupHolder } from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, ADMIN_IDLE_TIMEOUT_MS } from "./authHttp";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { FinancialActor } from "./financialAuthorization";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";
import type {
  ReceivingAuthenticationEvidence,
  ReceivingProvisioningRecord,
} from "./receivingNomination";
import {
  type ReceivingNominationAdmissionAuthority,
  type ReceivingNominationAdmissionContext,
  type ReceivingNominationSnapshot,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
  readReceivingProvisioningResult,
} from "./receivingNomination";

type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "execute">;
export interface ReceivingSetupHolderRecord {
  id: string;
  siteId: string;
  environment: "sandbox" | "live";
  holderUserId: string;
  holderName: string;
  designatedByUserId: string;
  designatedAt: Date;
  consentId: string | null;
  consentVersion: string | null;
  consentAt: Date | null;
  consentSessionId: string | null;
  consentAuthenticatedAt: Date | null;
}
export class ReceivingSetupError extends Error {
  constructor(
    readonly status: 403 | 409 | 503,
    readonly code: string,
  ) {
    super("Receiving setup unavailable");
  }
}
function deny(
  code = "RECEIVING_SETUP_UNAVAILABLE",
  status: 403 | 409 | 503 = 503,
): never {
  throw new ReceivingSetupError(status, code);
}
const admissionPolicy = Object.freeze({
  issuerId: "entrelacos-receiving-holder",
  issuerVersion: "1",
  disclosureId: receivingSetupDisclosure.id,
  disclosureVersion: receivingSetupConsentVersion,
});
export interface ReceivingSetupAccountRecord {
  accountId: string;
  operatorUserId: string;
  state: "REQUESTED" | "CLAIMED" | "UNKNOWN" | "SUCCEEDED";
  nomination: ReceivingNominationSnapshot;
  record: ReceivingProvisioningRecord | null;
  result: ReceivingProvisioningResult | null;
}
export interface ReceivingSetupRepositoryOptions extends LiveSitePolicy {
  mode: "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  policyVersion: string;
  maxAuthAgeMs: number;
  now(): Date;
}
export function createReceivingSetupRepository(
  db: Database,
  options: ReceivingSetupRepositoryOptions,
) {
  const { mode, applicationEnvironment, policyVersion, maxAuthAgeMs } = options;
  if (
    (mode !== "sandbox" && mode !== "live") ||
    (mode === "live" && applicationEnvironment !== "production") ||
    !policyVersion ||
    !Number.isSafeInteger(maxAuthAgeMs) ||
    maxAuthAgeMs <= 0 ||
    maxAuthAgeMs > 300000
  )
    return deny();
  const liveDemoSiteId = options.liveDemoSiteId;
  const now = options.now.bind(options);
  function clock() {
    const value = now();
    if (
      !(value instanceof Date) ||
      !Number.isSafeInteger(value.getTime()) ||
      value.getTime() < 0
    )
      return deny();
    return value;
  }
  async function readHolder(
    siteId: string,
    reader: Reader = db,
    lock = false,
  ): Promise<ReceivingSetupHolderRecord | null> {
    const result = await reader.execute(
      sql`SELECT h.id,h.site_id AS "siteId",h.environment,h.holder_user_id AS "holderUserId",u.name AS "holderName",h.designated_by_user_id AS "designatedByUserId",h.designated_at AS "designatedAt",h.consent_id AS "consentId",h.consent_version AS "consentVersion",h.consent_at AS "consentAt",h.consent_session_id AS "consentSessionId",h.consent_authenticated_at AS "consentAuthenticatedAt" FROM ${receivingSetupHolder} h INNER JOIN "user" u ON u.id=h.holder_user_id WHERE h.site_id=${siteId} AND h.environment=${mode} ${lock ? sql`FOR UPDATE OF h` : sql``}`,
    );
    if (result.rows.length > 1) return deny();
    const row = result.rows[0] as unknown as
      | ReceivingSetupHolderRecord
      | undefined;
    if (!row) return null;
    if (
      row.siteId !== siteId ||
      row.environment !== mode ||
      !row.id ||
      !row.holderUserId ||
      !row.holderName
    )
      return deny();
    try {
      return {
        ...row,
        designatedAt: readDatabaseTimestamp(row.designatedAt),
        consentAt:
          row.consentAt === null ? null : readDatabaseTimestamp(row.consentAt),
        consentAuthenticatedAt:
          row.consentAuthenticatedAt === null
            ? null
            : readDatabaseTimestamp(row.consentAuthenticatedAt),
      };
    } catch {
      return deny();
    }
  }
  async function requireHolder(
    actor: FinancialActor,
    reader: Reader = db,
    lock = false,
  ) {
    const holder = await readHolder(actor.siteId, reader, lock);
    if (!holder || holder.holderUserId !== actor.userId)
      return deny("RECEIVING_HOLDER_REQUIRED", 403);
    return holder;
  }
  function requireConsent(holder: ReceivingSetupHolderRecord) {
    if (
      !holder.consentId ||
      holder.consentVersion !== receivingSetupConsentVersion ||
      !(holder.consentAt instanceof Date) ||
      !holder.consentSessionId ||
      !(holder.consentAuthenticatedAt instanceof Date) ||
      holder.consentAt.getTime() > clock().getTime()
    )
      return deny("RECEIVING_CONSENT_REQUIRED", 403);
    return holder as ReceivingSetupHolderRecord & {
      consentId: string;
      consentAt: Date;
    };
  }
  async function currentActor(
    tx: Reader,
    actor: FinancialActor,
    owner: boolean,
  ) {
    const at = clock();
    // Keep the existing financial boundary's site, user, session, holder lock order.
    const result = await tx.execute(
      sql`SELECT u.role FROM "user" u WHERE u.id=${actor.userId} AND u.state='ACTIVE' AND u.role=${owner ? "OWNER" : "SITE_ADMIN"} FOR SHARE OF u`,
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].role !== (owner ? "OWNER" : "SITE_ADMIN")
    )
      return deny("MEMBERSHIP_DENIED", 403);
    const activeSession = await tx.execute(
      sql`SELECT s.id,s.created_at AS "createdAt",s.expires_at AS "expiresAt" FROM "session" s WHERE s.id=${actor.sessionId} AND s.user_id=${actor.userId} AND s.expires_at>${at} AND s.created_at>${new Date(at.getTime() - ADMIN_ABSOLUTE_TIMEOUT_MS)} AND s.created_at<=${at} AND s.last_active_at>${new Date(at.getTime() - ADMIN_IDLE_TIMEOUT_MS)} AND s.last_active_at<=${at} AND s.last_active_at>=s.created_at FOR SHARE OF s`,
    );
    if (
      activeSession.rows.length !== 1 ||
      activeSession.rows[0].id !== actor.sessionId
    )
      return deny("MEMBERSHIP_DENIED", 403);
    if (!owner) {
      const membership = await tx.execute(
        sql`SELECT id FROM site_membership WHERE site_id=${actor.siteId} AND user_id=${actor.userId} AND role='SITE_ADMIN' AND revoked_at IS NULL FOR UPDATE`,
      );
      if (membership.rows.length !== 1) return deny("MEMBERSHIP_DENIED", 403);
    }
    return activeSession.rows[0];
  }
  async function currentSite(tx: Reader, siteId: string) {
    const result = await tx.execute(
      sql`SELECT id,is_demo AS "isDemo" FROM site WHERE id=${siteId} FOR UPDATE`,
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].id !== siteId ||
      (mode === "live" &&
        !allowsLiveSite({
          siteId,
          isDemo: result.rows[0].isDemo as boolean,
          mode,
          applicationEnvironment,
          liveDemoSiteId: liveDemoSiteId,
        }))
    )
      return deny("PROVIDER_MODE_UNAVAILABLE", 409);
  }
  function proof(
    actor: FinancialActor,
    recentAuth: ReceivingAuthenticationEvidence,
  ) {
    const at = clock().getTime();
    const maximumAge =
      recentAuth?.proofKind === "SESSION_AUTHENTICATION"
        ? ADMIN_ABSOLUTE_TIMEOUT_MS
        : maxAuthAgeMs;
    if (
      recentAuth?.userId !== actor.userId ||
      recentAuth.siteId !== actor.siteId ||
      recentAuth.sessionId !== actor.sessionId ||
      recentAuth.provenance !== "backend" ||
      recentAuth.verification !== "verified" ||
      ![
        "PASSWORD_REAUTHENTICATION",
        "MFA_REAUTHENTICATION",
        "SESSION_AUTHENTICATION",
      ].includes(recentAuth.proofKind) ||
      !(recentAuth.authenticatedAt instanceof Date) ||
      !(recentAuth.expiresAt instanceof Date) ||
      !Number.isSafeInteger(recentAuth.authenticatedAt.getTime()) ||
      !Number.isSafeInteger(recentAuth.expiresAt.getTime()) ||
      recentAuth.expiresAt.getTime() <= recentAuth.authenticatedAt.getTime() ||
      (recentAuth.proofKind !== "SESSION_AUTHENTICATION" &&
        recentAuth.expiresAt.getTime() - recentAuth.authenticatedAt.getTime() >
          maximumAge) ||
      recentAuth.authenticatedAt.getTime() > at ||
      at - recentAuth.authenticatedAt.getTime() > maximumAge ||
      recentAuth.expiresAt.getTime() <= at
    )
      return deny("RECENT_AUTH_REQUIRED", 403);
  }
  function authority(
    holder: ReceivingSetupHolderRecord,
    context: ReceivingNominationAdmissionContext,
    issuedAt = clock().toISOString(),
  ): ReceivingNominationAdmissionAuthority {
    const accepted = requireConsent(holder);
    if (
      context.actor.userId !== accepted.holderUserId ||
      context.actor.siteId !== accepted.siteId ||
      context.draft.environment !== mode ||
      context.draft.policyVersion !== policyVersion ||
      context.applicationEnvironment !== applicationEnvironment
    )
      return deny("RECEIVING_HOLDER_REQUIRED", 403);
    return {
      ...admissionPolicy,
      version: "receiving.new-admission.v1",
      context,
      holderUserId: holder.holderUserId,
      authorityId: holder.id,
      authorityVersion: "1",
      consentId: accepted.consentId,
      consentVersion: receivingSetupConsentVersion,
      custodyId: holder.id,
      custodyVersion: "1",
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + maxAuthAgeMs).toISOString(),
    };
  }
  const admission = Object.freeze({
    ...admissionPolicy,
    async readAuthority(context: ReceivingNominationAdmissionContext) {
      return authority(await requireHolder(context.actor), context);
    },
    async lockAuthority(
      tx: Transaction,
      context: ReceivingNominationAdmissionContext,
      original: ReceivingNominationAdmissionAuthority,
    ) {
      const holder = await requireHolder(context.actor, tx, true);
      const captured = authority(holder, context, original.issuedAt);
      if (
        !isDeepStrictEqual(captured, original) ||
        Date.parse(captured.expiresAt) <= clock().getTime()
      )
        return deny();
      return captured;
    },
  });
  return Object.freeze({
    mode,
    policyVersion,
    admission,
    readHolder,
    requireHolder,
    async readSessionAuthentication(
      actor: FinancialActor,
    ): Promise<ReceivingAuthenticationEvidence> {
      return db.transaction(async (tx) => {
        await currentSite(tx, actor.siteId);
        const stored = await currentActor(tx, actor, false);
        await requireHolder(actor, tx, true);
        const evidence: ReceivingAuthenticationEvidence = Object.freeze({
          ...actor,
          proofKind: "SESSION_AUTHENTICATION",
          verification: "verified",
          provenance: "backend",
          authenticatedAt: readDatabaseTimestamp(stored.createdAt),
          expiresAt: readDatabaseTimestamp(stored.expiresAt),
        });
        proof(actor, evidence);
        return evidence;
      });
    },
    async listHolderCandidates(
      siteId: string,
    ): Promise<{ userId: string; name: string; email: string }[]> {
      const result = await db.execute(
        sql`SELECT u.id AS "userId",u.name,u.email FROM "user" u INNER JOIN site_membership m ON m.user_id=u.id WHERE m.site_id=${siteId} AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL AND u.role='SITE_ADMIN' AND u.state='ACTIVE' ORDER BY u.name,u.id`,
      );
      return result.rows as { userId: string; name: string; email: string }[];
    },
    async readAccount(
      siteId: string,
    ): Promise<ReceivingSetupAccountRecord | null> {
      const loaded = await db.execute(
        sql`SELECT a.id AS "accountId",a.operator_user_id AS "operatorUserId",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.credential_version AS "credentialVersion",a.credential_key_id AS "credentialKeyId",a.credential_nonce AS "credentialNonce",a.credential_ciphertext AS "credentialCiphertext",a.credential_tag AS "credentialTag",op.state,op.request_snapshot AS "requestSnapshot" FROM receiving_account a INNER JOIN financial_operation op ON op.account_id=a.id AND op.site_id=a.site_id AND op.environment=a.environment AND op.kind='ACCOUNT_CREATE' WHERE a.site_id=${siteId} AND a.environment=${mode} AND a.is_current=true`,
      );
      if (loaded.rows.length === 0) return null;
      if (loaded.rows.length !== 1) return deny();
      const row = loaded.rows[0];
      if (
        !["REQUESTED", "CLAIMED", "UNKNOWN", "SUCCEEDED"].includes(
          row.state as string,
        )
      )
        return deny();
      const record =
        row.state === "REQUESTED"
          ? null
          : readReceivingProvisioningRecord(row.requestSnapshot);
      const nomination =
        record?.nomination ??
        readReceivingNominationSnapshot(row.requestSnapshot);
      if (
        nomination.siteId !== siteId ||
        nomination.environment !== mode ||
        nomination.accountId !== row.accountId ||
        nomination.operatorUserId !== row.operatorUserId
      )
        return deny();
      const result =
        row.state === "SUCCEEDED"
          ? readReceivingProvisioningResult({
              accountReference: row.accountReference,
              recipientReference: row.recipientReference,
              credential: {
                version: row.credentialVersion,
                keyId: row.credentialKeyId,
                nonce: row.credentialNonce,
                ciphertext: row.credentialCiphertext,
                tag: row.credentialTag,
              },
            })
          : null;
      return {
        accountId: nomination.accountId,
        operatorUserId: nomination.operatorUserId,
        state: row.state as ReceivingSetupAccountRecord["state"],
        nomination,
        record,
        result,
      };
    },
    async designate(actor: FinancialActor, holderUserId: string) {
      return db.transaction(async (tx) => {
        await currentSite(tx, actor.siteId);
        await currentActor(tx, actor, true);
        const eligible = await tx.execute(
          sql`SELECT u.id FROM "user" u INNER JOIN site_membership m ON m.user_id=u.id AND m.site_id=${actor.siteId} WHERE u.id=${holderUserId} AND u.role='SITE_ADMIN' AND u.state='ACTIVE' AND m.role='SITE_ADMIN' AND m.revoked_at IS NULL FOR UPDATE OF u,m`,
        );
        if (eligible.rows.length !== 1 || eligible.rows[0].id !== holderUserId)
          return deny("RECEIVING_HOLDER_REQUIRED", 403);
        const existing = await readHolder(actor.siteId, tx, true);
        if (existing) {
          if (existing.holderUserId !== holderUserId)
            return deny("RECEIVING_HOLDER_ALREADY_DESIGNATED", 409);
          return;
        }
        const accounts = await tx.execute(
          sql`SELECT id FROM receiving_account WHERE site_id=${actor.siteId} AND environment=${mode} LIMIT 1`,
        );
        if (accounts.rows.length) return deny("RECEIVING_BINDING_EXISTS", 409);
        await tx.execute(
          sql`INSERT INTO ${receivingSetupHolder} (id,site_id,environment,holder_user_id,designated_by_user_id,designated_at) VALUES (${randomUUID()},${actor.siteId},${mode},${holderUserId},${actor.userId},${clock()})`,
        );
      });
    },
    async consent(
      actor: FinancialActor,
      recentAuth: ReceivingAuthenticationEvidence,
      version: string,
    ) {
      proof(actor, recentAuth);
      if (version !== receivingSetupConsentVersion)
        return deny("RECEIVING_CONSENT_REQUIRED", 403);
      return db.transaction(async (tx) => {
        await currentSite(tx, actor.siteId);
        const stored = await currentActor(tx, actor, false);
        const holder = await requireHolder(actor, tx, true);
        if (
          recentAuth.proofKind === "SESSION_AUTHENTICATION" &&
          (databaseTimestampEpochMicroseconds(recentAuth.authenticatedAt) !==
            databaseTimestampEpochMicroseconds(stored.createdAt) ||
            databaseTimestampEpochMicroseconds(recentAuth.expiresAt) !==
              databaseTimestampEpochMicroseconds(stored.expiresAt))
        )
          return deny("RECENT_AUTH_REQUIRED", 403);
        proof(actor, recentAuth);
        if (holder.consentId !== null) {
          requireConsent(holder);
          return;
        }
        await tx.execute(
          sql`UPDATE ${receivingSetupHolder} SET consent_id=${randomUUID()},consent_version=${version},consent_at=${clock()},consent_session_id=${actor.sessionId},consent_authenticated_at=${recentAuth.proofKind === "SESSION_AUTHENTICATION" ? sql`(SELECT created_at FROM "session" WHERE id=${actor.sessionId} AND user_id=${actor.userId})` : sql`${recentAuth.authenticatedAt}`} WHERE id=${holder.id} AND consent_id IS NULL`,
        );
      });
    },
    async readCurrentProvisioningPolicy(
      record: ReceivingProvisioningRecord,
      tx: Transaction,
      authorization: {
        actor: FinancialActor;
        recentAuth: ReceivingAuthenticationEvidence;
      },
    ) {
      proof(authorization.actor, authorization.recentAuth);
      const holder = requireConsent(
        await requireHolder(authorization.actor, tx, true),
      );
      return (
        holder.siteId === record.nomination.siteId &&
        holder.holderUserId === record.nomination.operatorUserId &&
        record.nomination.environment === mode &&
        record.nomination.policyVersion === policyVersion
      );
    },
  });
}
export type ReceivingSetupRepository = ReturnType<
  typeof createReceivingSetupRepository
>;
