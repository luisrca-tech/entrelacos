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
import type { GiftPaymentWorker } from "./giftPaymentWorker";

interface Options {
  db: Pick<DatabaseConnection["db"], "transaction">;
  environment: "sandbox" | "live";
  instanceId: string;
  reader: Pick<AsaasStoredAccountReader, "listCheckoutPayments">;
  now(): Date;
}
const supported = [
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
];
function unavailable(): never {
  throw new Error("Checkout lifecycle unavailable");
}
function id(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function reference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function time(value: unknown): Date {
  try {
    return readDatabaseTimestamp(value);
  } catch {
    return unavailable();
  }
}
function after(left: unknown, right: unknown): boolean {
  return compareDatabaseTimestamps(time(left), time(right)) >= 0;
}
interface Claim {
  eventId: string;
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  accountReference: string;
  attemptId: string;
  checkoutReference: string;
  payloadHash: string;
  authenticatedAt: Date;
  eventType: string;
  leaseToken: string;
  attempts: number;
}

// This worker consumes journey events. It never posts a receipt or changes a purchase snapshot.
export function createGiftCheckoutLifecycleWorker(
  options: Options,
): GiftPaymentWorker {
  const { db, environment, instanceId, reader, now } = options;
  if (
    !["sandbox", "live"].includes(environment) ||
    !id(instanceId) ||
    typeof now !== "function"
  )
    return unavailable();
  async function claim(): Promise<Claim | "DEAD_LETTER" | null> {
    const started = time(now());
    return db.transaction(async (tx) => {
      const result =
        await tx.execute(sql`SELECT e.id AS "eventId", e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
        e.event_type AS "eventType", e.payload, e.payload_hash AS "payloadHash", e.provider_event_reference AS "providerEventReference",
        e.received_at AS "receivedAt", e.authenticated_at AS "authenticatedAt", e.state, e.attempts, e.next_attempt_at AS "nextAttemptAt",
        e.lease_owner AS "leaseOwner", e.lease_token AS "leaseToken", e.lease_expires_at AS "leaseExpiresAt", e.processed_at AS "processedAt",
        account.provider, account.account_reference AS "accountReference", st.is_demo AS "isDemo",
        a.id AS "attemptId", a.order_id AS "orderId", a.provider_reference AS "checkoutReference",
        op.state AS "operationState", op.provider_operation_reference AS "operationReference",
        q.snapshot->'receiving'->>'accountReference' AS "quoteAccountReference"
        FROM ${financialEventInbox} e
        INNER JOIN ${receivingAccount} account ON account.id=e.account_id AND account.site_id=e.site_id AND account.environment=e.environment
        INNER JOIN ${site} st ON st.id=e.site_id
        INNER JOIN ${giftCheckoutAttempt} a ON a.site_id=e.site_id AND a.account_id=e.account_id AND a.environment=e.environment AND a.provider_reference=e.payload->>'checkoutId'
        INNER JOIN ${giftOrder} o ON o.id=a.order_id AND o.site_id=a.site_id AND o.account_id=a.account_id AND o.environment=a.environment
        INNER JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=o.site_id AND q.account_id=o.account_id AND q.environment=o.environment
        INNER JOIN ${financialOperation} op ON op.id=a.operation_id AND op.site_id=a.site_id AND op.account_id=a.account_id AND op.environment=a.environment
          AND op.order_id=a.order_id AND op.kind=a.operation_kind AND op.kind='CHECKOUT_CREATE'
        WHERE e.environment=${environment} AND account.provider='ASAAS' AND (${environment}<>'live' OR st.is_demo=false)
          AND e.event_type IN ('CHECKOUT_CREATED','CHECKOUT_PAID','CHECKOUT_CANCELED','CHECKOUT_EXPIRED') AND e.authenticated_at IS NOT NULL
          AND ((e.state IN ('RECEIVED','RETRY') AND e.next_attempt_at<=${started.toISOString()}::timestamptz AND e.next_attempt_at<=clock_timestamp())
            OR (e.state='CLAIMED' AND e.lease_expires_at<=${started.toISOString()}::timestamptz AND e.lease_expires_at<=clock_timestamp()))
        ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      const clock = time(now());
      if (
        result.rows.length !== 1 ||
        ![
          row.eventId,
          row.siteId,
          row.accountId,
          row.attemptId,
          row.orderId,
        ].every(id) ||
        row.environment !== environment ||
        row.provider !== "ASAAS" ||
        typeof row.isDemo !== "boolean" ||
        (environment === "live" && row.isDemo) ||
        !reference(row.accountReference) ||
        !reference(row.checkoutReference) ||
        row.operationState !== "SUCCEEDED" ||
        row.operationReference !== row.checkoutReference ||
        row.quoteAccountReference !== row.accountReference ||
        !supported.includes(String(row.eventType)) ||
        row.processedAt !== null ||
        !Number.isSafeInteger(row.attempts) ||
        Number(row.attempts) < 0 ||
        !after(clock, row.authenticatedAt) ||
        !after(row.authenticatedAt, row.receivedAt) ||
        !["RECEIVED", "RETRY", "CLAIMED"].includes(String(row.state))
      )
        return unavailable();
      if (
        row.state === "CLAIMED"
          ? !row.leaseExpiresAt || !after(clock, row.leaseExpiresAt)
          : !after(clock, row.nextAttemptAt)
      )
        return unavailable();
      const payload = row.payload as Record<string, string> | null;
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        payload.checkoutId !== row.checkoutReference ||
        (payload.externalReference !== undefined &&
          payload.externalReference !== row.attemptId) ||
        Object.entries(payload).some(
          ([key, value]) =>
            !["checkoutId", "externalReference"].includes(key) ||
            !(key === "externalReference" ? id(value) : reference(value)),
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
        AND e.state=${row.state} AND e.attempts=${row.attempts} AND e.payload_hash=${row.payloadHash}
        AND e.authenticated_at<=clock_timestamp() AND e.processed_at IS NULL`;
      if (Number(row.attempts) >= 12) {
        const saved = await tx.execute(
          sql`UPDATE ${financialEventInbox} e SET state='DEAD_LETTER',last_error_code='CHECKOUT_ATTEMPT_LIMIT' WHERE ${base} RETURNING e.id`,
        );
        if (saved.rows.length !== 1) return unavailable();
        return "DEAD_LETTER";
      }
      const leaseToken = randomUUID();
      const leaseUntil = new Date(clock.getTime() + 60_000);
      const saved =
        await tx.execute(sql`UPDATE ${financialEventInbox} e SET state='CLAIMED', lease_owner=${instanceId},lease_token=${leaseToken},
        lease_expires_at=${leaseUntil.toISOString()}::timestamptz,attempts=e.attempts+1,last_error_code=NULL
        WHERE ${base} AND ${leaseUntil.toISOString()}::timestamptz>clock_timestamp() RETURNING e.id`);
      if (saved.rows.length !== 1 || saved.rows[0]?.id !== row.eventId)
        return unavailable();
      return {
        eventId: String(row.eventId),
        siteId: String(row.siteId),
        accountId: String(row.accountId),
        environment,
        accountReference: row.accountReference,
        attemptId: String(row.attemptId),
        checkoutReference: row.checkoutReference,
        payloadHash: String(row.payloadHash),
        authenticatedAt: time(row.authenticatedAt),
        eventType: String(row.eventType),
        leaseToken,
        attempts: Number(row.attempts) + 1,
      };
    });
  }
  async function complete(claim: Claim, code: string, processed: boolean) {
    const clock = time(now());
    await db.transaction(async (tx) => {
      const mutation = processed
        ? sql`state='PROCESSED',processed_at=${clock.toISOString()}::timestamptz`
        : sql`state='RETRY',next_attempt_at=${new Date(clock.getTime() + 5_000).toISOString()}::timestamptz`;
      const saved =
        await tx.execute(sql`UPDATE ${financialEventInbox} e SET ${mutation},last_error_code=${code}
        WHERE e.id=${claim.eventId} AND e.site_id=${claim.siteId} AND e.account_id=${claim.accountId} AND e.environment=${environment}
          AND e.state='CLAIMED' AND e.event_type=${claim.eventType} AND e.payload_hash=${claim.payloadHash}
          AND e.lease_owner=${instanceId} AND e.lease_token=${claim.leaseToken} AND e.attempts=${claim.attempts}
          AND e.authenticated_at<=${clock.toISOString()}::timestamptz AND e.authenticated_at<=clock_timestamp()
          AND e.lease_expires_at>=${clock.toISOString()}::timestamptz AND e.lease_expires_at>=clock_timestamp()
          AND e.processed_at IS NULL RETURNING e.id`);
      if (saved.rows.length !== 1 || saved.rows[0]?.id !== claim.eventId)
        return unavailable();
    });
  }
  return {
    async processNextReceivedPayment() {
      const event = await claim();
      if (!event) return { kind: "IDLE" };
      if (event === "DEAD_LETTER") return { kind: "DEAD_LETTER" };
      let processed = false;
      let code = "CHECKOUT_PROVIDER_UNAVAILABLE";
      try {
        const observation = await reader.listCheckoutPayments(
          {
            provider: "ASAAS",
            siteId: event.siteId,
            accountBindingId: event.accountId,
            accountReference: event.accountReference,
            environment,
          },
          event.checkoutReference,
        );
        if (
          observation.source !== "provider" ||
          observation.provider !== "ASAAS" ||
          observation.siteId !== event.siteId ||
          observation.accountBindingId !== event.accountId ||
          observation.accountReference !== event.accountReference ||
          observation.environment !== environment ||
          observation.checkoutReference !== event.checkoutReference ||
          !after(observation.observedAt, event.authenticatedAt) ||
          !after(now(), observation.observedAt) ||
          !Array.isArray(observation.payments) ||
          observation.payments.length > 100 ||
          observation.payments.some(
            (payment) =>
              !reference(payment.id) ||
              payment.checkoutSession !== event.checkoutReference ||
              (payment.externalReference != null &&
                payment.externalReference !== event.attemptId),
          )
        )
          return unavailable();
        if (event.eventType === "CHECKOUT_CREATED") {
          processed = true;
          code = "CHECKOUT_CREATED_OBSERVED";
        } else if (event.eventType === "CHECKOUT_PAID") {
          processed = observation.payments.some((payment) =>
            ["CONFIRMED", "RECEIVED"].includes(payment.status),
          );
          code = processed
            ? "CHECKOUT_PAID_OBSERVED"
            : "CHECKOUT_PAYMENT_UNRESOLVED";
        } else {
          processed = observation.payments.length === 0;
          code = processed
            ? `${event.eventType}_EMPTY`
            : "CHECKOUT_PAYMENT_OUTSTANDING";
        }
      } catch {
        /* Keep the durable event retryable when provider evidence is incomplete. */
      }
      await complete(event, code, processed);
      return { kind: processed ? "OBSERVED" : "RETRY" };
    },
  };
}
