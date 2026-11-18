import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialLedgerEntry,
  financialOperation,
  giftPaymentRecord,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { insertFinancialOperatorAlert } from "./financialOperatorAlertRepository";
import type {
  GiftCheckoutOrderBinding,
  GiftOrderTransition,
} from "./giftCheckoutLifecycle";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";
import { postGiftPaymentReversal } from "./giftPaymentRestrictions";

export interface GiftOrderPostingInput {
  binding: GiftCheckoutOrderBinding;
  /** The `or_` id of the re-read order. */
  providerOrderId: string;
  transition: GiftOrderTransition;
  /** Inbox event that triggered the re-read; every receipt cites one. */
  eventId: string;
  observedAt: Date;
}

export interface GiftOrderPostingResult {
  outcome: "POSTED" | "CLOSED" | "REVERSED" | "UNCHANGED" | "MISMATCH";
  paymentId: string | null;
  ledgerEntryId: string | null;
}

export interface GiftPaymentPostingRepository {
  applyOrderTransition(
    input: GiftOrderPostingInput,
  ): Promise<GiftOrderPostingResult>;
}

export interface GiftPaymentPostingOptions {
  generateId(kind: "payment" | "ledger" | "alert"): string;
}

export class GiftPaymentPostingRepositoryError extends Error {
  readonly status = 503;
  readonly code = "PAYMENT_POSTING_UNAVAILABLE";
  constructor() {
    super("Gift payment posting unavailable");
    this.name = "GiftPaymentPostingRepositoryError";
  }
}

function unavailable(): never {
  throw new GiftPaymentPostingRepositoryError();
}

type Database = Pick<DatabaseConnection["db"], "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const closedStates = {
  FAILED: { state: "FAILED", code: "ORDER_FAILED" },
  CANCELED: { state: "CANCELLED", code: "ORDER_CANCELED" },
  EXPIRED: { state: "CANCELLED", code: "ORDER_EXPIRED" },
} as const;

/**
 * Writes the effects of a re-read Pagar.me order. One gift_payment_record per
 * charge: gross G, commission, couple net V (the couple split C minus the
 * anticipation the couple recipient pays), platform share G − C. The couple
 * ledger is credited V once per charge (effect key per charge id).
 */
export function createGiftPaymentPostingRepository(
  db: Database,
  options: GiftPaymentPostingOptions,
): GiftPaymentPostingRepository {
  async function lockOperation(tx: Transaction, input: GiftOrderPostingInput) {
    const { binding } = input;
    const result =
      await tx.execute(sql`SELECT op.state, op.provider_operation_reference AS "providerReference"
      FROM ${financialOperation} op
      WHERE op.id = ${binding.attemptId} AND op.site_id = ${binding.siteId} AND op.account_id = ${binding.accountId}
        AND op.environment = ${binding.environment} AND op.order_id = ${binding.orderId} AND op.kind = 'CHECKOUT_CREATE'
      FOR UPDATE`);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) return unavailable();
    if (
      row.providerReference !== null &&
      row.providerReference !== input.providerOrderId
    )
      return unavailable();
    return { state: String(row.state) };
  }

  async function findPayment(
    tx: Transaction,
    binding: GiftCheckoutOrderBinding,
    chargeId: string,
  ) {
    const result =
      await tx.execute(sql`SELECT p.id, p.order_id AS "orderId", p.attempt_id AS "attemptId"
      FROM ${giftPaymentRecord} p
      WHERE p.site_id = ${binding.siteId} AND p.account_id = ${binding.accountId}
        AND p.environment = ${binding.environment} AND p.provider_payment_reference = ${chargeId}
      FOR UPDATE`);
    const row = result.rows[0];
    if (!row) return null;
    if (row.orderId !== binding.orderId || row.attemptId !== binding.attemptId)
      return unavailable();
    return String(row.id);
  }

  async function anyPayment(
    tx: Transaction,
    binding: GiftCheckoutOrderBinding,
  ) {
    const result = await tx.execute(sql`SELECT 1 FROM ${giftPaymentRecord} p
      WHERE p.site_id = ${binding.siteId} AND p.account_id = ${binding.accountId}
        AND p.environment = ${binding.environment} AND p.order_id = ${binding.orderId} LIMIT 1`);
    return result.rows.length > 0;
  }

  async function bindOperation(
    tx: Transaction,
    input: GiftOrderPostingInput,
    current: string,
  ) {
    if (current === "SUCCEEDED") return;
    const at = input.observedAt.toISOString();
    // Money arrived: a provider order always wins over a local close/unknown.
    const updated = await tx.execute(sql`UPDATE ${financialOperation}
      SET state = 'SUCCEEDED', provider_operation_reference = ${input.providerOrderId}, last_error_code = NULL,
        updated_at = GREATEST(updated_at, ${at}::timestamptz),
        lease_expires_at = GREATEST(lease_expires_at, updated_at, ${at}::timestamptz)
      WHERE id = ${input.binding.attemptId} AND site_id = ${input.binding.siteId} RETURNING id`);
    if (updated.rows.length !== 1) unavailable();
  }

  async function ensurePayment(
    tx: Transaction,
    input: GiftOrderPostingInput,
    charge: { chargeId: string; paidCents: number; coupleSplitCents: number },
  ) {
    const { binding } = input;
    const existing = await findPayment(tx, binding, charge.chargeId);
    if (existing) return { paymentId: existing, ledgerEntryId: null };
    const nominal = binding.nominalCents;
    const commission = binding.commissionCents;
    const gross = charge.paidCents;
    const processing = gross - commission - nominal;
    const anticipation = binding.coupleSplitCents - nominal;
    if (
      gross !== binding.totalCents ||
      processing < 0 ||
      anticipation < 0 ||
      charge.coupleSplitCents < 1 ||
      charge.coupleSplitCents > gross
    )
      return unavailable();
    const paymentId = options.generateId("payment");
    const at = input.observedAt.toISOString();
    await tx.execute(sql`INSERT INTO ${giftPaymentRecord} (id, site_id, account_id, environment, order_id, attempt_id,
      provider_payment_reference, provider_status, verification_status, observed_at, currency, gross_cents,
      processing_cents, commission_cents, recipient_net_cents, split_provider_reference, split_fixed_cents,
      anticipation_cents, platform_net_cents, created_at)
      VALUES (${paymentId}, ${binding.siteId}, ${binding.accountId}, ${binding.environment}, ${binding.orderId},
        ${binding.attemptId}, ${charge.chargeId}, 'RECEIVED', 'VERIFIED', ${at}::timestamptz, 'BRL', ${gross},
        ${processing}, ${commission}, ${nominal}, ${binding.coupleRecipientId}, ${charge.coupleSplitCents},
        ${anticipation}, ${gross - binding.coupleSplitCents}, ${at}::timestamptz)`);
    const ledgerEntryId = options.generateId("ledger");
    const ledger =
      await tx.execute(sql`INSERT INTO ${financialLedgerEntry} (id, site_id, account_id, environment, effect_key, kind,
      direction, currency, amount_cents, payment_id, operation_id, event_id, created_at)
      VALUES (${ledgerEntryId}, ${binding.siteId}, ${binding.accountId}, ${binding.environment},
        ${giftReceivedEffectKey(charge.chargeId)}, 'GIFT_RECEIVED', 'CREDIT', 'BRL', ${nominal}, ${paymentId},
        ${binding.attemptId}, ${input.eventId}, ${at}::timestamptz)
      ON CONFLICT (site_id, account_id, environment, effect_key) DO NOTHING RETURNING id`);
    if (ledger.rows.length !== 1) return unavailable();
    return { paymentId, ledgerEntryId };
  }

  return {
    async applyOrderTransition(input) {
      try {
        return await db.transaction(
          async (tx): Promise<GiftOrderPostingResult> => {
            const { binding, transition } = input;
            const operation = await lockOperation(tx, input);
            switch (transition.kind) {
              case "PENDING":
                return {
                  outcome: "UNCHANGED",
                  paymentId: null,
                  ledgerEntryId: null,
                };
              case "MISMATCH": {
                await insertFinancialOperatorAlert(
                  tx,
                  {
                    kind: "ORDER_MISMATCH",
                    severity: "critical",
                    environment: binding.environment,
                    siteId: binding.siteId,
                    accountId: binding.accountId,
                    checkoutAttemptId: binding.attemptId,
                    paymentReference: input.providerOrderId,
                    details: { reason: transition.reason },
                  },
                  options.generateId("alert"),
                );
                return {
                  outcome: "MISMATCH",
                  paymentId: null,
                  ledgerEntryId: null,
                };
              }
              case "CLOSED": {
                if (await anyPayment(tx, binding)) {
                  // A paid order never closes: a cancel the lifecycle could
                  // not read as a refund goes to an operator, never silence.
                  const alerted = await insertFinancialOperatorAlert(
                    tx,
                    {
                      kind: "ORDER_MISMATCH",
                      severity: "critical",
                      environment: binding.environment,
                      siteId: binding.siteId,
                      accountId: binding.accountId,
                      checkoutAttemptId: binding.attemptId,
                      paymentReference: input.providerOrderId,
                      details: {
                        reason: `CLOSED_AFTER_PAYMENT_${transition.reason}`,
                      },
                    },
                    options.generateId("alert"),
                  );
                  return {
                    outcome: alerted ? "MISMATCH" : "UNCHANGED",
                    paymentId: null,
                    ledgerEntryId: null,
                  };
                }
                if (
                  !["SUCCEEDED", "PROCESSING", "UNKNOWN"].includes(
                    operation.state,
                  )
                )
                  return {
                    outcome: "UNCHANGED",
                    paymentId: null,
                    ledgerEntryId: null,
                  };
                const target = closedStates[transition.reason];
                const at = input.observedAt.toISOString();
                const updated =
                  await tx.execute(sql`UPDATE ${financialOperation}
                  SET state = ${target.state}, last_error_code = ${target.code},
                    provider_operation_reference = ${input.providerOrderId},
                    updated_at = GREATEST(updated_at, ${at}::timestamptz)
                  WHERE id = ${binding.attemptId} AND site_id = ${binding.siteId} RETURNING id`);
                if (updated.rows.length !== 1) return unavailable();
                return {
                  outcome: "CLOSED",
                  paymentId: null,
                  ledgerEntryId: null,
                };
              }
              case "PAID": {
                await bindOperation(tx, input, operation.state);
                const posted = await ensurePayment(tx, input, transition);
                return {
                  outcome: posted.ledgerEntryId ? "POSTED" : "UNCHANGED",
                  ...posted,
                };
              }
              case "REVERSED": {
                await bindOperation(tx, input, operation.state);
                const posted = await ensurePayment(tx, input, transition);
                const reversed = await postGiftPaymentReversal(tx, {
                  siteId: binding.siteId,
                  accountId: binding.accountId,
                  environment: binding.environment,
                  attemptId: binding.attemptId,
                  paymentId: posted.paymentId,
                  providerOrderId: input.providerOrderId,
                  chargeId: transition.chargeId,
                  reversal: transition.reversal,
                  eventId: input.eventId,
                  observedAt: input.observedAt,
                  generateId: () => options.generateId("ledger"),
                });
                return {
                  outcome: reversed.changed ? "REVERSED" : "UNCHANGED",
                  paymentId: posted.paymentId,
                  ledgerEntryId: reversed.ledgerEntryId,
                };
              }
            }
          },
          { isolationLevel: "read committed" },
        );
      } catch {
        return unavailable();
      }
    },
  };
}
