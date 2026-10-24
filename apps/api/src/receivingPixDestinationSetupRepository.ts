import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  receivingPixDestinationRecentSchema,
  receivingSetupConsentVersion,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, ADMIN_IDLE_TIMEOUT_MS } from "./authHttp";
import { readDatabaseTimestamp } from "./databaseTimestamp";
import {
  assertFinancialReadAccess,
  assertRecipientFinancialAction,
  type FinancialActor,
} from "./financialAuthorization";
import { allowsLiveSite } from "./liveSitePolicy";
import {
  assertReceivingPixSetupProof,
  type ReceivingPixDestinationRecord,
  type ReceivingPixDestinationSave,
  ReceivingPixDestinationSetupError,
  type ReceivingPixDestinationSetupRepository,
  type ReceivingPixDestinationSnapshot,
} from "./receivingPixDestinationSetup";
import { resolveSiteAccess } from "./siteAccess";

type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
function deny(
  code = "PIX_DESTINATION_UNAVAILABLE",
  status: 403 | 409 | 503 = 409,
): never {
  throw new ReceivingPixDestinationSetupError(status, code);
}
export function createReceivingPixDestinationSetupRepository(
  db: Database,
  options: {
    liveDemoSiteId?: string;
    mode: "sandbox" | "live";
    applicationEnvironment: "development" | "test" | "production";
    now(): Date;
    maxAuthAgeMs?: number;
    generateId?(): string;
  },
): ReceivingPixDestinationSetupRepository {
  const { mode, applicationEnvironment } = options;
  const maxAge = options.maxAuthAgeMs ?? 300000;
  if (
    (mode !== "sandbox" && mode !== "live") ||
    (mode === "live") !== (applicationEnvironment === "production") ||
    !Number.isSafeInteger(maxAge) ||
    maxAge < 1 ||
    maxAge > 300000
  )
    return deny();
  const liveDemoSiteId = options.liveDemoSiteId;
  const now = options.now.bind(options),
    generateId = options.generateId ?? randomUUID;
  async function clock(tx: Transaction) {
    const rows = await tx.execute(
      sql`SELECT clock_timestamp() AS "currentTime"`,
    );
    if (rows.rows.length !== 1) return deny();
    return readDatabaseTimestamp(rows.rows[0].currentTime);
  }
  async function load(
    tx: Transaction,
    actor: FinancialActor,
    readOnly: boolean,
  ) {
    const sites = await tx.execute(
      sql`SELECT id,is_demo AS "isDemo" FROM site WHERE id=${actor.siteId} ${readOnly ? sql`` : sql`FOR UPDATE`}`,
    );
    if (
      sites.rows.length !== 1 ||
      sites.rows[0].id !== actor.siteId ||
      (mode === "live" &&
        !allowsLiveSite({
          siteId: actor.siteId,
          isDemo: sites.rows[0].isDemo as boolean,
          mode,
          applicationEnvironment,
          liveDemoSiteId: liveDemoSiteId,
        }))
    )
      return deny();
    const users = await tx.execute(
      sql`SELECT id AS "userId",role,state FROM "user" WHERE id=${actor.userId} AND state='ACTIVE' FOR SHARE`,
    );
    const user = users.rows[0];
    if (
      users.rows.length !== 1 ||
      user.userId !== actor.userId ||
      user.state !== "ACTIVE" ||
      !(readOnly ? ["OWNER", "SITE_ADMIN"] : ["SITE_ADMIN"]).includes(
        String(user.role),
      )
    )
      return deny("MEMBERSHIP_DENIED", 403);
    const sessions = await tx.execute(
      sql`SELECT user_id AS "userId",id AS "sessionId",created_at AS "createdAt",expires_at AS "expiresAt",last_active_at AS "lastActiveAt" FROM "session" WHERE id=${actor.sessionId} AND user_id=${actor.userId} FOR SHARE`,
    );
    const session = sessions.rows[0];
    if (
      sessions.rows.length !== 1 ||
      session.userId !== actor.userId ||
      session.sessionId !== actor.sessionId
    )
      return deny("MEMBERSHIP_DENIED", 403);
    const created = readDatabaseTimestamp(session.createdAt).getTime(),
      expires = readDatabaseTimestamp(session.expiresAt).getTime(),
      lastActive = readDatabaseTimestamp(session.lastActiveAt).getTime();
    const checkSession = (at: Date) => {
      const value = at.getTime();
      if (
        expires <= value ||
        created > value ||
        lastActive > value ||
        lastActive < created ||
        value - created >= ADMIN_ABSOLUTE_TIMEOUT_MS ||
        value - lastActive >= ADMIN_IDLE_TIMEOUT_MS
      )
        return deny("MEMBERSHIP_DENIED", 403);
    };
    const started = await clock(tx);
    checkSession(started);
    let membershipId: unknown = null;
    if (user.role !== "OWNER") {
      const memberships = await tx.execute(
        sql`SELECT id FROM site_membership WHERE site_id=${actor.siteId} AND user_id=${actor.userId} AND role='SITE_ADMIN' AND revoked_at IS NULL FOR SHARE`,
      );
      if (memberships.rows.length !== 1) return deny("MEMBERSHIP_DENIED", 403);
      membershipId = memberships.rows[0].id;
    }
    const access = await resolveSiteAccess(tx, {
      userId: actor.userId,
      platformRole: user.role as "OWNER" | "SITE_ADMIN",
      siteId: actor.siteId,
    });
    assertFinancialReadAccess(access, actor.siteId);
    if (
      !access ||
      access.membershipId !== membershipId ||
      (!readOnly && !access.capabilities.configureReceiving)
    )
      return deny("MEMBERSHIP_DENIED", 403);
    const holders = await tx.execute(
      sql`SELECT id,holder_user_id AS "holderUserId",consent_id AS "consentId",consent_version AS "consentVersion" FROM receiving_setup_holder WHERE site_id=${actor.siteId} AND environment=${mode} ${readOnly ? sql`` : sql`FOR UPDATE`}`,
    );
    const holder = holders.rows[0];
    if (
      holders.rows.length !== 1 ||
      !holder.holderUserId ||
      (!readOnly &&
        (holder.holderUserId !== actor.userId ||
          !holder.consentId ||
          holder.consentVersion !== receivingSetupConsentVersion))
    )
      return deny("RECEIVING_HOLDER_REQUIRED", 403);
    const accounts = await tx.execute(
      sql`SELECT a.id AS "accountId",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.operator_user_id AS "operatorUserId",op.state FROM receiving_account a INNER JOIN financial_operation op ON op.site_id=a.site_id AND op.account_id=a.id AND op.environment=a.environment AND op.kind='ACCOUNT_CREATE' WHERE a.site_id=${actor.siteId} AND a.environment=${mode} AND a.provider='ASAAS' AND a.is_current=true ${readOnly ? sql`` : sql`FOR UPDATE OF a`}`,
    );
    const account = accounts.rows[0];
    if (
      accounts.rows.length !== 1 ||
      account.state !== "SUCCEEDED" ||
      account.operatorUserId !== holder.holderUserId ||
      !account.accountId ||
      !account.accountReference ||
      !account.recipientReference
    )
      return deny();
    const destinations = await tx.execute(
      sql`SELECT id,version,state,is_current AS "isCurrent",pix_configuration AS configuration FROM receiving_pix_destination WHERE site_id=${actor.siteId} AND account_id=${account.accountId} AND environment=${mode} ORDER BY version DESC LIMIT 1 ${readOnly ? sql`` : sql`FOR UPDATE`}`,
    );
    const row = destinations.rows[0];
    if (
      row &&
      (!Number.isSafeInteger(row.version) ||
        (row.version as number) < 1 ||
        row.isCurrent !== true ||
        row.state !== "PENDING" ||
        !row.configuration)
    )
      return deny();
    // History reads project masked facts in SQL; encrypted keys and authentication evidence stay in storage.
    const recentDestinations = readOnly
      ? (
          await tx.execute(
            sql`SELECT id AS "destinationId",site_id AS "siteId",environment AS mode,version,pix_configuration->'review'->>'keyType' AS "keyType",pix_configuration->'review'->>'maskedKey' AS "maskedKey",pix_configuration->'review'->>'ownerName' AS "ownerName",pix_configuration->'review'->>'maskedCpfCnpj' AS "maskedCpfCnpj",pix_configuration->'review'->>'bankName' AS "bankName",pix_configuration->'review'->>'identity' AS identity,created_at AS "savedAt" FROM receiving_pix_destination WHERE site_id=${actor.siteId} AND account_id=${account.accountId} AND environment=${mode} AND state='PENDING' AND pix_configuration->>'confirmRecipient'='true' ORDER BY version DESC LIMIT 5`,
          )
        ).rows.map((entry) =>
          receivingPixDestinationRecentSchema.parse({
            ...entry,
            savedAt: readDatabaseTimestamp(entry.savedAt).toISOString(),
          }),
        )
      : undefined;
    const snapshot: ReceivingPixDestinationSnapshot = {
      ...(recentDestinations ? { recentDestinations } : {}),
      scope: {
        provider: "ASAAS",
        siteId: actor.siteId,
        accountId: account.accountId as string,
        accountReference: account.accountReference as string,
        recipientReference: account.recipientReference as string,
        operatorUserId: account.operatorUserId as string,
        environment: mode,
        destinationVersion: row ? (row.version as number) : 0,
        membershipId: access.membershipId,
        holderId: holder.id as string,
        consentId: holder.consentId as string | null,
      },
      current: row
        ? {
            id: row.id as string,
            version: row.version as number,
            configuration:
              row.configuration as ReceivingPixDestinationRecord["configuration"],
          }
        : null,
    };
    return { snapshot, access, started, checkSession };
  }
  async function protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ReceivingPixDestinationSetupError) throw error;
      return deny("PIX_DESTINATION_UNAVAILABLE", 503);
    }
  }
  return Object.freeze({
    snapshot(actor: FinancialActor, readOnly = false) {
      return protect(() =>
        db.transaction(async (tx) => {
          const current = await load(tx, { ...actor }, readOnly);
          const finished = await clock(tx);
          if (finished.getTime() < current.started.getTime()) return deny();
          current.checkSession(finished);
          return current.snapshot;
        }),
      );
    },
    save(command: ReceivingPixDestinationSave) {
      return protect(async () => {
        const actor = { ...command.actor };
        assertReceivingPixSetupProof(actor, command.recentAuth, now(), maxAge);
        return db.transaction(async (tx) => {
          const current = await load(tx, actor, false),
            actual = current.snapshot;
          const { destinationVersion: expectedVersion, ...expectedBinding } =
            command.scope;
          const { destinationVersion: version, ...actualBinding } =
            actual.scope;
          if (!isDeepStrictEqual(expectedBinding, actualBinding))
            return deny("PIX_DESTINATION_CHANGED");
          const validate = async () => {
            const at = await clock(tx);
            current.checkSession(at);
            if (
              at.getTime() < current.started.getTime() ||
              command.expiresAt.getTime() <= at.getTime() ||
              command.expiresAt.getTime() <= now().getTime()
            )
              return deny("PIX_DESTINATION_REVIEW_EXPIRED");
            assertReceivingPixSetupProof(actor, command.recentAuth, at, maxAge);
            assertReceivingPixSetupProof(
              actor,
              command.recentAuth,
              now(),
              maxAge,
            );
            assertRecipientFinancialAction({
              action: "CONFIGURE_RECEIVING",
              siteId: actor.siteId,
              environment: mode,
              actor,
              access: current.access,
              recipientBinding: {
                siteId: actor.siteId,
                operatorUserId: actual.scope.operatorUserId,
                environment: mode,
                accountReference: actual.scope.accountReference,
                recipientReference: actual.scope.recipientReference,
                destinationVersion: Math.max(1, version),
              },
              recentAuth: command.recentAuth,
              now: at,
              maxAuthAgeMs: maxAge,
            });
            return at;
          };
          await validate();
          if (
            actual.current?.configuration?.reviewId ===
            command.configuration.reviewId
          ) {
            if (!isDeepStrictEqual(actual.current.configuration.actor, actor))
              return deny();
            return actual.current;
          }
          if (version !== expectedVersion || !Number.isSafeInteger(version + 1))
            return deny("PIX_DESTINATION_CHANGED");
          if (
            command.configuration.version !== 1 ||
            command.configuration.confirmRecipient !== true ||
            !isDeepStrictEqual(command.configuration.actor, actor) ||
            (command.configuration.review.identity !== "MATCH" &&
              command.configuration.acceptThirdParty !== true)
          )
            return deny();
          if (actual.current) {
            const changed = await tx.execute(
              sql`UPDATE receiving_pix_destination SET is_current=false,updated_at=clock_timestamp() WHERE id=${actual.current.id} AND site_id=${actor.siteId} AND account_id=${actual.scope.accountId} AND environment=${mode} AND version=${version} AND is_current=true RETURNING id`,
            );
            if (
              changed.rows.length !== 1 ||
              changed.rows[0].id !== actual.current.id
            )
              return deny("PIX_DESTINATION_CHANGED");
          }
          const id = generateId(),
            at = await validate();
          const inserted = await tx.execute(
            sql`INSERT INTO receiving_pix_destination (id,site_id,account_id,environment,version,state,is_current,pix_configuration,created_at) VALUES (${id},${actor.siteId},${actual.scope.accountId},${mode},${version + 1},'PENDING',true,${JSON.stringify(command.configuration)}::jsonb,${at}) RETURNING id`,
          );
          if (inserted.rows.length !== 1 || inserted.rows[0].id !== id)
            return deny();
          await validate();
          return {
            id,
            version: version + 1,
            configuration: command.configuration,
          };
        });
      });
    },
  });
}
