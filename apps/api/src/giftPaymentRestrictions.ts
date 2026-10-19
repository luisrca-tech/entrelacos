import { randomUUID } from "node:crypto";
import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialOperation,
  giftCheckoutAttempt,
  giftOrder,
  giftQuoteRecord,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import type { AsaasStoredAccountReader } from "./asaasStoredAccountReader";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import type { GiftPaymentWorker } from "./giftPaymentWorker";

export const giftPaymentRestrictionEvents = Object.freeze([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
] as const);

interface Options {
  db: Pick<DatabaseConnection["db"], "transaction">;
  environment: "sandbox" | "live";
  instanceId: string;
  reader: Pick<AsaasStoredAccountReader, "getPayment">;
  now(): Date;
}
interface RestrictionClaim extends GiftPaymentInboxClaim {
  eventType: string;
  payload: Record<string, string>;
  payloadHash: string;
  authenticatedAt: Date;
}
function unavailable(): never {
  throw new Error("Payment restriction observation unavailable");
}
function id(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function reference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function after(left: unknown, right: unknown): boolean {
  return (
    compareDatabaseTimestamps(
      readDatabaseTimestamp(left),
      readDatabaseTimestamp(right),
    ) >= 0
  );
}

// Restriction events remain unresolved until a separate authoritative compensation
// writer exists. Observing them must never alter an immutable receipt or clear a hold.
export function createGiftPaymentRestrictionWorker(
  options: Options,
): GiftPaymentWorker {
  const { db, environment, instanceId, reader, now } = options;
  if (
    !["sandbox", "live"].includes(environment) ||
    !id(instanceId) ||
    typeof now !== "function" ||
    typeof reader?.getPayment !== "function"
  )
    return unavailable();
  async function claim(): Promise<RestrictionClaim | "DEAD_LETTER" | null> {
    const started = readDatabaseTimestamp(now());
    return db.transaction(async (tx) => {
      const selected =
        await tx.execute(sql`SELECT e.id AS "eventId", e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
        e.event_type AS "eventType", e.payload, e.payload_hash AS "payloadHash", e.provider_event_reference AS "providerEventReference",
        e.received_at AS "receivedAt", e.authenticated_at AS "authenticatedAt", e.state, e.attempts, e.next_attempt_at AS "nextAttemptAt",
        e.lease_expires_at AS "leaseExpiresAt", e.processed_at AS "processedAt", a.provider, a.account_reference AS "accountReference", st.is_demo AS "isDemo"
        FROM ${financialEventInbox} e INNER JOIN ${receivingAccount} a ON a.id=e.account_id AND a.site_id=e.site_id AND a.environment=e.environment
        INNER JOIN ${site} st ON st.id=e.site_id
        WHERE e.environment=${environment} AND a.provider='ASAAS' AND (${environment}<>'live' OR st.is_demo=false)
          AND e.event_type IN ('PAYMENT_REFUNDED','PAYMENT_PARTIALLY_REFUNDED','PAYMENT_REFUND_IN_PROGRESS','PAYMENT_CHARGEBACK_REQUESTED','PAYMENT_CHARGEBACK_DISPUTE','PAYMENT_AWAITING_CHARGEBACK_REVERSAL')
          AND e.authenticated_at IS NOT NULL AND e.processed_at IS NULL
          AND ((e.state IN ('RECEIVED','RETRY') AND e.next_attempt_at<=${started.toISOString()}::timestamptz AND e.next_attempt_at<=clock_timestamp())
            OR (e.state='CLAIMED' AND e.lease_expires_at<=${started.toISOString()}::timestamptz AND e.lease_expires_at<=clock_timestamp()))
        ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1) return unavailable();
      const row = selected.rows[0];
      const clock = readDatabaseTimestamp(now());
      const payload = row.payload as Record<string, string> | null;
      if (
        ![row.eventId, row.siteId, row.accountId].every(id) ||
        row.environment !== environment ||
        row.provider !== "ASAAS" ||
        typeof row.isDemo !== "boolean" ||
        (environment === "live" && row.isDemo) ||
        !reference(row.accountReference) ||
        !giftPaymentRestrictionEvents.includes(
          row.eventType as (typeof giftPaymentRestrictionEvents)[number],
        ) ||
        row.processedAt !== null ||
        !Number.isSafeInteger(row.attempts) ||
        Number(row.attempts) < 0 ||
        !["RECEIVED", "RETRY", "CLAIMED"].includes(String(row.state)) ||
        !after(clock, row.authenticatedAt) ||
        !after(row.authenticatedAt, row.receivedAt) ||
        !after(
          clock,
          row.state === "CLAIMED" ? row.leaseExpiresAt : row.nextAttemptAt,
        ) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !reference(payload.paymentId) ||
        Object.entries(payload).some(([key, value]) =>
          key === "externalReference"
            ? !id(value)
            : !["paymentId", "checkoutId", "refundId"].includes(key) ||
              !reference(value),
        ) ||
        typeof row.providerEventReference !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(row.providerEventReference) ||
        row.payloadHash !==
          hashAsaasEventIdentity(
            row.providerEventReference,
            String(row.eventType),
            row.accountReference,
            payload,
          )
      )
        return unavailable();
      const base = sql`e.id=${row.eventId} AND e.site_id=${row.siteId} AND e.account_id=${row.accountId} AND e.environment=${environment}
        AND e.state=${row.state} AND e.attempts=${row.attempts} AND e.payload_hash=${row.payloadHash} AND e.processed_at IS NULL
        AND e.authenticated_at<=clock_timestamp()`;
      const exhausted = Number(row.attempts) >= 12;
      const leaseToken = randomUUID();
      const mutation = exhausted
        ? sql`state='DEAD_LETTER',last_error_code='PAYMENT_RESTRICTION_ATTEMPT_LIMIT'`
        : sql`state='CLAIMED',lease_owner=${instanceId},lease_token=${leaseToken},lease_expires_at=${new Date(clock.getTime() + 60_000).toISOString()}::timestamptz,attempts=e.attempts+1,last_error_code=NULL`;
      const saved = await tx.execute(
        sql`UPDATE ${financialEventInbox} e SET ${mutation} WHERE ${base} RETURNING e.id`,
      );
      if (saved.rows.length !== 1 || saved.rows[0]?.id !== row.eventId)
        return unavailable();
      if (exhausted) return "DEAD_LETTER";
      return {
        eventId: String(row.eventId),
        siteId: String(row.siteId),
        accountId: String(row.accountId),
        environment,
        leaseOwner: instanceId,
        leaseToken,
        attempts: Number(row.attempts) + 1,
        paymentReference: payload.paymentId,
        providerAccountReference: row.accountReference,
        eventType: String(row.eventType),
        payload,
        payloadHash: String(row.payloadHash),
        authenticatedAt: readDatabaseTimestamp(row.authenticatedAt),
      };
    });
  }
  return {
    async processNextReceivedPayment() {
      const event = await claim();
      if (!event) return { kind: "IDLE" };
      if (event === "DEAD_LETTER") return { kind: "DEAD_LETTER" };
      let observed = false;
      let code = "PAYMENT_RESTRICTION_PROVIDER_UNAVAILABLE";
      try {
        const {
          eventType: _type,
          payload: _payload,
          payloadHash: _hash,
          authenticatedAt: _authenticated,
          ...nativeClaim
        } = event;
        const observation = await reader.getPayment(nativeClaim);
        const payment = observation.payment;
        if (
          observation.source !== "provider" ||
          observation.provider !== "ASAAS" ||
          observation.siteId !== event.siteId ||
          observation.accountReference !== event.providerAccountReference ||
          observation.environment !== environment ||
          observation.currency !== "BRL" ||
          !after(observation.observedAt, event.authenticatedAt) ||
          !after(now(), observation.observedAt) ||
          payment.id !== event.paymentReference ||
          !reference(payment.checkoutSession) ||
          (event.payload.checkoutId !== undefined &&
            event.payload.checkoutId !== payment.checkoutSession) ||
          (payment.externalReference != null && !id(payment.externalReference))
        )
          return unavailable();
        const correlated = await db.transaction(async (tx) =>
          tx.execute(sql`SELECT a.id AS "attemptId", a.provider_reference AS "checkoutReference", account.account_reference AS "accountReference"
          FROM ${giftCheckoutAttempt} a INNER JOIN ${receivingAccount} account ON account.id=a.account_id AND account.site_id=a.site_id AND account.environment=a.environment
          INNER JOIN ${giftOrder} o ON o.id=a.order_id AND o.site_id=a.site_id AND o.account_id=a.account_id AND o.environment=a.environment
          INNER JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=o.site_id AND q.account_id=o.account_id AND q.environment=o.environment
          INNER JOIN ${financialOperation} op ON op.id=a.operation_id AND op.order_id=a.order_id AND op.site_id=a.site_id AND op.account_id=a.account_id AND op.environment=a.environment
            AND op.kind=a.operation_kind AND op.kind='CHECKOUT_CREATE' AND op.state='SUCCEEDED' AND op.provider_operation_reference=a.provider_reference
          WHERE a.site_id=${event.siteId} AND a.account_id=${event.accountId} AND a.environment=${environment} AND a.provider_reference=${payment.checkoutSession}
            AND account.provider='ASAAS' AND account.account_reference=${event.providerAccountReference}
            AND q.snapshot->'receiving'->>'accountReference'=${event.providerAccountReference} LIMIT 2`),
        );
        const binding = correlated.rows[0];
        if (
          correlated.rows.length !== 1 ||
          !id(binding?.attemptId) ||
          binding.checkoutReference !== payment.checkoutSession ||
          binding.accountReference !== event.providerAccountReference ||
          (event.payload.externalReference !== undefined &&
            binding.attemptId !== event.payload.externalReference) ||
          (payment.externalReference != null &&
            binding.attemptId !== payment.externalReference)
        )
          return unavailable();
        observed =
          /^(REFUND|CHARGEBACK)|^AWAITING_CHARGEBACK_REVERSAL$/.test(
            payment.status,
          ) ||
          (Array.isArray(payment.refunds) && payment.refunds.length > 0) ||
          payment.chargeback != null;
        code = observed
          ? "PAYMENT_RESTRICTION_RECONCILIATION_REQUIRED"
          : "PAYMENT_RESTRICTION_NOT_OBSERVED";
      } catch {
        /* The authenticated event continues to inhibit financial availability. */
      }
      const clock = readDatabaseTimestamp(now());
      await db.transaction(async (tx) => {
        const mutation = observed
          ? sql`state='DEAD_LETTER'`
          : sql`state='RETRY',next_attempt_at=${new Date(clock.getTime() + 5_000).toISOString()}::timestamptz`;
        const saved =
          await tx.execute(sql`UPDATE ${financialEventInbox} e SET ${mutation},last_error_code=${code}
          WHERE e.id=${event.eventId} AND e.site_id=${event.siteId} AND e.account_id=${event.accountId} AND e.environment=${environment}
            AND e.state='CLAIMED' AND e.event_type=${event.eventType} AND e.payload_hash=${event.payloadHash} AND e.processed_at IS NULL
            AND e.lease_owner=${instanceId} AND e.lease_token=${event.leaseToken} AND e.attempts=${event.attempts}
            AND e.authenticated_at<=${clock.toISOString()}::timestamptz AND e.authenticated_at<=clock_timestamp()
            AND e.lease_expires_at>=${clock.toISOString()}::timestamptz AND e.lease_expires_at>=clock_timestamp() RETURNING e.id`);
        if (saved.rows.length !== 1 || saved.rows[0]?.id !== event.eventId)
          return unavailable();
      });
      return { kind: observed ? "DEAD_LETTER" : "RETRY" };
    },
  };
}
