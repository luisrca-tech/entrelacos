/**
 * Read-only inventory of PLATFORM_FEE_GUARANTEE_V1 gift checkout attempts that
 * are still open while PLATFORM_ACCOUNT_SPLIT_V2 takes over new charges. V1
 * charges live in couple sub-accounts, so their sub-account webhooks and the
 * platform-adjustment worker must keep running until this list is empty.
 *
 * An attempt is open when any of these hold:
 * - INSTALLMENTS: a 2–12 installment plan with payments, but fewer verified
 *   received installments than the plan count;
 * - ADJUSTMENT: a payment with platform_adjustment_cents > 0 and no
 *   platform_adjustment_funded_at;
 * - HOSTED_CHECKOUT: a hosted checkout without a paid payment and without a
 *   processed CHECKOUT_PAID/CANCELED/EXPIRED event, not yet past expires_at.
 *
 * Runs in a READ ONLY transaction that is always rolled back. Prints only ids,
 * counts, states and amounts in cents; no buyer, couple or provider payloads.
 *
 * Usage (from apps/api; Node's env loader, see registerPlatformAsaasWebhook.ts):
 *   node_modules/.bin/tsx --env-file-if-exists=../../packages/database/.env \
 *     --env-file-if-exists=.env scripts/listV1OpenSettlements.ts [--environment sandbox|live]
 * APP_ENV selects the database target (development | production).
 */
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";

export interface V1OpenSettlementRow {
  attemptId: string;
  orderId: string;
  siteId: string;
  accountId: string;
  environment: string;
  method: string;
  installmentCount: number;
  payments: number;
  receivedPayments: number;
  pendingAdjustments: number;
  pendingAdjustmentCents: number;
  checkoutExpiresAt: string | null;
  reasons: string[];
}

export const v1OpenSettlementsQuery = `
WITH v1 AS (
  SELECT a.id AS attempt_id, a.order_id, a.site_id, a.account_id, a.environment,
    a.provider_reference, a.expires_at, q.method::text AS method,
    CASE WHEN jsonb_typeof(q.snapshot->'quote'->'installmentCount') = 'number'
      THEN (q.snapshot->'quote'->>'installmentCount')::int ELSE 1 END AS installment_count
  FROM public.gift_checkout_attempt a
  INNER JOIN public.gift_order o ON o.id = a.order_id AND o.site_id = a.site_id
    AND o.account_id = a.account_id AND o.environment = a.environment
  INNER JOIN public.gift_quote_record q ON q.id = o.quote_id AND q.site_id = o.site_id
    AND q.account_id = o.account_id AND q.environment = o.environment
  WHERE q.snapshot->'quote'->>'settlementVersion' = 'PLATFORM_FEE_GUARANTEE_V1'
    AND ($1::text IS NULL OR a.environment::text = $1::text)
), pay AS (
  SELECT p.attempt_id, p.site_id, p.account_id, p.environment,
    count(*)::int AS payments,
    count(*) FILTER (WHERE p.verification_status = 'VERIFIED'
      AND p.provider_status IN ('RECEIVED', 'RECEIVED_IN_CASH'))::int AS received_payments,
    count(*) FILTER (WHERE p.provider_status IN ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'))::int AS paid_payments,
    count(*) FILTER (WHERE p.platform_adjustment_cents > 0
      AND p.platform_adjustment_funded_at IS NULL)::int AS pending_adjustments,
    COALESCE(sum(p.platform_adjustment_cents) FILTER (WHERE p.platform_adjustment_cents > 0
      AND p.platform_adjustment_funded_at IS NULL), 0)::bigint AS pending_adjustment_cents
  FROM public.gift_payment_record p
  GROUP BY p.attempt_id, p.site_id, p.account_id, p.environment
), classified AS (
  SELECT v1.*, COALESCE(pay.payments, 0) AS payments,
    COALESCE(pay.received_payments, 0) AS received_payments,
    COALESCE(pay.paid_payments, 0) AS paid_payments,
    COALESCE(pay.pending_adjustments, 0) AS pending_adjustments,
    COALESCE(pay.pending_adjustment_cents, 0) AS pending_adjustment_cents,
    EXISTS (
      SELECT 1 FROM public.financial_event_inbox e
      WHERE e.site_id = v1.site_id AND e.account_id = v1.account_id
        AND e.environment = v1.environment AND e.state = 'PROCESSED'
        AND e.event_type IN ('CHECKOUT_PAID', 'CHECKOUT_CANCELED', 'CHECKOUT_EXPIRED')
        AND e.payload->>'checkoutId' = v1.provider_reference
    ) AS checkout_closed
  FROM v1
  LEFT JOIN pay ON pay.attempt_id = v1.attempt_id AND pay.site_id = v1.site_id
    AND pay.account_id = v1.account_id AND pay.environment = v1.environment
)
SELECT attempt_id AS "attemptId", order_id AS "orderId", site_id AS "siteId",
  account_id AS "accountId", environment::text AS environment, method,
  installment_count AS "installmentCount", payments, received_payments AS "receivedPayments",
  pending_adjustments AS "pendingAdjustments", pending_adjustment_cents::text AS "pendingAdjustmentCents",
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "checkoutExpiresAt",
  array_remove(ARRAY[
    CASE WHEN installment_count > 1 AND payments > 0 AND received_payments < installment_count
      THEN 'INSTALLMENTS' END,
    CASE WHEN pending_adjustments > 0 THEN 'ADJUSTMENT' END,
    CASE WHEN provider_reference IS NOT NULL AND paid_payments = 0 AND NOT checkout_closed
      AND (expires_at IS NULL OR expires_at > clock_timestamp()) THEN 'HOSTED_CHECKOUT' END
  ], NULL) AS reasons
FROM classified
WHERE (installment_count > 1 AND payments > 0 AND received_payments < installment_count)
  OR pending_adjustments > 0
  OR (provider_reference IS NOT NULL AND paid_payments = 0 AND NOT checkout_closed
    AND (expires_at IS NULL OR expires_at > clock_timestamp()))
ORDER BY environment, site_id, attempt_id`;

export function summarize(rows: V1OpenSettlementRow[]) {
  const byReason: Record<string, number> = {
    INSTALLMENTS: 0,
    ADJUSTMENT: 0,
    HOSTED_CHECKOUT: 0,
  };
  for (const row of rows)
    for (const reason of row.reasons)
      byReason[reason] = (byReason[reason] ?? 0) + 1;
  return {
    openAttempts: rows.length,
    byReason,
    pendingAdjustmentCents: rows.reduce(
      (total, row) => total + row.pendingAdjustmentCents,
      0,
    ),
  };
}

export async function listV1OpenSettlements(
  env: NodeJS.ProcessEnv,
  environment: "sandbox" | "live" | null,
) {
  const target = env.APP_ENV;
  if (target !== "development" && target !== "production")
    throw new Error("V1 inventory requires APP_ENV development or production");
  const connection = createDatabaseConnection({
    target,
    env,
    poolConfig: {
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000,
    },
  });
  try {
    await verifyDatabaseConnection(connection);
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const result = await client.query(v1OpenSettlementsQuery, [environment]);
      return result.rows.map(
        (row): V1OpenSettlementRow => ({
          ...row,
          pendingAdjustmentCents: Number(row.pendingAdjustmentCents),
        }),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--environment");
  const environment = index === -1 ? null : process.argv[index + 1];
  if (
    environment !== null &&
    environment !== "sandbox" &&
    environment !== "live"
  ) {
    console.error("--environment must be sandbox or live");
    process.exitCode = 1;
  } else {
    listV1OpenSettlements(process.env, environment).then(
      (rows) => {
        console.log(JSON.stringify({ summary: summarize(rows) }, null, 2));
        if (rows.length)
          console.table(
            rows.map((row) => ({ ...row, reasons: row.reasons.join(",") })),
          );
      },
      () => {
        console.error("V1 open settlement inventory unavailable");
        process.exitCode = 1;
      },
    );
  }
}
