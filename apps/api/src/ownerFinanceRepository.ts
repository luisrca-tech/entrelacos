import type {
  OwnerFinanceAlert,
  OwnerFinanceSummary,
} from "@entrelacos/contracts";
import {
  financialOperatorAlert,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  site,
} from "@entrelacos/database/schema";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type OwnerFinanceDatabase = NodePgDatabase<Record<string, never>>;

const DIVERGENCE_BUSINESS_DAYS = 2;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Adds business days (Monday to Friday, UTC) to a timestamp.
export function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function readOwnerFinanceSummary(
  db: OwnerFinanceDatabase,
  input: { from?: Date; to?: Date; now: Date },
): Promise<OwnerFinanceSummary> {
  const to = input.to ?? input.now;
  const from = input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const window = and(
    sql`${giftPaymentRecord.observedAt} >= ${fromIso}::timestamptz`,
    sql`${giftPaymentRecord.observedAt} <= ${toIso}::timestamptz`,
  );
  const [totals] = (
    await db.execute(sql`
      SELECT
        COALESCE(SUM(p.gross_cents), 0) AS gross,
        COALESCE(SUM(p.recipient_net_cents), 0) AS splits,
        COALESCE(SUM(p.platform_net_cents), 0) AS platform_net,
        COALESCE(SUM(p.anticipation_cents), 0) AS anticipation,
        COALESCE(SUM(
          CASE WHEN q.total_cents > 0
            THEN ROUND(q.commission_cents::numeric * p.gross_cents / q.total_cents)
            ELSE 0 END
        ), 0) AS estimated_commission
      FROM ${giftPaymentRecord} p
      LEFT JOIN ${giftOrder} o ON o.id = p.order_id AND o.site_id = p.site_id
        AND o.account_id = p.account_id AND o.environment = p.environment
      LEFT JOIN ${giftQuoteRecord} q ON q.id = o.quote_id AND q.site_id = o.site_id
        AND q.account_id = o.account_id AND q.environment = o.environment
      WHERE p.observed_at >= ${fromIso}::timestamptz
        AND p.observed_at <= ${toIso}::timestamptz
        AND p.provider_status IN ('CONFIRMED', 'RECEIVED')
        AND p.platform_net_cents IS NOT NULL`)
  ).rows as Record<string, unknown>[];
  const statusRows = (
    await db
      .select({
        status: giftPaymentRecord.providerStatus,
        count: sql<number>`count(*)`,
      })
      .from(giftPaymentRecord)
      .where(window)
      .groupBy(giftPaymentRecord.providerStatus)
  ).map((row) => [row.status ?? "UNKNOWN", number(row.count)] as const);
  const [alerts] = await db
    .select({
      open: sql<number>`count(*)`,
      critical: sql<number>`count(*) FILTER (WHERE ${financialOperatorAlert.severity} = 'critical')`,
    })
    .from(financialOperatorAlert)
    .where(isNull(financialOperatorAlert.resolvedAt));
  const platformNetCents = number(totals?.platform_net);
  const estimatedCommissionCents = number(totals?.estimated_commission);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    grossChargedCents: number(totals?.gross),
    recipientSplitCents: number(totals?.splits),
    platformNetCents,
    anticipationCents: number(totals?.anticipation),
    estimatedCommissionCents,
    commissionDifferenceCents: estimatedCommissionCents - platformNetCents,
    paymentCountsByStatus: Object.fromEntries(statusRows),
    openAlertCount: number(alerts?.open),
    criticalAlertCount: number(alerts?.critical),
  };
}

function paymentUrl(
  environment: "sandbox" | "live",
  reference: string | null,
): string | null {
  if (!reference) return null;
  const id = reference.replace(/^pay_/, "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
  const host =
    environment === "sandbox" ? "sandbox.asaas.com" : "www.asaas.com";
  return `https://${host}/payment/show/${id}`;
}

export async function listOwnerFinanceAlerts(
  db: OwnerFinanceDatabase,
  status: "open" | "resolved" | "all",
): Promise<OwnerFinanceAlert[]> {
  const rows = await db
    .select({
      alert: financialOperatorAlert,
      siteName: site.displayName,
      grossCents: giftPaymentRecord.grossCents,
    })
    .from(financialOperatorAlert)
    .leftJoin(site, eq(site.id, financialOperatorAlert.siteId))
    .leftJoin(
      giftPaymentRecord,
      and(
        eq(
          giftPaymentRecord.providerPaymentReference,
          financialOperatorAlert.paymentReference,
        ),
        eq(giftPaymentRecord.environment, financialOperatorAlert.environment),
      ),
    )
    .where(
      status === "open"
        ? isNull(financialOperatorAlert.resolvedAt)
        : status === "resolved"
          ? isNotNull(financialOperatorAlert.resolvedAt)
          : undefined,
    )
    .orderBy(desc(financialOperatorAlert.createdAt))
    .limit(200);
  return rows.map(({ alert, siteName, grossCents }) => {
    const detailAmount = alert.details.amountCents;
    return {
      id: alert.id,
      kind: alert.kind as OwnerFinanceAlert["kind"],
      severity: alert.severity as OwnerFinanceAlert["severity"],
      environment: alert.environment,
      siteId: alert.siteId,
      siteName: siteName ?? null,
      paymentReference: alert.paymentReference,
      amountCents:
        grossCents ??
        (typeof detailAmount === "number" && Number.isInteger(detailAmount)
          ? detailAmount
          : null),
      createdAt: alert.createdAt.toISOString(),
      dueAt:
        alert.kind === "SPLIT_DIVERGENCE_BLOCK"
          ? addBusinessDays(
              alert.createdAt,
              DIVERGENCE_BUSINESS_DAYS,
            ).toISOString()
          : null,
      asaasPaymentUrl: paymentUrl(alert.environment, alert.paymentReference),
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
      resolvedNote: alert.resolvedNote,
    };
  });
}

// Returns false when the alert does not exist or is already resolved.
export async function resolveOwnerFinanceAlert(
  db: OwnerFinanceDatabase,
  input: { id: string; note: string; now: Date },
): Promise<boolean> {
  const updated = await db
    .update(financialOperatorAlert)
    .set({ resolvedAt: input.now, resolvedNote: input.note })
    .where(
      and(
        eq(financialOperatorAlert.id, input.id),
        isNull(financialOperatorAlert.resolvedAt),
        sql`${financialOperatorAlert.createdAt} <= ${input.now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: financialOperatorAlert.id });
  return updated.length > 0;
}
