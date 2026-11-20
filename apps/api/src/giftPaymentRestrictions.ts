import { createHash } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialLedgerEntry,
  financialOperatorAlert,
  giftPaymentRecord,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { insertFinancialOperatorAlert } from "./financialOperatorAlertRepository";

export type GiftPaymentReversal = "REFUND" | "CHARGEBACK";

type Executor = Pick<DatabaseConnection["db"], "execute">;

export interface GiftPaymentReversalInput {
  siteId: string;
  accountId: string;
  environment: "sandbox" | "live";
  attemptId: string;
  paymentId: string;
  providerOrderId: string;
  chargeId: string;
  reversal: GiftPaymentReversal;
  eventId: string;
  observedAt: Date;
  generateId(): string;
}

export interface GiftPaymentReversalResult {
  changed: boolean;
  ledgerEntryId: string | null;
}

const statuses = { REFUND: "REFUNDED", CHARGEBACK: "CHARGEBACK" } as const;
const ledgerKinds = {
  REFUND: "GIFT_REFUNDED",
  CHARGEBACK: "GIFT_CHARGEBACK",
} as const;

export function giftReversalEffectKey(
  reversal: GiftPaymentReversal,
  chargeId: string,
): string {
  return `${ledgerKinds[reversal]}:${createHash("sha256").update(chargeId, "utf8").digest("hex")}`;
}

function unavailable(): never {
  throw new Error("Gift payment reversal unavailable");
}

/** Statuses of a payment whose receipt is final and not reversed. */
export const settledGiftPaymentStatuses = Object.freeze([
  "PENDING",
  "AUTHORIZED",
  "CONFIRMED",
  "RECEIVED",
  "OVERDUE",
] as const);

/**
 * Whether a refund/chargeback no longer blocks withdrawals or the finance
 * overview. The reversal must be compensated in the ledger (a debit of the
 * same amount linked to the couple credit) and then either:
 * - the account ledger is not negative, i.e. later gifts covered the debit
 *   (the block clears by itself), or
 * - an operator resolved the reversal alert (explicit write-off decision).
 */
export function isGiftReversalResolved(input: {
  providerStatus: string;
  compensated: boolean;
  ledgerBalanceCents: bigint;
  alertResolved: boolean;
}): boolean {
  return (
    (input.providerStatus === "REFUNDED" ||
      input.providerStatus === "CHARGEBACK") &&
    input.compensated &&
    (input.ledgerBalanceCents >= 0n || input.alertResolved)
  );
}

/**
 * SQL twin of the rule above for a `gift_payment_record` aliased `p`: true
 * while the payment still blocks withdrawals (unknown, unverified or an
 * unresolved reversal).
 */
export const unresolvedGiftPaymentSql = sql`(p.provider_status IS NULL OR p.verification_status <> 'VERIFIED'
  OR (p.provider_status NOT IN ('PENDING','AUTHORIZED','CONFIRMED','RECEIVED','OVERDUE')
    AND NOT (p.provider_status IN ('REFUNDED','CHARGEBACK')
      AND EXISTS (SELECT 1 FROM ${financialLedgerEntry} rc
        INNER JOIN ${financialLedgerEntry} rd ON rd.compensates_entry_id = rc.id AND rd.site_id = rc.site_id
          AND rd.account_id = rc.account_id AND rd.environment = rc.environment
        WHERE rc.payment_id = p.id AND rc.site_id = p.site_id AND rc.account_id = p.account_id
          AND rc.environment = p.environment AND rc.kind = 'GIFT_RECEIVED' AND rc.direction = 'CREDIT'
          AND rd.direction = 'DEBIT' AND rd.amount_cents = rc.amount_cents
          AND rd.kind = CASE p.provider_status WHEN 'REFUNDED' THEN 'GIFT_REFUNDED' ELSE 'GIFT_CHARGEBACK' END)
      AND ((SELECT COALESCE(SUM(CASE WHEN rb.direction = 'CREDIT' THEN rb.amount_cents ELSE -rb.amount_cents END), 0)
          FROM ${financialLedgerEntry} rb
          WHERE rb.site_id = p.site_id AND rb.account_id = p.account_id AND rb.environment = p.environment) >= 0
        OR EXISTS (SELECT 1 FROM ${financialOperatorAlert} ra
          WHERE ra.environment = p.environment AND ra.payment_reference = p.provider_payment_reference
            AND ra.kind = CASE p.provider_status WHEN 'REFUNDED' THEN 'GIFT_REFUNDED' ELSE 'GIFT_CHARGEBACK' END
            AND ra.resolved_at IS NOT NULL)))))`;

/**
 * Refund (operator `DELETE /charges/{id}`) or chargeback observed on a
 * re-read charge: the payment is marked restricted, the couple credit is
 * compensated once by a debit and an operator alert is opened (spec D11).
 * Runs inside the caller's transaction, after the payment row is locked.
 */
export async function postGiftPaymentReversal(
  tx: Executor,
  input: GiftPaymentReversalInput,
): Promise<GiftPaymentReversalResult> {
  const status = statuses[input.reversal];
  const at = input.observedAt.toISOString();
  const updated = await tx.execute(sql`UPDATE ${giftPaymentRecord}
    SET provider_status = ${status}, observed_at = GREATEST(observed_at, ${at}::timestamptz)
    WHERE id = ${input.paymentId} AND site_id = ${input.siteId} AND account_id = ${input.accountId}
      AND environment = ${input.environment} AND provider_payment_reference = ${input.chargeId}
      AND provider_status IS DISTINCT FROM ${status}
    RETURNING id`);
  const credit =
    await tx.execute(sql`SELECT l.id, l.amount_cents AS "amountCents",
      EXISTS (SELECT 1 FROM ${financialLedgerEntry} d WHERE d.compensates_entry_id = l.id
        AND d.site_id = l.site_id AND d.account_id = l.account_id AND d.environment = l.environment) AS compensated
    FROM ${financialLedgerEntry} l
    WHERE l.payment_id = ${input.paymentId} AND l.site_id = ${input.siteId} AND l.account_id = ${input.accountId}
      AND l.environment = ${input.environment} AND l.kind = 'GIFT_RECEIVED' AND l.direction = 'CREDIT'
    FOR UPDATE OF l`);
  if (credit.rows.length > 1) return unavailable();
  let ledgerEntryId: string | null = null;
  const original = credit.rows[0];
  if (original && original.compensated !== true) {
    ledgerEntryId = input.generateId();
    const inserted =
      await tx.execute(sql`INSERT INTO ${financialLedgerEntry} (id, site_id, account_id, environment, effect_key, kind,
        direction, currency, amount_cents, payment_id, operation_id, event_id, compensates_entry_id, created_at)
      VALUES (${ledgerEntryId}, ${input.siteId}, ${input.accountId}, ${input.environment},
        ${giftReversalEffectKey(input.reversal, input.chargeId)}, ${ledgerKinds[input.reversal]}, 'DEBIT', 'BRL',
        ${Number(original.amountCents)}, ${input.paymentId}, ${input.attemptId}, ${input.eventId}, ${String(original.id)},
        ${at}::timestamptz)
      ON CONFLICT (site_id, account_id, environment, effect_key) DO NOTHING RETURNING id`);
    if (inserted.rows.length !== 1) ledgerEntryId = null;
  }
  const alerted = await insertFinancialOperatorAlert(tx, {
    kind: input.reversal === "REFUND" ? "GIFT_REFUNDED" : "GIFT_CHARGEBACK",
    severity: input.reversal === "REFUND" ? "warning" : "critical",
    environment: input.environment,
    siteId: input.siteId,
    accountId: input.accountId,
    checkoutAttemptId: input.attemptId,
    paymentReference: input.chargeId,
    details: {
      orderId: input.providerOrderId,
      debitedCents:
        ledgerEntryId && original ? Number(original.amountCents) : null,
    },
  });
  return {
    changed: updated.rows.length === 1 || ledgerEntryId !== null || alerted,
    ledgerEntryId,
  };
}
