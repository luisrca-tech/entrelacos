import { createHash } from "node:crypto";
import {
  allocateGiftInstallmentCents,
  type GiftQuote,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperation,
  giftCheckoutAttempt,
  giftPaymentRecord,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { readFinancialWorkDueAt } from "./financialWorkSchedule";
import type { GiftPaymentWorkerResult } from "./giftPaymentWorker";

/** A checkout still unresolved this long after creation is re-read (spec D9). */
export const GIFT_PAYMENT_RECONCILE_AFTER_MS = 10 * 60_000;
/** Orders older than this are left to the operator (Pix expires long before). */
export const GIFT_PAYMENT_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Inbox events whose processing may post a couple receipt. */
const receiptEvents = new Set([
  "ORDER_PAID",
  "CHARGE_PAID",
  "ORDER_RECONCILE",
  // Receipts recorded before the Pagar.me switch remain readable.
  "PAYMENT_RECEIVED",
  "PAYMENT_SPLIT_DONE",
]);

export function isGiftReceiptEvent(eventType: unknown): boolean {
  return typeof eventType === "string" && receiptEvents.has(eventType);
}

const referencePattern = /^[A-Za-z0-9_-]{1,128}$/;

// One couple credit per provider charge (Pagar.me `ch_` id).
export function giftReceivedEffectKey(
  providerPaymentReference: string,
): string {
  if (!referencePattern.test(providerPaymentReference))
    throw new Error("Invalid provider payment reference");
  return `GIFT_RECEIVED:${createHash("sha256").update(providerPaymentReference, "utf8").digest("hex")}`;
}

/**
 * Money owed for one stored payment. A Pagar.me order has a single charge for
 * the whole quote (installmentNumber null) even when paid in installments;
 * per-installment rows only exist for payments recorded before the switch.
 */
export function giftPaymentTerms(
  quote: Pick<GiftQuote, "totalCents" | "nominalCents" | "commissionCents"> & {
    installmentCount?: number;
    installmentCents?: number[];
  },
  installmentNumber: unknown,
): {
  grossCents: number;
  nominalCents: number;
  commissionCents: number;
} | null {
  const count = quote.installmentCount ?? 1;
  const { totalCents, nominalCents, commissionCents } = quote;
  if (installmentNumber == null)
    return { grossCents: totalCents, nominalCents, commissionCents };
  if (
    count === 1 ||
    typeof installmentNumber !== "number" ||
    !Number.isInteger(installmentNumber) ||
    installmentNumber < 1 ||
    installmentNumber > count
  )
    return null;
  const share = (amount: number) =>
    allocateGiftInstallmentCents(amount, count)[installmentNumber - 1];
  const grossCents = quote.installmentCents?.[installmentNumber - 1];
  return grossCents === undefined
    ? null
    : {
        grossCents,
        nominalCents: share(nominalCents),
        commissionCents: share(commissionCents),
      };
}

export interface GiftPaymentReconcileTarget {
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  attemptId: string;
  /** `or_` id; null when the creating call's outcome is unknown. */
  providerOrderId: string | null;
}

type Database = Pick<DatabaseConnection["db"], "transaction" | "execute">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface GiftPaymentReconciliationOptions {
  environment: "sandbox" | "live";
  now(): Date;
  staleAfterMs?: number;
  /** Queues an ORDER_RECONCILE event; the worker re-reads GET /orders/{id}. */
  enqueue(
    tx: Transaction,
    target: GiftPaymentReconcileTarget,
    sequence: string,
  ): Promise<"INSERTED" | "DUPLICATE">;
  onEnqueued?(): void;
}

function stale(environment: string, now: string, staleAfterMs: number) {
  const window = GIFT_PAYMENT_RECONCILE_WINDOW_MS;
  return sql`op.environment = ${environment} AND op.kind = 'CHECKOUT_CREATE'
    AND op.created_at <= ${now}::timestamptz - make_interval(secs => ${staleAfterMs / 1000})
    AND op.created_at > ${now}::timestamptz - make_interval(secs => ${window / 1000})
    AND (op.state = 'UNKNOWN'
      OR (op.state = 'PROCESSING' AND op.lease_expires_at <= ${now}::timestamptz)
      OR (op.state = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM ${giftPaymentRecord} p
        WHERE p.order_id = op.order_id AND p.site_id = op.site_id AND p.account_id = op.account_id
          AND p.environment = op.environment)))`;
}

/**
 * Sweeps checkouts still pending more than ten minutes after creation (lost
 * webhooks, unknown creation outcomes) and hands each one to the payment
 * worker, which re-reads the order from Pagar.me before posting anything.
 * Each checkout is reconsidered at most once per `staleAfterMs`.
 */
export function createGiftPaymentReconciliation(
  db: Database,
  options: GiftPaymentReconciliationOptions,
) {
  const staleAfterMs = options.staleAfterMs ?? GIFT_PAYMENT_RECONCILE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000)
    throw new RangeError("Reconciliation interval is invalid");
  return {
    async processNextReceivedPayment(): Promise<GiftPaymentWorkerResult> {
      const at = options.now();
      const now = at.toISOString();
      const inserted = await db.transaction(async (tx) => {
        const result =
          await tx.execute(sql`SELECT op.id AS "attemptId", op.site_id AS "siteId",
            op.account_id AS "accountId", op.environment, op.provider_operation_reference AS "providerOrderId"
          FROM ${financialOperation} op
          INNER JOIN ${giftCheckoutAttempt} a ON a.id = op.id AND a.operation_id = op.id AND a.site_id = op.site_id
          WHERE ${stale(options.environment, now, staleAfterMs)}
            AND op.next_attempt_at <= ${now}::timestamptz
          ORDER BY op.next_attempt_at, op.id
          LIMIT 1 FOR UPDATE OF op SKIP LOCKED`);
        const row = result.rows[0];
        if (!row) return null;
        await tx.execute(sql`UPDATE ${financialOperation}
          SET next_attempt_at = ${now}::timestamptz + make_interval(secs => ${staleAfterMs / 1000})
          WHERE id = ${String(row.attemptId)} AND site_id = ${String(row.siteId)}`);
        return options.enqueue(
          tx,
          {
            siteId: String(row.siteId),
            accountId: String(row.accountId),
            environment: options.environment,
            attemptId: String(row.attemptId),
            providerOrderId:
              row.providerOrderId === null ? null : String(row.providerOrderId),
          },
          String(Math.floor(at.getTime() / staleAfterMs)),
        );
      });
      if (inserted === null) return { kind: "IDLE" };
      if (inserted === "INSERTED") {
        try {
          options.onEnqueued?.();
        } catch {}
      }
      return { kind: "OBSERVED" };
    },
    nextDueAt(): Promise<number | null> {
      const now = options.now().toISOString();
      return readFinancialWorkDueAt(
        db,
        sql`GREATEST(op.next_attempt_at, op.created_at + make_interval(secs => ${staleAfterMs / 1000}))`,
        sql`FROM ${financialOperation} op WHERE op.environment = ${options.environment}
          AND op.kind = 'CHECKOUT_CREATE'
          AND op.created_at > ${now}::timestamptz - make_interval(secs => ${GIFT_PAYMENT_RECONCILE_WINDOW_MS / 1000})
          AND (op.state IN ('UNKNOWN', 'PROCESSING') OR (op.state = 'SUCCEEDED' AND NOT EXISTS (
            SELECT 1 FROM ${giftPaymentRecord} p WHERE p.order_id = op.order_id AND p.site_id = op.site_id
              AND p.account_id = op.account_id AND p.environment = op.environment)))`,
      );
    },
  };
}
