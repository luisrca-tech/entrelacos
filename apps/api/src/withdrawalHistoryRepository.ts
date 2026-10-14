import {
  giftQuoteSchema,
  type WithdrawalIntent,
  withdrawalIntentSchema,
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

export interface WithdrawalHistoryOptions {
  mode: "disabled" | "sandbox" | "live";
}
export interface WithdrawalHistoryRepository {
  listWithdrawals(siteId: string): Promise<WithdrawalIntent[]>;
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
function unavailable(): never {
  throw new WithdrawalHistoryRepositoryError();
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return unavailable();
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
  if (!["disabled", "sandbox", "live"].includes(mode)) return unavailable();
  return {
    async listWithdrawals(siteId: string): Promise<WithdrawalIntent[]> {
      if (mode === "disabled") throw new WithdrawalHistoryRepositoryError(409);
      try {
        if (!giftQuoteSchema.shape.siteId.safeParse(siteId).success)
          return unavailable();
        const selected =
          await db.execute(sql`SELECT w.id AS "id", st.id AS "siteId", w.amount_cents AS "amountCents", w.fee_cents AS "feeCents",
          w.net_cents AS "netCents", w.currency AS "currency", w.destination_version AS "destinationVersion", w.state AS "state",
          w.created_at AS "createdAt", w.updated_at AS "updatedAt", w.environment AS "mode", a.id IS NOT NULL AS "accountMatches"
          FROM ${site} st LEFT JOIN ${withdrawalIntent} w ON w.site_id=st.id AND w.environment=${mode}
          LEFT JOIN ${receivingAccount} a ON a.id=w.account_id AND a.site_id=w.site_id AND a.environment=w.environment AND a.provider='ASAAS'
          WHERE st.id=${siteId} AND (${mode}<>'live' OR st.is_demo=false)
          ORDER BY date_trunc('milliseconds', w.created_at) DESC, w.id COLLATE "C" ASC LIMIT 1001`);
        if (selected.rows.length === 0 || selected.rows.length > 1000)
          return unavailable();
        const withdrawals: WithdrawalIntent[] = [];
        const seen = new Set<string>();
        for (const value of selected.rows) {
          const row = value as Record<string, unknown>;
          if (row.siteId !== siteId) return unavailable();
          if (row.id === null) {
            if (
              selected.rows.length !== 1 ||
              row.accountMatches !== false ||
              !withdrawalFields.every((field) => row[field] === null)
            )
              return unavailable();
            return [];
          }
          if (row.accountMatches !== true || row.mode !== mode)
            return unavailable();
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
            return unavailable();
          const previous = withdrawals.at(-1);
          if (
            previous &&
            (Date.parse(previous.createdAt) <
              Date.parse(parsed.data.createdAt) ||
              (previous.createdAt === parsed.data.createdAt &&
                previous.id >= parsed.data.id))
          )
            return unavailable();
          seen.add(parsed.data.id);
          withdrawals.push(parsed.data);
        }
        return withdrawals;
      } catch {
        return unavailable();
      }
    },
  };
}
