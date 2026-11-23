import {
  giftQuoteSchema,
  type WithdrawalIntent,
  type WithdrawalPage,
  type WithdrawalPageQuery,
  withdrawalIntentSchema,
  withdrawalPageQuerySchema,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  receivingAccount,
  site,
  withdrawalIntent,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  compareDatabaseTimestamps,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { allowedLiveDemoSiteIds, liveDemoSiteIdsSql } from "./liveSitePolicy";
import { carryUnavailable, markUnavailable } from "./observability";

export interface WithdrawalHistoryOptions {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment?: "development" | "test" | "production";
  liveDemoSiteIds?: readonly string[];
}
export interface WithdrawalHistoryRepository {
  listWithdrawals(siteId: string): Promise<WithdrawalIntent[]>;
  listWithdrawalPage(
    siteId: string,
    query: WithdrawalPageQuery,
  ): Promise<WithdrawalPage>;
}
export type WithdrawalHistoryDatabase = Pick<
  DatabaseConnection["db"],
  "execute"
>;
export class WithdrawalHistoryRepositoryError extends Error {
  readonly code: "PROVIDER_MODE_UNAVAILABLE" | "WITHDRAWAL_HISTORY_UNAVAILABLE";
  readonly title: string;
  constructor(readonly status: 409 | 503 = 503) {
    const title =
      status === 409
        ? "Financial provider is unavailable"
        : "Withdrawal history unavailable";
    super(title);
    this.name = "WithdrawalHistoryRepositoryError";
    this.title = title;
    this.code =
      status === 409
        ? "PROVIDER_MODE_UNAVAILABLE"
        : "WITHDRAWAL_HISTORY_UNAVAILABLE";
  }
}
/** Throws the generic unavailability, labeled with a non-personal reason. */
function unavailable(reason: string, count?: number): never {
  throw markUnavailable(new WithdrawalHistoryRepositoryError(), reason, count);
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return unavailable("timestamp_invalid");
  return value.toISOString();
}
const withdrawalFields = [
  "id",
  "amountCents",
  "feeCents",
  "netCents",
  "currency",
  "destinationVersion",
  "state",
  "createdAt",
  "updatedAt",
  "mode",
] as const;

export function createWithdrawalHistoryRepository(
  db: WithdrawalHistoryDatabase,
  options: WithdrawalHistoryOptions,
): WithdrawalHistoryRepository {
  const mode = options.mode;
  if (!["disabled", "sandbox", "live"].includes(mode))
    return unavailable("mode_invalid");
  const liveDemoSiteIds = options.liveDemoSiteIds;
  const approvedDemoSiteIds = allowedLiveDemoSiteIds({
    mode,
    applicationEnvironment: options.applicationEnvironment ?? "test",
    liveDemoSiteIds,
  });
  async function read(
    siteId: string,
    page?: WithdrawalPageQuery,
  ): Promise<WithdrawalIntent[]> {
    if (mode === "disabled") throw new WithdrawalHistoryRepositoryError(409);
    try {
      if (!giftQuoteSchema.shape.siteId.safeParse(siteId).success)
        return unavailable("site_id_invalid");
      const [cursorTime, cursorId] = page?.cursor?.split("~") ?? [];
      const createdAt = page
        ? sql`date_trunc('milliseconds', w.created_at at time zone 'UTC')`
        : sql`date_trunc('milliseconds', w.created_at)`;
      const boundary =
        cursorTime && cursorId
          ? sql`AND (
            ${createdAt} < (${cursorTime}::timestamptz at time zone 'UTC')
            OR (${createdAt} = (${cursorTime}::timestamptz at time zone 'UTC') AND w.id COLLATE "C" > ${cursorId})
          )`
          : sql.empty();
      const limit = page ? sql`${page.limit + 1}` : sql`1001`;
      // Withdrawals of every account of the site, including those made through
      // the previous provider: history stays readable after the switch.
      const selected =
        await db.execute(sql`SELECT w.id AS "id", st.id AS "siteId", w.amount_cents AS "amountCents", w.fee_cents AS "feeCents",
          w.net_cents AS "netCents", w.currency AS "currency", w.destination_version AS "destinationVersion", w.state AS "state",
          w.created_at AS "createdAt", w.updated_at AS "updatedAt", w.environment AS "mode", a.id IS NOT NULL AS "accountMatches"
          FROM ${site} st LEFT JOIN ${withdrawalIntent} w ON w.site_id=st.id AND w.environment=${mode} ${boundary}
          LEFT JOIN ${receivingAccount} a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment
          WHERE st.id=${siteId} AND (${mode}<>'live' OR st.is_demo=false OR st.id = ANY(${liveDemoSiteIdsSql(approvedDemoSiteIds)}))
          ORDER BY ${createdAt} DESC, w.id COLLATE "C" ASC LIMIT ${limit}`);
      if (selected.rows.length === 0 || selected.rows.length > 1000)
        return unavailable(
          `row_count_mismatch:${page ? "withdrawal_page" : "withdrawal_list"}`,
          selected.rows.length,
        );
      const withdrawals: WithdrawalIntent[] = [];
      const seen = new Set<string>();
      for (const value of selected.rows) {
        const row = value as Record<string, unknown>;
        if (row.siteId !== siteId) return unavailable("scope_mismatch:row");
        if (row.id === null) {
          if (
            selected.rows.length !== 1 ||
            row.accountMatches !== false ||
            !withdrawalFields.every((field) => row[field] === null)
          )
            return unavailable("empty_history_row_invalid");
          return [];
        }
        if (row.accountMatches !== true || row.mode !== mode)
          return unavailable("withdrawal_account_or_mode_mismatch");
        const createdAt = readDatabaseTimestamp(row.createdAt);
        const updatedAt = readDatabaseTimestamp(row.updatedAt);
        const parsed = withdrawalIntentSchema.safeParse({
          id: row.id,
          siteId: row.siteId,
          amountCents: row.amountCents,
          feeCents: row.feeCents,
          netCents: row.netCents,
          currency: row.currency,
          destinationVersion: row.destinationVersion,
          state: row.state,
          createdAt: instant(createdAt),
          updatedAt: instant(updatedAt),
          mode: row.mode,
        });
        if (
          !parsed.success ||
          compareDatabaseTimestamps(updatedAt, createdAt) < 0 ||
          seen.has(parsed.data.id)
        )
          return unavailable("withdrawal_row_invalid");
        const previous = withdrawals.at(-1);
        if (
          previous &&
          (Date.parse(previous.createdAt) < Date.parse(parsed.data.createdAt) ||
            (previous.createdAt === parsed.data.createdAt &&
              previous.id >= parsed.data.id))
        )
          return unavailable("withdrawal_order_invalid");
        seen.add(parsed.data.id);
        withdrawals.push(parsed.data);
      }
      return withdrawals;
    } catch (error) {
      throw carryUnavailable(error, new WithdrawalHistoryRepositoryError());
    }
  }

  return {
    listWithdrawals: (siteId) => read(siteId),
    async listWithdrawalPage(siteId, input) {
      const query = withdrawalPageQuerySchema.parse(input);
      const rows = await read(siteId, query);
      const withdrawals = rows.slice(0, query.limit);
      const last = withdrawals.at(-1);
      return {
        withdrawals,
        nextCursor:
          last && rows.length > query.limit
            ? `${last.createdAt}~${last.id}`
            : null,
      };
    },
  };
}
