import type {
  OwnerFinanceAlert,
  OwnerFinanceAlertListQuery,
  OwnerFinanceAlertListResponse,
  OwnerFinanceGift,
  OwnerFinanceGiftListQuery,
  OwnerFinanceGiftListResponse,
  OwnerFinanceSiteListResponse,
  OwnerFinanceSummary,
  OwnerFinanceSummaryQuery,
} from "@entrelacos/contracts";
import {
  financialOperatorAlert,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  site,
} from "@entrelacos/database/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { giftPurchaseHasPayment } from "./giftPaymentHistoryRepository";

export type OwnerFinanceDatabase = Pick<
  NodePgDatabase<Record<string, never>>,
  "execute" | "update"
>;

type Row = Record<string, unknown>;

const DIVERGENCE_BUSINESS_DAYS = 2;
const SITE_LIST_LIMIT = 1000;

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

/** Keyset cursor: `<epoch microseconds>_<id>` of the last row served. */
export function encodeOwnerFinanceCursor(micros: string, id: string): string {
  return `${micros}_${id}`;
}

export function decodeOwnerFinanceCursor(
  cursor: string,
): { micros: string; id: string } | null {
  const match = /^(\d{1,20})_(.+)$/.exec(cursor);
  return match ? { micros: match[1], id: match[2] } : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : number(value);
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function anyOf(column: SQL, values: string[] | undefined): SQL | undefined {
  return values?.length
    ? sql`${column} = ANY(${sql.param(values)}::text[])`
    : undefined;
}

function where(conditions: (SQL | undefined)[]): SQL {
  const present = conditions.filter((value): value is SQL => !!value);
  return present.length
    ? sql`WHERE ${sql.join(present, sql` AND `)}`
    : sql.empty();
}

const restrictedStatus =
  "^(REFUND|CHARGEBACK)|^(DELETED|DISPUTED|AWAITING_CHARGEBACK_REVERSAL)$";

// One row per paid V2 gift order, with its couple credit, commissions and status.
function paidGifts(filters: OwnerFinanceSummaryQuery): SQL {
  const inner = sql`SELECT o.id AS order_id, o.site_id, o.environment, s.display_name AS site_name,
      q.snapshot->'quote'->>'title' AS gift_title, q.method::text AS method,
      COALESCE((q.snapshot->'quote'->>'installmentCount')::int, 1) AS installment_count,
      q.total_cents, q.nominal_cents, q.commission_cents,
      COALESCE(pay.paid_at, o.created_at) AS paid_at,
      pay.credited_cents, pay.credited_installments, pay.platform_net_cents,
      CASE
        WHEN pay.review THEN 'IN_REVIEW'
        WHEN pay.credited_installments >= COALESCE((q.snapshot->'quote'->>'installmentCount')::int, 1) THEN 'RECEIVED'
        WHEN pay.credited_installments > 0 THEN 'PARTIALLY_RECEIVED'
        ELSE 'AWAITING_RELEASE'
      END AS status
    FROM ${giftOrder} o
    INNER JOIN ${giftQuoteRecord} q ON q.id = o.quote_id AND q.site_id = o.site_id
      AND q.account_id = o.account_id AND q.environment = o.environment
    INNER JOIN ${site} s ON s.id = o.site_id
    INNER JOIN LATERAL (
      SELECT
        MIN(p.observed_at) FILTER (WHERE p.verification_status = 'VERIFIED'
          AND p.provider_status IN ('CONFIRMED', 'RECEIVED')) AS paid_at,
        COALESCE(SUM(p.recipient_net_cents), 0) AS credited_cents,
        COUNT(p.recipient_net_cents) AS credited_installments,
        SUM(p.platform_net_cents) AS platform_net_cents,
        COALESCE(bool_or(p.split_divergence_blocked_at IS NOT NULL
          OR COALESCE(p.provider_status, '') ~ ${restrictedStatus}
          OR EXISTS (SELECT 1 FROM ${financialOperatorAlert} a
            WHERE a.resolved_at IS NULL AND a.environment = p.environment
              AND a.payment_reference = p.provider_payment_reference)), false) AS review
      FROM ${giftPaymentRecord} p
      WHERE p.order_id = o.id AND p.site_id = o.site_id
        AND p.account_id = o.account_id AND p.environment = o.environment
    ) pay ON true
    ${where([
      sql`q.snapshot->'quote'->>'settlementVersion' = 'PLATFORM_ACCOUNT_SPLIT_V2'`,
      giftPurchaseHasPayment,
      anyOf(sql`o.site_id`, filters.siteId),
      filters.method ? sql`q.method::text = ${filters.method}` : undefined,
      filters.environment
        ? sql`o.environment::text = ${filters.environment}`
        : undefined,
    ])}`;
  const outer = where([
    filters.from ? sql`g.paid_at >= ${filters.from}::timestamptz` : undefined,
    filters.to ? sql`g.paid_at <= ${filters.to}::timestamptz` : undefined,
    filters.status ? sql`g.status = ${filters.status}` : undefined,
  ]);
  return sql`SELECT g.*, floor(extract(epoch FROM g.paid_at) * 1000000)::bigint::text AS paid_micros
    FROM (${inner}) g ${outer}`;
}

export async function readOwnerFinanceSummary(
  db: OwnerFinanceDatabase,
  filters: OwnerFinanceSummaryQuery,
): Promise<OwnerFinanceSummary> {
  const result = await db.execute(sql`SELECT
      COUNT(*) AS gift_count,
      COALESCE(SUM(f.total_cents), 0) AS gross,
      COALESCE(SUM(f.credited_cents), 0) AS credited,
      COALESCE(SUM(f.commission_cents), 0) AS estimated,
      COALESCE(SUM(f.platform_net_cents), 0) AS net,
      COALESCE(SUM(f.commission_cents - COALESCE(f.platform_net_cents, 0))
        FILTER (WHERE f.status = 'RECEIVED'), 0) AS difference
    FROM (${paidGifts(filters)}) f`);
  const totals = (result.rows[0] ?? {}) as Row;
  return {
    giftCount: number(totals.gift_count),
    grossChargedCents: number(totals.gross),
    coupleCreditedCents: number(totals.credited),
    estimatedCommissionCents: number(totals.estimated),
    netCommissionCents: number(totals.net),
    commissionDifferenceCents: number(totals.difference),
  };
}

export async function listOwnerFinanceGifts(
  db: OwnerFinanceDatabase,
  query: OwnerFinanceGiftListQuery,
): Promise<OwnerFinanceGiftListResponse> {
  const position = query.cursor ? decodeOwnerFinanceCursor(query.cursor) : null;
  const after = position
    ? sql`WHERE (f.paid_micros::bigint, f.order_id) < (${position.micros}::bigint, ${position.id})`
    : sql.empty();
  const result =
    await db.execute(sql`SELECT * FROM (${paidGifts(query)}) f ${after}
    ORDER BY f.paid_micros::bigint DESC, f.order_id DESC LIMIT ${query.limit + 1}`);
  const rows = result.rows as Row[];
  const page = rows.slice(0, query.limit);
  const gifts: OwnerFinanceGift[] = page.map((row) => ({
    orderId: String(row.order_id),
    siteId: String(row.site_id),
    siteName: String(row.site_name),
    environment: row.environment as OwnerFinanceGift["environment"],
    paidAt: iso(row.paid_at),
    giftTitle: typeof row.gift_title === "string" ? row.gift_title : "",
    method: row.method as OwnerFinanceGift["method"],
    installmentCount: number(row.installment_count) || 1,
    grossCents: number(row.total_cents),
    coupleCreditedCents: number(row.credited_cents),
    coupleExpectedCents: number(row.nominal_cents),
    creditedInstallments: number(row.credited_installments),
    estimatedCommissionCents: number(row.commission_cents),
    netCommissionCents: nullableNumber(row.platform_net_cents),
    status: row.status as OwnerFinanceGift["status"],
  }));
  const last = page.at(-1);
  return {
    gifts,
    nextCursor:
      rows.length > query.limit && last
        ? encodeOwnerFinanceCursor(
            String(last.paid_micros),
            String(last.order_id),
          )
        : null,
  };
}

export async function listOwnerFinanceSites(
  db: OwnerFinanceDatabase,
): Promise<OwnerFinanceSiteListResponse> {
  const result = await db.execute(
    sql`SELECT s.id, s.display_name AS name FROM ${site} s ORDER BY s.display_name, s.id LIMIT ${SITE_LIST_LIMIT}`,
  );
  return {
    sites: (result.rows as Row[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
    })),
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

function detailAmount(details: unknown): number | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Row).amountCents;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export async function listOwnerFinanceAlerts(
  db: OwnerFinanceDatabase,
  query: OwnerFinanceAlertListQuery,
): Promise<OwnerFinanceAlertListResponse> {
  const position = query.cursor ? decodeOwnerFinanceCursor(query.cursor) : null;
  const conditions = where([
    query.status === "open"
      ? sql`a.resolved_at IS NULL`
      : query.status === "resolved"
        ? sql`a.resolved_at IS NOT NULL`
        : undefined,
    anyOf(sql`a.site_id`, query.siteId),
    position
      ? sql`(floor(extract(epoch FROM a.created_at) * 1000000)::bigint, a.id) < (${position.micros}::bigint, ${position.id})`
      : undefined,
  ]);
  const [result, counts] = await Promise.all([
    db.execute(sql`SELECT a.*, s.display_name AS site_name,
        floor(extract(epoch FROM a.created_at) * 1000000)::bigint::text AS created_micros,
        (SELECT p.gross_cents FROM ${giftPaymentRecord} p
          WHERE p.provider_payment_reference = a.payment_reference AND p.environment = a.environment
          ORDER BY p.id LIMIT 1) AS gross_cents
      FROM ${financialOperatorAlert} a
      LEFT JOIN ${site} s ON s.id = a.site_id
      ${conditions}
      ORDER BY floor(extract(epoch FROM a.created_at) * 1000000)::bigint DESC, a.id DESC
      LIMIT ${query.limit + 1}`),
    db.execute(sql`SELECT COUNT(*) AS open,
        COUNT(*) FILTER (WHERE a.severity = 'critical') AS critical
      FROM ${financialOperatorAlert} a WHERE a.resolved_at IS NULL`),
  ]);
  const rows = result.rows as Row[];
  const page = rows.slice(0, query.limit);
  const alerts: OwnerFinanceAlert[] = page.map((row) => {
    const environment = row.environment as OwnerFinanceAlert["environment"];
    const createdAt = new Date(row.created_at as string | Date);
    const reference =
      typeof row.payment_reference === "string" ? row.payment_reference : null;
    return {
      id: String(row.id),
      kind: row.kind as OwnerFinanceAlert["kind"],
      severity: row.severity as OwnerFinanceAlert["severity"],
      environment,
      siteId: typeof row.site_id === "string" ? row.site_id : null,
      siteName: typeof row.site_name === "string" ? row.site_name : null,
      paymentReference: reference,
      amountCents: nullableNumber(row.gross_cents) ?? detailAmount(row.details),
      createdAt: createdAt.toISOString(),
      dueAt:
        row.kind === "SPLIT_DIVERGENCE_BLOCK"
          ? addBusinessDays(createdAt, DIVERGENCE_BUSINESS_DAYS).toISOString()
          : null,
      asaasPaymentUrl: paymentUrl(environment, reference),
      resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
      resolvedNote:
        typeof row.resolved_note === "string" ? row.resolved_note : null,
    };
  });
  const last = page.at(-1);
  const totals = (counts.rows[0] ?? {}) as Row;
  return {
    alerts,
    nextCursor:
      rows.length > query.limit && last
        ? encodeOwnerFinanceCursor(String(last.created_micros), String(last.id))
        : null,
    openCount: number(totals.open),
    criticalOpenCount: number(totals.critical),
  };
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
