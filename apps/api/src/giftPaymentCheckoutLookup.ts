import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialOperation,
  giftCheckoutAttempt,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import type { StoredGiftPaymentCheckoutBinding } from "./giftPaymentReconciliation";

export interface GiftPaymentCheckoutLookup {
  loadCheckout(
    claim: GiftPaymentInboxClaim,
    observedCheckoutReference?: string,
  ): Promise<StoredGiftPaymentCheckoutBinding | null>;
}
export type GiftPaymentCheckoutLookupDatabase = Pick<
  DatabaseConnection["db"],
  "execute"
>;
export class GiftPaymentCheckoutLookupError extends Error {
  readonly status = 503;
  readonly code = "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE";
  constructor() {
    super("Payment checkout lookup unavailable");
    this.name = "GiftPaymentCheckoutLookupError";
  }
}
function unavailable(): never {
  throw new GiftPaymentCheckoutLookupError();
}
function localId(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function providerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function timestamp(value: unknown): bigint {
  const stored = readDatabaseTimestamp(value);
  if (!giftQuoteSchema.shape.expiresAt.safeParse(stored.toISOString()).success)
    return unavailable();
  return databaseTimestampEpochMicroseconds(stored);
}
function scope(
  row: Record<string, unknown>,
  prefix: string,
  claim: GiftPaymentInboxClaim,
): boolean {
  return (
    row[`${prefix}SiteId`] === claim.siteId &&
    row[`${prefix}AccountId`] === claim.accountId &&
    row[`${prefix}Environment`] === claim.environment
  );
}

export function createGiftPaymentCheckoutLookup(
  db: GiftPaymentCheckoutLookupDatabase,
): GiftPaymentCheckoutLookup {
  return {
    async loadCheckout(
      claim: GiftPaymentInboxClaim,
      observedCheckoutReference?: string,
    ): Promise<StoredGiftPaymentCheckoutBinding | null> {
      try {
        claim = structuredClone(claim);
        if (
          !claim ||
          (observedCheckoutReference !== undefined &&
            !providerId(observedCheckoutReference)) ||
          Object.keys(claim).some(
            (key) =>
              ![
                "eventId",
                "siteId",
                "accountId",
                "environment",
                "leaseOwner",
                "leaseToken",
                "attempts",
                "paymentReference",
                "providerAccountReference",
              ].includes(key),
          ) ||
          ![
            claim.eventId,
            claim.siteId,
            claim.accountId,
            claim.leaseOwner,
            claim.leaseToken,
          ].every(localId) ||
          !providerId(claim.paymentReference) ||
          !providerId(claim.providerAccountReference) ||
          !["sandbox", "live"].includes(claim.environment) ||
          !Number.isSafeInteger(claim.attempts) ||
          claim.attempts < 1 ||
          claim.attempts > 100
        )
          return unavailable();
        const result =
          await db.execute(sql`SELECT e.id AS "eventId", e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
          e.event_type AS "eventType", e.state, e.payload, e.payload_hash AS "payloadHash", e.provider_event_reference AS "providerEventReference",
          e.lease_owner AS "leaseOwner", e.lease_token AS "leaseToken", e.attempts, e.authenticated_at AS "authenticatedAt",
          e.received_at AS "receivedAt", e.lease_expires_at AS "leaseExpiresAt", e.processed_at AS "processedAt", clock_timestamp() AS "databaseNow",
          account.id AS "storedAccountId", account.site_id AS "storedSiteId", account.environment AS "storedEnvironment", account.provider,
          account.account_reference AS "accountReference", p.id AS "paymentRecordId", p.site_id AS "paymentSiteId", p.account_id AS "paymentAccountId",
          p.environment AS "paymentEnvironment", p.provider_payment_reference AS "paymentReference", p.order_id AS "paymentOrderId", p.attempt_id AS "paymentAttemptId",
          a.id AS "attemptId", a.site_id AS "attemptSiteId", a.account_id AS "attemptAccountId", a.environment AS "attemptEnvironment",
          a.order_id AS "attemptOrderId", a.operation_id AS "attemptOperationId", a.operation_kind AS "attemptOperationKind", a.provider_reference AS "providerCheckoutReference",
          o.id AS "orderId", o.site_id AS "orderSiteId", o.account_id AS "orderAccountId", o.environment AS "orderEnvironment", o.quote_id AS "orderQuoteId",
          q.id AS "quoteId", q.site_id AS "quoteSiteId", q.account_id AS "quoteAccountId", q.environment AS "quoteEnvironment",
          q.snapshot->'receiving'->>'accountReference' AS "quoteAccountReference", q.snapshot->'receiving'->>'siteId' AS "frozenSiteId",
          q.snapshot->'receiving'->>'environment' AS "frozenEnvironment", q.snapshot->'receiving'->>'provider' AS "frozenProvider",
          op.id AS "operationId", op.site_id AS "operationSiteId", op.account_id AS "operationAccountId", op.environment AS "operationEnvironment",
          op.order_id AS "operationOrderId", op.kind AS "operationKind", op.state AS "operationState", op.provider_operation_reference AS "providerOperationReference"
          FROM ${financialEventInbox} e INNER JOIN ${receivingAccount} account ON account.id=e.account_id AND account.site_id=e.site_id AND account.environment=e.environment
          LEFT JOIN ${giftPaymentRecord} p ON p.site_id=e.site_id AND p.account_id=e.account_id AND p.environment=e.environment AND p.provider_payment_reference=e.payload->>'paymentId'
          LEFT JOIN ${giftCheckoutAttempt} a ON a.site_id=e.site_id AND a.account_id=e.account_id AND a.environment=e.environment
            AND (a.id=e.payload->>'externalReference' OR a.provider_reference=e.payload->>'checkoutId' OR a.provider_reference=${observedCheckoutReference ?? null} OR (p.id IS NOT NULL AND a.id=p.attempt_id AND a.order_id=p.order_id))
          LEFT JOIN ${giftOrder} o ON o.id=a.order_id AND o.site_id=a.site_id AND o.account_id=a.account_id AND o.environment=a.environment
          LEFT JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=o.site_id AND q.account_id=o.account_id AND q.environment=o.environment
          LEFT JOIN ${financialOperation} op ON op.id=a.operation_id AND op.order_id=o.id AND op.kind=a.operation_kind AND op.site_id=a.site_id AND op.account_id=a.account_id AND op.environment=a.environment
          WHERE e.id=${claim.eventId} AND e.site_id=${claim.siteId} AND e.account_id=${claim.accountId} AND e.environment=${claim.environment}
            AND e.lease_owner=${claim.leaseOwner} AND e.lease_token=${claim.leaseToken} AND e.attempts=${claim.attempts}
            AND e.state='CLAIMED' AND e.event_type IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND e.processed_at IS NULL
            AND e.authenticated_at<=clock_timestamp() AND e.received_at<=e.authenticated_at AND e.lease_expires_at>=clock_timestamp()`);
        if (result.rows.length !== 1) return unavailable();
        const row = result.rows[0] as Record<string, unknown>;
        if (
          row.eventId !== claim.eventId ||
          row.siteId !== claim.siteId ||
          row.accountId !== claim.accountId ||
          row.environment !== claim.environment ||
          !scope(row, "stored", claim) ||
          row.provider !== "ASAAS" ||
          row.accountReference !== claim.providerAccountReference ||
          !["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(
            row.eventType as string,
          ) ||
          row.state !== "CLAIMED" ||
          row.processedAt !== null ||
          row.leaseOwner !== claim.leaseOwner ||
          row.leaseToken !== claim.leaseToken ||
          row.attempts !== claim.attempts ||
          timestamp(row.authenticatedAt) > timestamp(row.databaseNow) ||
          timestamp(row.receivedAt) > timestamp(row.authenticatedAt) ||
          timestamp(row.leaseExpiresAt) < timestamp(row.databaseNow)
        )
          return unavailable();
        const payload = row.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          return unavailable();
        const identity = payload as Record<string, string>;
        if (
          identity.paymentId !== claim.paymentReference ||
          Object.entries(identity).some(([key, value]) =>
            key === "externalReference"
              ? !localId(value)
              : !["paymentId", "checkoutId"].includes(key) ||
                !providerId(value),
          ) ||
          typeof row.providerEventReference !== "string" ||
          !/^[\x21-\x7e]{1,256}$/.test(row.providerEventReference) ||
          row.payloadHash !==
            hashAsaasEventIdentity(
              row.providerEventReference,
              String(row.eventType),
              claim.providerAccountReference,
              identity,
            )
        )
          return unavailable();
        if (
          row.paymentRecordId !== null &&
          (!localId(row.paymentRecordId) ||
            !scope(row, "payment", claim) ||
            row.paymentReference !== claim.paymentReference ||
            !localId(row.paymentOrderId) ||
            !localId(row.paymentAttemptId))
        )
          return unavailable();
        if (row.attemptId === null) {
          if (row.paymentRecordId !== null) return unavailable();
          return null;
        }
        if (
          ![row.attemptId, row.orderId, row.quoteId, row.operationId].every(
            localId,
          ) ||
          !["attempt", "order", "quote", "operation"].every((prefix) =>
            scope(row, prefix, claim),
          ) ||
          row.attemptOrderId !== row.orderId ||
          row.orderQuoteId !== row.quoteId ||
          row.attemptOperationId !== row.operationId ||
          row.operationOrderId !== row.orderId ||
          row.attemptOperationKind !== "CHECKOUT_CREATE" ||
          row.operationKind !== "CHECKOUT_CREATE" ||
          row.quoteAccountReference !== claim.providerAccountReference ||
          row.frozenSiteId !== claim.siteId ||
          row.frozenEnvironment !== claim.environment ||
          row.frozenProvider !== "ASAAS" ||
          (identity.externalReference !== undefined &&
            identity.externalReference !== row.attemptId) ||
          (identity.checkoutId !== undefined &&
            row.providerCheckoutReference !== null &&
            identity.checkoutId !== row.providerCheckoutReference) ||
          (identity.checkoutId !== undefined &&
            row.providerOperationReference !== null &&
            identity.checkoutId !== row.providerOperationReference) ||
          (row.paymentRecordId !== null &&
            (row.paymentOrderId !== row.orderId ||
              row.paymentAttemptId !== row.attemptId)) ||
          (row.providerCheckoutReference !== null &&
            !providerId(row.providerCheckoutReference)) ||
          (row.providerOperationReference !== null &&
            !providerId(row.providerOperationReference)) ||
          (row.providerCheckoutReference !== null &&
            row.providerOperationReference !== null &&
            row.providerCheckoutReference !== row.providerOperationReference) ||
          ![
            "REQUESTED",
            "CLAIMED",
            "PROCESSING",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
            "UNKNOWN",
          ].includes(row.operationState as string)
        )
          return unavailable();
        if (row.operationState !== "SUCCEEDED") return null;
        if (
          !providerId(row.providerCheckoutReference) ||
          (observedCheckoutReference !== undefined &&
            observedCheckoutReference !== row.providerCheckoutReference) ||
          row.providerCheckoutReference !== row.providerOperationReference ||
          (identity.checkoutId !== undefined &&
            identity.checkoutId !== row.providerCheckoutReference)
        )
          return unavailable();
        return {
          siteId: claim.siteId,
          accountId: claim.accountId,
          environment: claim.environment,
          accountReference: claim.providerAccountReference,
          orderId: row.orderId as string,
          attemptId: row.attemptId as string,
          providerCheckoutReference: row.providerCheckoutReference,
        };
      } catch {
        return unavailable();
      }
    },
  };
}
