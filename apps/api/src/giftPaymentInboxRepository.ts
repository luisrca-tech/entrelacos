import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { GiftPaymentPostingClaim } from "./giftPaymentPostingRepository";

export interface GiftPaymentInboxClaim extends GiftPaymentPostingClaim {
  paymentReference: string;
  providerAccountReference: string;
  attempts: number;
}
export type GiftPaymentInboxClaimResult =
  | { kind: "CLAIMED"; claim: GiftPaymentInboxClaim }
  | {
      kind: "DEAD_LETTER";
      eventId: string;
      errorCode: "FINANCIAL_ATTEMPT_LIMIT" | "PAYMENT_CORRELATION_INVALID";
    }
  | null;
export type GiftPaymentInboxDeferReason =
  | "PROVIDER_READ_UNAVAILABLE"
  | "CHECKOUT_BINDING_UNAVAILABLE"
  | "PAYMENT_POSTING_UNAVAILABLE";
export interface GiftPaymentInboxDeferResult {
  kind: "RETRY" | "DEAD_LETTER";
}
export interface GiftPaymentInboxOptions {
  environment: "sandbox" | "live";
  instanceId: string;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  now(): Date;
  generateLeaseToken(): string;
}
export class GiftPaymentInboxRepositoryError extends Error {
  readonly status = 503;
  readonly code = "FINANCIAL_INBOX_UNAVAILABLE";
  constructor() {
    super("Financial inbox unavailable");
    this.name = "GiftPaymentInboxRepositoryError";
  }
}
interface ClaimRow {
  eventId: string;
  siteId: string;
  accountId: string;
  environment: string;
  bindingSiteId: string;
  bindingAccountId: string;
  bindingEnvironment: string;
  bindingProvider: string;
  providerAccountReference: string;
  authenticatedAt: Date;
  receivedAt: Date;
  attempts: number;
  payload: unknown;
  state: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
}
interface DeferRow extends ClaimRow {
  eventType: string;
  processedAt: Date | null;
  lastErrorCode: string | null;
}
function unavailable(): never {
  throw new GiftPaymentInboxRepositoryError();
}
function identifier(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function time(value: Date): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    unavailable();
  return readDatabaseTimestamp(value);
}
function microseconds(value: Date): bigint {
  return databaseTimestampEpochMicroseconds(time(value));
}
function storedRow<T extends ClaimRow>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const row = value as Record<string, unknown>;
  return {
    ...row,
    authenticatedAt: readDatabaseTimestamp(row.authenticatedAt),
    receivedAt: readDatabaseTimestamp(row.receivedAt),
    nextAttemptAt: readDatabaseTimestamp(row.nextAttemptAt),
    leaseExpiresAt:
      row.leaseExpiresAt === null
        ? null
        : readDatabaseTimestamp(row.leaseExpiresAt),
  } as unknown as T;
}
export function createGiftPaymentInboxRepository(
  db: Pick<DatabaseConnection["db"], "transaction">,
  options: GiftPaymentInboxOptions,
) {
  if (
    !["sandbox", "live"].includes(options.environment) ||
    !identifier(options.instanceId) ||
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs <= 0 ||
    options.leaseMs > 300_000 ||
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 100 ||
    !Number.isSafeInteger(options.retryDelayMs) ||
    options.retryDelayMs <= 0 ||
    options.retryDelayMs > 300_000 ||
    typeof options.now !== "function" ||
    typeof options.generateLeaseToken !== "function"
  )
    unavailable();
  options = Object.freeze({ ...options });
  return {
    async deferClaim(
      claim: GiftPaymentInboxClaim,
      reason: GiftPaymentInboxDeferReason,
    ): Promise<GiftPaymentInboxDeferResult> {
      try {
        claim = structuredClone(claim);
        if (
          !claim ||
          Object.keys(claim).some(
            (key) =>
              ![
                "eventId",
                "siteId",
                "accountId",
                "environment",
                "leaseOwner",
                "leaseToken",
                "paymentReference",
                "providerAccountReference",
                "attempts",
              ].includes(key),
          ) ||
          ![
            claim.eventId,
            claim.siteId,
            claim.accountId,
            claim.leaseOwner,
            claim.leaseToken,
            claim.providerAccountReference,
          ].every(identifier) ||
          typeof claim.paymentReference !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(claim.paymentReference) ||
          claim.environment !== options.environment ||
          claim.leaseOwner !== options.instanceId ||
          !Number.isSafeInteger(claim.attempts) ||
          claim.attempts < 1 ||
          claim.attempts > 100 ||
          ![
            "PROVIDER_READ_UNAVAILABLE",
            "CHECKOUT_BINDING_UNAVAILABLE",
            "PAYMENT_POSTING_UNAVAILABLE",
          ].includes(reason)
        )
          unavailable();
        return await db.transaction(
          async (tx) => {
            const selected =
              await tx.execute(sql`SELECT e.id AS "eventId", e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
            a.site_id AS "bindingSiteId", a.id AS "bindingAccountId", a.environment AS "bindingEnvironment", a.provider AS "bindingProvider",
            a.account_reference AS "providerAccountReference", e.authenticated_at AS "authenticatedAt", e.received_at AS "receivedAt",
            e.attempts, e.payload, e.event_type AS "eventType", e.state, e.lease_owner AS "leaseOwner", e.lease_token AS "leaseToken",
            e.lease_expires_at AS "leaseExpiresAt", e.next_attempt_at AS "nextAttemptAt", e.processed_at AS "processedAt", e.last_error_code AS "lastErrorCode"
            FROM ${financialEventInbox} e INNER JOIN ${receivingAccount} a ON a.site_id=e.site_id AND a.id=e.account_id AND a.environment=e.environment
            WHERE e.id=${claim.eventId} AND e.site_id=${claim.siteId} AND e.account_id=${claim.accountId} AND e.environment=${claim.environment} FOR UPDATE OF e`);
            const row = storedRow<DeferRow>(selected.rows[0]);
            const clock = time(options.now());
            if (
              selected.rows.length !== 1 ||
              !row ||
              row.eventId !== claim.eventId ||
              row.siteId !== claim.siteId ||
              row.accountId !== claim.accountId ||
              row.environment !== claim.environment ||
              row.bindingSiteId !== claim.siteId ||
              row.bindingAccountId !== claim.accountId ||
              row.bindingEnvironment !== claim.environment ||
              row.bindingProvider !== "ASAAS" ||
              row.providerAccountReference !== claim.providerAccountReference ||
              !["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(
                row.eventType as string,
              ) ||
              row.leaseOwner !== claim.leaseOwner ||
              row.leaseToken !== claim.leaseToken ||
              row.attempts !== claim.attempts ||
              row.processedAt !== null ||
              !row.leaseExpiresAt ||
              !row.payload ||
              typeof row.payload !== "object" ||
              Array.isArray(row.payload) ||
              (row.payload as Record<string, unknown>).paymentId !==
                claim.paymentReference ||
              microseconds(row.authenticatedAt) > microseconds(clock) ||
              microseconds(row.receivedAt) >
                microseconds(row.authenticatedAt) ||
              microseconds(row.leaseExpiresAt) <
                microseconds(row.authenticatedAt)
            )
              unavailable();
            const kind =
              claim.attempts >= options.maxAttempts ? "DEAD_LETTER" : "RETRY";
            if (row.state === kind) {
              const due = microseconds(row.nextAttemptAt);
              if (
                row.lastErrorCode !== reason ||
                due <
                  microseconds(row.authenticatedAt) +
                    BigInt(options.retryDelayMs) * 1000n ||
                due >
                  microseconds(row.leaseExpiresAt) +
                    BigInt(options.retryDelayMs) * 1000n
              )
                unavailable();
              return { kind };
            }
            if (
              row.state !== "CLAIMED" ||
              microseconds(row.leaseExpiresAt) < microseconds(clock)
            )
              unavailable();
            const due = time(new Date(clock.getTime() + options.retryDelayMs));
            const saved =
              await tx.execute(sql`UPDATE ${financialEventInbox} e SET state=${kind}, last_error_code=${reason}, next_attempt_at=${due.toISOString()}::timestamptz
            WHERE e.id=${claim.eventId} AND e.site_id=${claim.siteId} AND e.account_id=${claim.accountId} AND e.environment=${claim.environment}
              AND e.state='CLAIMED' AND e.event_type IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND e.attempts=${claim.attempts}
              AND e.lease_owner=${claim.leaseOwner} AND e.lease_token=${claim.leaseToken}
              AND e.lease_expires_at>=${clock.toISOString()}::timestamptz AND e.lease_expires_at>=clock_timestamp()
              AND e.authenticated_at<=${clock.toISOString()}::timestamptz AND e.authenticated_at<=clock_timestamp()
              AND e.processed_at IS NULL AND e.payload->>'paymentId'=${claim.paymentReference} RETURNING e.id`);
            if (saved.rows.length !== 1 || saved.rows[0]?.id !== claim.eventId)
              unavailable();
            return { kind };
          },
          { isolationLevel: "read committed" },
        );
      } catch {
        unavailable();
      }
    },
    async claimNextReceivedPayment(): Promise<GiftPaymentInboxClaimResult> {
      try {
        const clock = time(options.now());
        return await db.transaction(
          async (tx) => {
            const rows =
              await tx.execute(sql`SELECT e.id AS "eventId",e.site_id AS "siteId",e.account_id AS "accountId",e.environment,
          a.site_id AS "bindingSiteId",a.id AS "bindingAccountId",a.environment AS "bindingEnvironment",a.provider AS "bindingProvider",
          a.account_reference AS "providerAccountReference",e.authenticated_at AS "authenticatedAt",e.received_at AS "receivedAt",
          e.attempts,e.payload,e.state,e.lease_owner AS "leaseOwner",e.lease_token AS "leaseToken",e.lease_expires_at AS "leaseExpiresAt",e.next_attempt_at AS "nextAttemptAt"
          FROM ${financialEventInbox} e INNER JOIN ${receivingAccount} a ON a.site_id=e.site_id AND a.id=e.account_id AND a.environment=e.environment
          INNER JOIN ${site} st ON st.id=e.site_id
          WHERE e.environment=${options.environment} AND a.provider='ASAAS' AND a.account_reference IS NOT NULL AND length(trim(a.account_reference))>0
            AND (${options.environment}<>'live' OR st.is_demo=false) AND e.authenticated_at IS NOT NULL AND e.event_type IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED')
            AND ((e.state IN ('RECEIVED','RETRY') AND e.next_attempt_at<=${clock.toISOString()}::timestamptz AND e.next_attempt_at<=clock_timestamp())
              OR (e.state='CLAIMED' AND e.lease_expires_at<=${clock.toISOString()}::timestamptz AND e.lease_expires_at<=clock_timestamp()))
          ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
            if (rows.rows.length === 0) return null;
            if (rows.rows.length !== 1) unavailable();
            const row = storedRow<ClaimRow>(rows.rows[0]);
            const observed = time(options.now());
            if (
              !identifier(row.eventId) ||
              !identifier(row.siteId) ||
              !identifier(row.accountId) ||
              !identifier(row.providerAccountReference) ||
              row.environment !== options.environment ||
              row.siteId !== row.bindingSiteId ||
              row.accountId !== row.bindingAccountId ||
              row.environment !== row.bindingEnvironment ||
              row.bindingProvider !== "ASAAS" ||
              !Number.isSafeInteger(row.attempts) ||
              row.attempts < 0 ||
              !["RECEIVED", "RETRY", "CLAIMED"].includes(row.state) ||
              microseconds(row.authenticatedAt) > microseconds(observed) ||
              microseconds(row.receivedAt) > microseconds(observed) ||
              microseconds(row.receivedAt) > microseconds(row.authenticatedAt)
            )
              unavailable();
            if (row.state === "CLAIMED") {
              if (
                !identifier(row.leaseOwner) ||
                !identifier(row.leaseToken) ||
                !row.leaseExpiresAt ||
                microseconds(row.leaseExpiresAt) > microseconds(observed)
              )
                unavailable();
            } else if (microseconds(row.nextAttemptAt) > microseconds(observed))
              unavailable();
            const paymentReference =
              row.payload &&
              typeof row.payload === "object" &&
              !Array.isArray(row.payload)
                ? (row.payload as Record<string, unknown>).paymentId
                : null;
            const exhausted = row.attempts >= options.maxAttempts;
            const correlated =
              typeof paymentReference === "string" &&
              /^[A-Za-z0-9_-]{1,128}$/.test(paymentReference);
            const errorCode = exhausted
              ? "FINANCIAL_ATTEMPT_LIMIT"
              : "PAYMENT_CORRELATION_INVALID";
            const token =
              exhausted || !correlated ? null : options.generateLeaseToken();
            if (
              token !== null &&
              (!identifier(token) || token === row.leaseToken)
            )
              unavailable();
            const expires = time(
              new Date(observed.getTime() + options.leaseMs),
            );
            const due = sql`((e.state IN ('RECEIVED','RETRY') AND e.next_attempt_at<=${observed.toISOString()}::timestamptz AND e.next_attempt_at<=clock_timestamp())
          OR (e.state='CLAIMED' AND e.lease_expires_at<=${observed.toISOString()}::timestamptz AND e.lease_expires_at<=clock_timestamp()))`;
            const scope = sql`e.id=${row.eventId} AND e.site_id=${row.siteId} AND e.account_id=${row.accountId} AND e.environment=${options.environment}
          AND e.state=${row.state} AND e.attempts=${row.attempts} AND e.authenticated_at IS NOT NULL AND ${due}`;
            if (exhausted || !correlated) {
              const saved = await tx.execute(
                sql`UPDATE ${financialEventInbox} e SET state='DEAD_LETTER',last_error_code=${errorCode} WHERE ${scope} RETURNING e.id`,
              );
              if (saved.rows.length !== 1 || saved.rows[0]?.id !== row.eventId)
                unavailable();
              return { kind: "DEAD_LETTER", eventId: row.eventId, errorCode };
            }
            const saved =
              await tx.execute(sql`UPDATE ${financialEventInbox} e SET state='CLAIMED',lease_owner=${options.instanceId},lease_token=${token},
          lease_expires_at=${expires.toISOString()}::timestamptz,attempts = e.attempts + 1,last_error_code=NULL
          WHERE ${scope} AND ${expires.toISOString()}::timestamptz>clock_timestamp() RETURNING e.id`);
            if (saved.rows.length !== 1 || saved.rows[0]?.id !== row.eventId)
              unavailable();
            return {
              kind: "CLAIMED",
              claim: {
                eventId: row.eventId,
                siteId: row.siteId,
                accountId: row.accountId,
                environment: options.environment,
                leaseOwner: options.instanceId,
                leaseToken: token as string,
                paymentReference: paymentReference as string,
                providerAccountReference: row.providerAccountReference,
                attempts: row.attempts + 1,
              },
            };
          },
          { isolationLevel: "read committed" },
        );
      } catch {
        unavailable();
      }
    },
  };
}
