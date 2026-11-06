import { randomUUID } from "node:crypto";
import {
  giftInstallmentExpiryMinutes,
  giftQuoteSchema,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftCheckoutAttempt,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { type SQL, sql } from "drizzle-orm";
import type { AsaasStoredAccountReader } from "./asaasStoredAccountReader";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { FinancialAccountBinding } from "./financialOverview";
import { serializeBrlCents } from "./giftMoney";
import type { GiftPaymentWorker } from "./giftPaymentWorker";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";

interface Options extends LiveSitePolicy {
  applicationEnvironment?: "development" | "test" | "production";
  db: Pick<DatabaseConnection["db"], "transaction">;
  environment: "sandbox" | "live";
  instanceId: string;
  reader: Pick<
    AsaasStoredAccountReader,
    | "listCheckoutPayments"
    | "getInstallmentRemoval"
    | "listInstallmentPayments"
    | "removeInstallment"
  >;
  now(): Date;
}
const expiryDispatched = "INSTALLMENT_EXPIRY_DISPATCHED";
export const giftInstallmentExpiryConfirmedCode =
  "INSTALLMENT_EXPIRY_CONFIRMED";

const supported = [
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "PAYMENT_DELETED",
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
  orderId: string;
  checkoutReference: string;
  payloadHash: string;
  authenticatedAt: Date;
  eventType: string;
  leaseToken: string;
  attempts: number;
}

type CheckoutScope = Pick<
  Claim,
  | "siteId"
  | "accountId"
  | "orderId"
  | "attemptId"
  | "checkoutReference"
  | "environment"
>;
export function readInstallmentExpiryPaymentReferences(
  value: unknown,
  count: number,
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every(reference) ||
    new Set(value).size !== count
  )
    return null;
  return [...value].sort();
}

function paymentReferenceArray(references: string[]) {
  return sql`ARRAY[${sql.join(
    references.map((ref) => sql`${ref}`),
    sql`, `,
  )}]::text[]`;
}

export function checkoutPaymentFacts(
  scope: { [Field in keyof CheckoutScope]: CheckoutScope[Field] | SQL },
  paymentReferences: string[] = [],
) {
  return sql`SELECT 1 FROM ${giftPaymentRecord} p
    WHERE p.order_id=${scope.orderId} AND p.site_id=${scope.siteId} AND p.account_id=${scope.accountId} AND p.environment=${scope.environment}
      AND (p.verification_status<>'VERIFIED' OR p.provider_status IS NULL OR p.provider_status NOT IN ('PENDING','OVERDUE')
        OR p.attempt_id<>${scope.attemptId} OR p.provider_installment_reference IS DISTINCT FROM ${scope.checkoutReference})
    UNION ALL
    SELECT 1 FROM ${financialLedgerEntry} l
    WHERE l.site_id=${scope.siteId} AND l.account_id=${scope.accountId} AND l.environment=${scope.environment}
      AND (l.operation_id=${scope.attemptId} OR l.payment_id IN (SELECT p.id FROM ${giftPaymentRecord} p
        WHERE p.order_id=${scope.orderId} AND p.site_id=l.site_id AND p.account_id=l.account_id AND p.environment=l.environment))
    UNION ALL
    SELECT 1 FROM ${financialEventInbox} e
    WHERE e.site_id=${scope.siteId} AND e.account_id=${scope.accountId} AND e.environment=${scope.environment}
      AND e.authenticated_at IS NOT NULL
      AND (e.payload->>'externalReference'=${scope.attemptId} OR e.payload->>'checkoutId'=${scope.checkoutReference}
        OR e.payload->>'paymentId' IN (SELECT p.provider_payment_reference FROM ${giftPaymentRecord} p
          WHERE p.order_id=${scope.orderId} AND p.site_id=e.site_id AND p.account_id=e.account_id AND p.environment=e.environment)
        OR e.payload->>'paymentId' IN (
          SELECT unnest(expiry_attempt.installment_expiry_payment_references) FROM ${giftCheckoutAttempt} expiry_attempt
          WHERE expiry_attempt.id=${scope.attemptId} AND expiry_attempt.order_id=${scope.orderId}
            AND expiry_attempt.site_id=e.site_id AND expiry_attempt.account_id=e.account_id AND expiry_attempt.environment=e.environment
            AND expiry_attempt.provider_reference=${scope.checkoutReference})
        ${
          paymentReferences.length
            ? sql`OR e.payload->>'paymentId' IN (${sql.join(
                paymentReferences.map((ref) => sql`${ref}`),
                sql`, `,
              )})`
            : sql``
        })
      AND (e.event_type IN ('PAYMENT_CONFIRMED','PAYMENT_RECEIVED','PAYMENT_SPLIT_DONE','PAYMENT_AUTHORIZED',
        'PAYMENT_AWAITING_RISK_ANALYSIS','PAYMENT_APPROVED_BY_RISK_ANALYSIS','PAYMENT_AWAITING_CHARGEBACK_REVERSAL')
        OR e.event_type LIKE 'PAYMENT_REFUND%' OR e.event_type LIKE 'PAYMENT_CHARGEBACK%')
    LIMIT 1`;
}

// This worker consumes journey events. It never posts a receipt or changes a purchase snapshot.
export function createGiftCheckoutLifecycleWorker(
  options: Options,
): GiftPaymentWorker & {
  expireNextUnpaidInstallment: GiftPaymentWorker["processNextReceivedPayment"];
} {
  const { db, environment, instanceId, reader, now } = options;
  const liveDemoSiteId = allowsLiveSite({
    siteId: options.liveDemoSiteId ?? "",
    isDemo: true,
    mode: environment,
    applicationEnvironment: options.applicationEnvironment ?? "test",
    liveDemoSiteId: options.liveDemoSiteId,
  })
    ? options.liveDemoSiteId
    : null;
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
        q.snapshot->'receiving'->>'accountReference' AS "quoteAccountReference",
        q.snapshot->'quote'->'installmentCount' AS "installmentCount"
        FROM ${financialEventInbox} e
        INNER JOIN ${receivingAccount} account ON account.id=e.account_id AND account.site_id=e.site_id AND account.environment=e.environment
        INNER JOIN ${site} st ON st.id=e.site_id
        INNER JOIN ${giftCheckoutAttempt} a ON a.site_id=e.site_id AND a.account_id=e.account_id AND a.environment=e.environment AND (
          (e.event_type<>'PAYMENT_DELETED' AND a.provider_reference=e.payload->>'checkoutId') OR
          (e.event_type='PAYMENT_DELETED' AND a.provider_reference=e.payload->>'installmentId' AND a.id=e.payload->>'externalReference')
        )
        INNER JOIN ${giftOrder} o ON o.id=a.order_id AND o.site_id=a.site_id AND o.account_id=a.account_id AND o.environment=a.environment
        INNER JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=o.site_id AND q.account_id=o.account_id AND q.environment=o.environment
        INNER JOIN ${financialOperation} op ON op.id=a.operation_id AND op.site_id=a.site_id AND op.account_id=a.account_id AND op.environment=a.environment
          AND op.order_id=a.order_id AND op.kind=a.operation_kind AND op.kind='CHECKOUT_CREATE'
        WHERE e.environment=${environment} AND account.provider='ASAAS' AND (${environment}<>'live' OR st.is_demo=false OR st.id=${liveDemoSiteId})
          AND e.event_type IN ('CHECKOUT_CREATED','CHECKOUT_PAID','CHECKOUT_CANCELED','CHECKOUT_EXPIRED','PAYMENT_DELETED') AND e.authenticated_at IS NOT NULL
          AND (e.event_type<>'PAYMENT_DELETED' OR (q.method='CREDIT_CARD' AND q.snapshot->'quote'->>'settlementVersion'='PLATFORM_FEE_GUARANTEE_V1'))
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
        (environment === "live" &&
          row.isDemo &&
          row.siteId !== liveDemoSiteId) ||
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
      const planDeleted = row.eventType === "PAYMENT_DELETED";
      const allowedPayload = planDeleted
        ? ["installmentId", "paymentId", "externalReference"]
        : ["checkoutId", "externalReference"];
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (planDeleted
          ? payload.installmentId !== row.checkoutReference ||
            payload.externalReference !== row.attemptId ||
            !reference(payload.paymentId) ||
            !Number.isInteger(row.installmentCount) ||
            Number(row.installmentCount) < 2 ||
            Number(row.installmentCount) > 12
          : payload.checkoutId !== row.checkoutReference) ||
        (payload.externalReference !== undefined &&
          payload.externalReference !== row.attemptId) ||
        Object.entries(payload).some(
          ([key, value]) =>
            !allowedPayload.includes(key) ||
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
        orderId: String(row.orderId),
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
    return db.transaction(async (tx) => {
      if (processed && claim.eventType === "PAYMENT_DELETED") {
        // Use the same order lock as receipt posting and checkout reservation.
        const locked = await tx.execute(sql`SELECT o.id FROM ${giftOrder} o
          WHERE o.id=${claim.orderId} AND o.site_id=${claim.siteId} AND o.account_id=${claim.accountId} AND o.environment=${environment}
          FOR UPDATE OF o`);
        if (locked.rows.length !== 1 || locked.rows[0]?.id !== claim.orderId)
          return unavailable();
        const outstanding = await tx.execute(checkoutPaymentFacts(claim));
        if (outstanding.rows.length) {
          processed = false;
          code = "CHECKOUT_PAYMENT_OUTSTANDING";
        }
      }
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
      return processed;
    });
  }
  async function claimExpiredPlan() {
    const started = time(now());
    return db.transaction(async (tx) => {
      const result =
        await tx.execute(sql`SELECT a.id AS "attemptId", o.id AS "orderId", a.site_id AS "siteId",
        a.account_id AS "accountId", a.provider_reference AS "checkoutReference", account.account_reference AS "accountReference",
        q.snapshot->'quote' AS quote, op.updated_at AS "createdAt", op.last_error_code AS "lastErrorCode",
        a.installment_expiry_payment_references AS "expiryPaymentReferences"
        FROM ${giftCheckoutAttempt} a
        JOIN ${giftOrder} o ON o.id=a.order_id AND o.site_id=a.site_id AND o.account_id=a.account_id AND o.environment=a.environment
        JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=o.site_id AND q.account_id=o.account_id AND q.environment=o.environment
        JOIN ${financialOperation} op ON op.id=a.id AND op.id=a.operation_id AND op.order_id=a.order_id AND op.site_id=a.site_id
          AND op.account_id=a.account_id AND op.environment=a.environment AND op.kind=a.operation_kind AND op.kind='CHECKOUT_CREATE'
        JOIN ${receivingAccount} account ON account.id=a.account_id AND account.site_id=a.site_id AND account.environment=a.environment
        JOIN ${site} st ON st.id=a.site_id
        WHERE a.environment=${environment} AND (${environment}<>'live' OR NOT st.is_demo OR st.id=${liveDemoSiteId})
          AND account.provider='ASAAS' AND account.account_reference=q.snapshot->'receiving'->>'accountReference'
          AND a.hosted_url IS NOT NULL AND op.state='SUCCEEDED' AND op.provider_operation_reference=a.provider_reference
          AND q.method='CREDIT_CARD' AND q.snapshot->'quote'->>'settlementVersion'='PLATFORM_FEE_GUARANTEE_V1'
          AND q.snapshot->'quote'->'installmentCount' BETWEEN '2'::jsonb AND '12'::jsonb
          AND op.updated_at+(${giftInstallmentExpiryMinutes}::int * interval '1 minute')<=LEAST(${started.toISOString()}::timestamptz,clock_timestamp())
          AND op.next_attempt_at<=clock_timestamp()
          AND (op.last_error_code IS NULL OR op.last_error_code=${expiryDispatched})
          AND NOT EXISTS (${checkoutPaymentFacts({
            siteId: sql`a.site_id`,
            accountId: sql`a.account_id`,
            orderId: sql`o.id`,
            attemptId: sql`a.id`,
            checkoutReference: sql`a.provider_reference`,
            environment,
          })})
          AND NOT EXISTS (SELECT 1 FROM ${financialEventInbox} e
            WHERE e.site_id=a.site_id AND e.account_id=a.account_id AND e.environment=a.environment
              AND e.payload->>'externalReference'=a.id AND e.payload->>'installmentId'=a.provider_reference
              AND e.event_type='PAYMENT_DELETED' AND e.state='PROCESSED' AND e.last_error_code='PAYMENT_DELETED_INSTALLMENT_EMPTY')
        ORDER BY op.next_attempt_at, a.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);
      const row = result.rows[0];
      if (!row) return null;
      const quote = giftQuoteSchema.parse(row.quote);
      const createdAt = time(row.createdAt);
      if (
        !id(row.attemptId) ||
        !id(row.orderId) ||
        !id(row.siteId) ||
        !id(row.accountId) ||
        !reference(row.checkoutReference) ||
        !reference(row.accountReference) ||
        quote.siteId !== row.siteId ||
        quote.mode !== environment ||
        quote.method !== "CREDIT_CARD" ||
        quote.settlementVersion !== "PLATFORM_FEE_GUARANTEE_V1" ||
        !quote.installmentCount ||
        quote.installmentCount < 2 ||
        !quote.installmentCents ||
        started.getTime() - createdAt.getTime() <
          giftInstallmentExpiryMinutes * 60_000
      )
        return unavailable();
      const scope = {
        attemptId: row.attemptId,
        orderId: row.orderId,
        siteId: row.siteId,
        accountId: row.accountId,
        checkoutReference: row.checkoutReference,
        environment,
      };
      const claimed = await tx.execute(sql`UPDATE ${financialOperation} op
        SET next_attempt_at=clock_timestamp()+interval '5 minutes'
        WHERE op.id=${scope.attemptId} AND op.site_id=${scope.siteId} AND op.account_id=${scope.accountId}
          AND op.environment=${environment} AND op.order_id=${scope.orderId} AND op.kind='CHECKOUT_CREATE'
          AND op.state='SUCCEEDED' AND op.provider_operation_reference=${scope.checkoutReference} AND op.next_attempt_at<=clock_timestamp()
        RETURNING next_attempt_at::text AS "retryAt"`);
      if (claimed.rows.length !== 1) return unavailable();
      if ((await tx.execute(checkoutPaymentFacts(scope))).rows.length)
        return null;
      const dispatched = row.lastErrorCode === expiryDispatched;
      const references = dispatched
        ? readInstallmentExpiryPaymentReferences(
            row.expiryPaymentReferences,
            quote.installmentCount,
          )
        : [];
      if (!references) return unavailable();
      const retryAt = claimed.rows[0]?.retryAt;
      time(retryAt);
      return {
        scope,
        quote,
        accountReference: row.accountReference,
        retryAt: String(retryAt),
        dispatched,
        references,
      };
    });
  }

  async function readRemovedPlan(
    binding: FinancialAccountBinding,
    installmentReference: string,
    since: Date,
  ) {
    const plan = await reader.getInstallmentRemoval(
      binding,
      installmentReference,
    );
    if (
      plan.source !== "provider" ||
      plan.provider !== "ASAAS" ||
      plan.siteId !== binding.siteId ||
      plan.accountBindingId !== binding.accountBindingId ||
      plan.accountReference !== binding.accountReference ||
      plan.environment !== binding.environment ||
      plan.installmentReference !== installmentReference ||
      !after(plan.observedAt, since) ||
      !after(now(), plan.observedAt)
    )
      return unavailable();
    return plan.removed === true ? time(plan.observedAt) : null;
  }

  async function persistExpiry(
    scope: CheckoutScope,
    retryAt: string,
    paymentReferences: string[],
    removedAt?: Date,
  ) {
    return db.transaction(async (tx) => {
      const operationScope = sql`op.id=${scope.attemptId} AND op.site_id=${scope.siteId}
        AND op.account_id=${scope.accountId} AND op.environment=${environment} AND op.order_id=${scope.orderId}
        AND op.kind='CHECKOUT_CREATE' AND op.state='SUCCEEDED' AND op.provider_operation_reference=${scope.checkoutReference}
        AND op.next_attempt_at=${retryAt}::timestamptz AND op.next_attempt_at>clock_timestamp()`;
      const locked = await tx.execute(sql`SELECT o.id FROM ${giftOrder} o
        JOIN ${financialOperation} op ON op.order_id=o.id AND op.site_id=o.site_id AND op.account_id=o.account_id AND op.environment=o.environment
        WHERE ${operationScope} FOR UPDATE OF o`);
      if (
        locked.rows.length !== 1 ||
        locked.rows[0]?.id !== scope.orderId ||
        (await tx.execute(checkoutPaymentFacts(scope, paymentReferences))).rows
          .length
      )
        return false;
      const references = paymentReferenceArray([...paymentReferences].sort());
      const attemptScope = sql`a.id=${scope.attemptId} AND a.site_id=${scope.siteId} AND a.account_id=${scope.accountId}
        AND a.environment=${environment} AND a.order_id=${scope.orderId} AND a.operation_id=${scope.attemptId}
        AND a.operation_kind='CHECKOUT_CREATE' AND a.provider_reference=${scope.checkoutReference}`;
      if (!removedAt) {
        const savedAttempt =
          await tx.execute(sql`UPDATE ${giftCheckoutAttempt} a
          SET installment_expiry_payment_references=${references}
          WHERE ${attemptScope} AND (a.installment_expiry_payment_references IS NULL OR a.installment_expiry_payment_references=${references})
          RETURNING a.id`);
        if (
          savedAttempt.rows.length !== 1 ||
          savedAttempt.rows[0]?.id !== scope.attemptId
        )
          return false;
      }
      const marker = removedAt
        ? sql`last_error_code=${giftInstallmentExpiryConfirmedCode}, updated_at=${removedAt.toISOString()}::timestamptz`
        : sql`last_error_code=${expiryDispatched}`;
      const prior = removedAt
        ? sql`op.last_error_code=${expiryDispatched}`
        : sql`(op.last_error_code IS NULL OR op.last_error_code=${expiryDispatched})`;
      const saved =
        await tx.execute(sql`UPDATE ${financialOperation} op SET ${marker}
        WHERE ${operationScope} AND ${prior}
          AND EXISTS (SELECT 1 FROM ${giftCheckoutAttempt} a WHERE ${attemptScope} AND a.installment_expiry_payment_references=${references})
        RETURNING op.id`);
      if (saved.rows.length !== 1 || saved.rows[0]?.id !== scope.attemptId)
        return unavailable();
      return true;
    });
  }

  return {
    async expireNextUnpaidInstallment() {
      if (
        environment === "live" &&
        options.applicationEnvironment !== "production"
      )
        return { kind: "IDLE" };
      const claimed = await claimExpiredPlan();
      if (!claimed) return { kind: "IDLE" };
      const {
        scope,
        quote,
        accountReference,
        retryAt,
        dispatched,
        references,
      } = claimed;
      const binding = {
        provider: "ASAAS" as const,
        siteId: scope.siteId,
        accountBindingId: scope.accountId,
        accountReference,
        environment,
      };
      const started = time(now());
      if (dispatched) {
        const removedAt = await readRemovedPlan(
          binding,
          scope.checkoutReference,
          started,
        );
        if (removedAt) {
          const closed = await persistExpiry(
            scope,
            retryAt,
            references,
            removedAt,
          );
          return { kind: closed ? "OBSERVED" : "RETRY" };
        }
      }
      const observation = await reader.listInstallmentPayments(
        binding,
        scope.checkoutReference,
      );
      if (
        observation.source !== "provider" ||
        observation.provider !== "ASAAS" ||
        observation.siteId !== scope.siteId ||
        observation.accountBindingId !== scope.accountId ||
        observation.accountReference !== accountReference ||
        observation.environment !== environment ||
        observation.installmentReference !== scope.checkoutReference ||
        !after(observation.observedAt, started) ||
        !after(now(), observation.observedAt) ||
        !Array.isArray(observation.payments) ||
        observation.payments.length !== quote.installmentCount
      )
        return { kind: "RETRY" };
      const paymentIds = new Set<string>();
      const positions = new Set<number>();
      for (const payment of observation.payments) {
        const position = payment.installmentNumber;
        if (
          !reference(payment.id) ||
          paymentIds.has(payment.id) ||
          payment.installment !== scope.checkoutReference ||
          payment.externalReference !== scope.attemptId ||
          payment.checkoutSession != null ||
          payment.billingType !== "CREDIT_CARD" ||
          !["PENDING", "OVERDUE"].includes(payment.status) ||
          payment.deleted === true ||
          payment.chargeback != null ||
          payment.custody != null ||
          (payment.refunds != null && payment.refunds.length > 0) ||
          typeof position !== "number" ||
          !Number.isInteger(position) ||
          positions.has(position) ||
          position < 1 ||
          position > observation.payments.length ||
          payment.value !==
            serializeBrlCents(quote.installmentCents?.[position - 1] ?? 0)
        )
          return { kind: "RETRY" };
        paymentIds.add(payment.id);
        positions.add(position);
      }
      if (!(await persistExpiry(scope, retryAt, [...paymentIds])))
        return { kind: "RETRY" };
      // Asaas rechecks payment eligibility and permanently removes this exact plan.
      const dispatchedAt = time(now());
      await reader.removeInstallment(binding, scope.checkoutReference);
      const removedAt = await readRemovedPlan(
        binding,
        scope.checkoutReference,
        dispatchedAt,
      );
      const closed =
        removedAt &&
        (await persistExpiry(scope, retryAt, [...paymentIds], removedAt));
      return { kind: closed ? "OBSERVED" : "RETRY" };
    },
    async processNextReceivedPayment() {
      const event = await claim();
      if (!event) return { kind: "IDLE" };
      if (event === "DEAD_LETTER") return { kind: "DEAD_LETTER" };
      let processed = false;
      let code = "CHECKOUT_PROVIDER_UNAVAILABLE";
      const binding = {
        provider: "ASAAS" as const,
        siteId: event.siteId,
        accountBindingId: event.accountId,
        accountReference: event.accountReference,
        environment,
      };
      try {
        if (event.eventType === "PAYMENT_DELETED") {
          processed =
            (await readRemovedPlan(
              binding,
              event.checkoutReference,
              event.authenticatedAt,
            )) !== null;
          code = processed
            ? "PAYMENT_DELETED_INSTALLMENT_EMPTY"
            : "CHECKOUT_PAYMENT_OUTSTANDING";
        } else {
          const observation = await reader.listCheckoutPayments(
            binding,
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
        }
      } catch {
        /* Keep the durable event retryable when provider evidence is incomplete. */
      }
      const completed = await complete(event, code, processed);
      return { kind: completed ? "OBSERVED" : "RETRY" };
    },
  };
}
