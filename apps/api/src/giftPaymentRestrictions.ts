import { createHash } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialLedgerEntry,
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
