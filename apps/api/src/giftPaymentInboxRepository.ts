import { createHash } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  giftCheckoutAttempt,
  giftPaymentRecord,
  receivingAccount,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { insertFinancialOperatorAlert } from "./financialOperatorAlertRepository";
import {
  financialInboxDueAt,
  readFinancialWorkDueAt,
} from "./financialWorkSchedule";
import type { GiftPaymentReconcileTarget } from "./giftPaymentReconciliation";
import {
  hashFinancialEventIdentity,
  type PagarmeInboxEventType,
  type PagarmeWebhookAppendResult,
  type PagarmeWebhookEvent,
} from "./pagarmeWebhook";

/** Delivery id of an internal reconciliation event for one checkout. */
export function giftReconcileDeliveryId(
  attemptId: string,
  sequence: string,
): string {
  return `reconcile:${attemptId}:${sequence}`;
}

/** Event types this worker claims; rows of other types are never touched. */
export const giftPaymentInboxEventTypes: readonly PagarmeInboxEventType[] =
  Object.freeze([
    "ORDER_PAID",
    "ORDER_PAYMENT_FAILED",
    "ORDER_CANCELED",
    "CHARGE_PAID",
    "CHARGE_REFUNDED",
    "CHARGE_CHARGEDBACK",
    "RECIPIENT_UPDATED",
    "ORDER_RECONCILE",
  ]);

/** Normalized, whitelisted correlation references (never money or status). */
export interface GiftPaymentInboxPayload {
  /** Pagar.me order `or_` id. */
  checkoutId?: string;
  /** Pagar.me charge `ch_` id. */
  paymentId?: string;
  /** Our checkout attempt id (the order code). */
  externalReference?: string;
  /** Pagar.me recipient `rp_` id. */
  accountId?: string;
}

export interface GiftPaymentInboxClaim {
  eventId: string;
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  eventType: PagarmeInboxEventType;
  payload: GiftPaymentInboxPayload;
  leaseToken: string;
  attempts: number;
}

export interface GiftPaymentInboxOptions {
  environment: "sandbox" | "live";
  instanceId: string;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  /** Our own recipient: its `recipient.updated` events are not site events. */
  platformRecipientId?: string;
  now(): Date;
  generateId(): string;
}

export class GiftPaymentInboxRepositoryError extends Error {
  readonly status = 503;
  readonly code = "FINANCIAL_INBOX_UNAVAILABLE";
  constructor() {
    super("Financial inbox unavailable");
    this.name = "GiftPaymentInboxRepositoryError";
  }
}

function unavailable(): never {
  throw new GiftPaymentInboxRepositoryError();
}

type Database = Pick<DatabaseConnection["db"], "transaction" | "execute">;
type Executor = Pick<Database, "execute">;

const eventTypeList = sql.join(
  giftPaymentInboxEventTypes.map((type) => sql`${type}`),
  sql`, `,
);

function payloadFor(
  event: Pick<PagarmeWebhookEvent, "orderId" | "chargeId" | "recipientId">,
  attemptId: string | null,
): GiftPaymentInboxPayload {
  const payload: GiftPaymentInboxPayload = {};
  if (event.orderId) payload.checkoutId = event.orderId;
  if (event.chargeId) payload.paymentId = event.chargeId;
  if (attemptId) payload.externalReference = attemptId;
  if (event.recipientId) payload.accountId = event.recipientId;
  return payload;
}

function readPayload(value: unknown): GiftPaymentInboxPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const payload: GiftPaymentInboxPayload = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !["checkoutId", "paymentId", "externalReference", "accountId"].includes(
        key,
      ) ||
      typeof raw !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
    )
      return unavailable();
    payload[key as keyof GiftPaymentInboxPayload] = raw;
  }
  return payload;
}

export function createGiftPaymentInboxRepository(
  db: Database,
  options: GiftPaymentInboxOptions,
) {
  if (
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs < 1_000 ||
    options.leaseMs > 300_000 ||
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isSafeInteger(options.retryDelayMs) ||
    options.retryDelayMs < 1
  )
    return unavailable();
  const environment = options.environment;

  async function insert(
    executor: Executor,
    input: {
      siteId: string;
      accountId: string;
      accountReference: string;
      deliveryId: string;
      eventType: PagarmeInboxEventType;
      payload: GiftPaymentInboxPayload;
      authenticatedAt: Date;
    },
  ): Promise<"INSERTED" | "DUPLICATE"> {
    const at = input.authenticatedAt.toISOString();
    const payload = input.payload as Record<string, string>;
    const result =
      await executor.execute(sql`INSERT INTO ${financialEventInbox} (id, site_id, account_id, environment, delivery_id,
      provider_event_reference, event_type, payload_hash, payload, received_at, authenticated_at, next_attempt_at)
      VALUES (${options.generateId()}, ${input.siteId}, ${input.accountId}, ${environment}, ${input.deliveryId},
        ${input.deliveryId}, ${input.eventType},
        ${hashFinancialEventIdentity(input.deliveryId, input.eventType, input.accountReference, payload)},
        ${JSON.stringify(payload)}::jsonb, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
      ON CONFLICT DO NOTHING RETURNING id`);
    return result.rows.length === 1 ? "INSERTED" : "DUPLICATE";
  }

  async function claim(
    deliveryId: string | null,
  ): Promise<GiftPaymentInboxClaim | null> {
    const now = options.now().toISOString();
    const leaseToken = createHash("sha256")
      .update(`${options.instanceId}:${options.generateId()}`)
      .digest("hex")
      .slice(0, 48);
    const result = await db.execute(sql`UPDATE ${financialEventInbox} e
      SET state = 'CLAIMED', lease_owner = ${options.instanceId}, lease_token = ${leaseToken},
        lease_expires_at = ${now}::timestamptz + make_interval(secs => ${options.leaseMs / 1000}),
        attempts = e.attempts + 1
      WHERE e.id = (
        SELECT c.id FROM ${financialEventInbox} c
        WHERE c.environment = ${environment} AND c.event_type IN (${eventTypeList})
          AND (${deliveryId}::text IS NULL OR c.delivery_id = ${deliveryId})
          AND ((c.state IN ('RECEIVED', 'RETRY') AND c.next_attempt_at <= ${now}::timestamptz)
            OR (c.state = 'CLAIMED' AND c.lease_expires_at <= ${now}::timestamptz))
        ORDER BY c.next_attempt_at, c.id
        LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING e.id AS "eventId", e.site_id AS "siteId", e.account_id AS "accountId", e.environment,
        e.event_type AS "eventType", e.payload, e.attempts`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      eventId: String(row.eventId),
      siteId: String(row.siteId),
      accountId: String(row.accountId),
      environment,
      eventType: row.eventType as PagarmeInboxEventType,
      payload: readPayload(row.payload),
      leaseToken,
      attempts: Number(row.attempts),
    };
  }

  return {
    /** Routes an authenticated webhook to its site/account; dedupes by event id. */
    async append(
      event: PagarmeWebhookEvent,
      authenticatedAt: Date,
    ): Promise<PagarmeWebhookAppendResult> {
      return db.transaction(async (tx) => {
        let scope: Record<string, unknown> | undefined;
        if (event.recipientId) {
          const result =
            await tx.execute(sql`SELECT r.site_id AS "siteId", r.id AS "accountId", r.account_reference AS "accountReference",
              NULL AS "attemptId" FROM ${receivingAccount} r
            WHERE r.environment = ${environment} AND r.provider = 'PAGARME' AND r.is_current = true
              AND r.recipient_reference = ${event.recipientId} LIMIT 2`);
          if (result.rows.length === 1) scope = result.rows[0];
        } else if (event.orderId === null && event.chargeId !== null) {
          // chargeback.received references only the charge: route through
          // the payment it was posted as.
          const result =
            await tx.execute(sql`SELECT a.site_id AS "siteId", a.account_id AS "accountId", a.id AS "attemptId",
              r.account_reference AS "accountReference", a.provider_reference AS "orderId"
            FROM ${giftPaymentRecord} p
            INNER JOIN ${giftCheckoutAttempt} a ON a.id = p.attempt_id AND a.site_id = p.site_id
              AND a.account_id = p.account_id AND a.environment = p.environment
            INNER JOIN ${receivingAccount} r ON r.id = a.account_id AND r.site_id = a.site_id AND r.environment = a.environment
            WHERE p.environment = ${environment} AND p.provider_payment_reference = ${event.chargeId}
            LIMIT 2`);
          if (result.rows.length === 1) scope = result.rows[0];
        } else {
          const result =
            await tx.execute(sql`SELECT a.site_id AS "siteId", a.account_id AS "accountId", a.id AS "attemptId",
              r.account_reference AS "accountReference"
            FROM ${giftCheckoutAttempt} a
            INNER JOIN ${receivingAccount} r ON r.id = a.account_id AND r.site_id = a.site_id AND r.environment = a.environment
            WHERE a.environment = ${environment}
              AND (a.provider_reference = ${event.orderId} OR (a.provider_reference IS NULL AND a.id = ${event.orderCode}))
            LIMIT 2`);
          if (result.rows.length === 1) scope = result.rows[0];
        }
        if (
          !scope ||
          typeof scope.siteId !== "string" ||
          typeof scope.accountId !== "string" ||
          typeof scope.accountReference !== "string"
        ) {
          if (
            event.recipientId !== null &&
            event.recipientId === options.platformRecipientId
          )
            return "UNROUTABLE";
          // One open alert per foreign order/charge/recipient, not per event.
          await insertFinancialOperatorAlert(tx, {
            kind: "UNROUTABLE_PLATFORM_EVENT",
            severity: "warning",
            environment,
            paymentReference:
              event.orderId ??
              event.chargeId ??
              event.recipientId ??
              event.eventId,
            details: {
              type: event.providerType,
              eventId: event.eventId,
              orderId: event.orderId,
              chargeId: event.chargeId,
              recipientId: event.recipientId,
            },
          });
          return "UNROUTABLE";
        }
        return insert(tx, {
          siteId: scope.siteId,
          accountId: scope.accountId,
          accountReference: scope.accountReference,
          deliveryId: event.eventId,
          eventType: event.eventType,
          payload: payloadFor(
            {
              ...event,
              orderId:
                event.orderId ??
                (typeof scope.orderId === "string" ? scope.orderId : null),
            },
            typeof scope.attemptId === "string" ? scope.attemptId : null,
          ),
          authenticatedAt,
        });
      });
    },

    /** Internal reconciliation event: the worker re-reads the order. */
    async enqueueReconcile(
      executor: Executor,
      target: GiftPaymentReconcileTarget,
      sequence: string,
    ): Promise<"INSERTED" | "DUPLICATE"> {
      const account =
        await executor.execute(sql`SELECT account_reference AS "accountReference" FROM ${receivingAccount}
        WHERE id = ${target.accountId} AND site_id = ${target.siteId} AND environment = ${environment}`);
      const accountReference = account.rows[0]?.accountReference;
      if (account.rows.length !== 1 || typeof accountReference !== "string")
        return unavailable();
      return insert(executor, {
        siteId: target.siteId,
        accountId: target.accountId,
        accountReference,
        deliveryId: giftReconcileDeliveryId(target.attemptId, sequence),
        eventType: "ORDER_RECONCILE",
        payload: payloadFor(
          {
            orderId: target.providerOrderId,
            chargeId: null,
            recipientId: null,
          },
          target.attemptId,
        ),
        authenticatedAt: options.now(),
      });
    },

    async claimNext(): Promise<GiftPaymentInboxClaim | null> {
      return claim(null);
    },

    /** Claims one specific event (by delivery id) when it is due. */
    async claimDelivery(
      deliveryId: string,
    ): Promise<GiftPaymentInboxClaim | null> {
      return claim(deliveryId);
    },

    async complete(
      claim: GiftPaymentInboxClaim,
      paymentId: string | null,
    ): Promise<void> {
      const now = options.now().toISOString();
      const result = await db.execute(sql`UPDATE ${financialEventInbox}
        SET state = 'PROCESSED', processed_at = GREATEST(${now}::timestamptz, authenticated_at, received_at),
          payment_id = COALESCE(${paymentId}, payment_id), last_error_code = NULL,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${claim.eventId} AND site_id = ${claim.siteId} AND account_id = ${claim.accountId}
          AND environment = ${claim.environment} AND state = 'CLAIMED' AND lease_token = ${claim.leaseToken}
        RETURNING id`);
      if (result.rows.length !== 1) unavailable();
    },

    async defer(
      claim: GiftPaymentInboxClaim,
      errorCode: string,
    ): Promise<"RETRY" | "DEAD_LETTER"> {
      const state =
        claim.attempts >= options.maxAttempts ? "DEAD_LETTER" : "RETRY";
      const delayMs = Math.min(
        options.retryDelayMs * 2 ** Math.max(0, claim.attempts - 1),
        30 * 60_000,
      );
      const now = options.now().toISOString();
      const result = await db.execute(sql`UPDATE ${financialEventInbox}
        SET state = ${state}, last_error_code = ${errorCode},
          next_attempt_at = ${now}::timestamptz + make_interval(secs => ${delayMs / 1000}),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${claim.eventId} AND site_id = ${claim.siteId} AND account_id = ${claim.accountId}
          AND environment = ${claim.environment} AND state = 'CLAIMED' AND lease_token = ${claim.leaseToken}
        RETURNING id`);
      if (result.rows.length !== 1) unavailable();
      return state;
    },

    nextDueAt(): Promise<number | null> {
      return readFinancialWorkDueAt(
        db,
        financialInboxDueAt,
        sql`FROM ${financialEventInbox} e WHERE e.environment = ${environment}
          AND e.event_type IN (${eventTypeList}) AND e.state IN ('RECEIVED', 'RETRY', 'CLAIMED')`,
      );
    },
  };
}

export type GiftPaymentInboxRepository = ReturnType<
  typeof createGiftPaymentInboxRepository
>;
