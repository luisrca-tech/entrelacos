import type { DatabaseConnection } from "@entrelacos/database";
import { type SQL, sql } from "drizzle-orm";

export const financialInboxDueAt = sql`CASE WHEN e.state='CLAIMED' THEN e.lease_expires_at ELSE e.next_attempt_at END`;

export async function readFinancialWorkDueAt(
  db: Pick<DatabaseConnection["db"], "execute">,
  deadline: SQL,
  eligible: SQL,
): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT ceil(extract(epoch FROM min(${deadline})) * 1000)::float8 AS "dueAt"
    ${eligible}
  `);
  const dueAt = result.rows[0]?.dueAt;
  if (dueAt === null || dueAt === Infinity) return null;
  if (typeof dueAt !== "number" || !Number.isFinite(dueAt)) {
    throw new Error("Financial work deadline unavailable");
  }
  return dueAt;
}
