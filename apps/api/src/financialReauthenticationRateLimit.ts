import { createHash } from "node:crypto";
import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { verification } from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { FinancialReauthenticationError } from "./financialReauthentication";

const namespace = "financial-password-reauthentication-v1";
function unavailable(): never {
  throw new FinancialReauthenticationError(503, "REAUTHENTICATION_UNAVAILABLE");
}
function timestamp(value: unknown): number {
  const stored = readDatabaseTimestamp(value);
  if (!Number.isSafeInteger(stored.getTime()) || stored.getTime() < 0)
    unavailable();
  return stored.getTime();
}

// The existing verification store holds only namespaced short-lived counters.
// No credential, identity, session or provider record is changed. The advisory
// lock and database clock serialize the per-user window across API instances.
export function createFinancialReauthenticationRateLimit(
  db: Pick<DatabaseConnection["db"], "transaction">,
  policy: { maxAttempts: number; windowMs: number },
) {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1000 ||
    policy.windowMs > 300000
  )
    unavailable();
  const { maxAttempts, windowMs } = policy;
  return {
    async consume(userId: string): Promise<boolean> {
      try {
        if (!giftQuoteSchema.shape.siteId.safeParse(userId).success)
          unavailable();
        const digest = createHash("sha256")
          .update(JSON.stringify([namespace, userId]), "utf8")
          .digest("hex");
        const id = `financial-reauth-${digest}`;
        return await db.transaction(
          async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`,
            );
            const clock = await tx.execute(
              sql`SELECT clock_timestamp() AS "currentTime"`,
            );
            if (clock.rows.length !== 1) unavailable();
            const current = timestamp(clock.rows[0]?.currentTime);
            const stored = await tx.execute(
              sql`SELECT v.id,v.identifier,v.value,v.expires_at AS "expiresAt" FROM ${verification} v WHERE v.id=${id} FOR UPDATE OF v`,
            );
            if (stored.rows.length > 1) unavailable();
            let attempts = 0;
            let windowStartedAt = current;
            if (stored.rows.length === 1) {
              const row = stored.rows[0];
              if (
                row.id !== id ||
                row.identifier !== namespace ||
                typeof row.value !== "string" ||
                row.value.length > 512
              )
                unavailable();
              const parsed = JSON.parse(row.value) as Record<string, unknown>;
              if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed) ||
                Object.keys(parsed).length !== 4 ||
                parsed.version !== 1 ||
                typeof parsed.attempts !== "number" ||
                !Number.isSafeInteger(parsed.attempts) ||
                parsed.attempts < 1 ||
                parsed.attempts > 20 ||
                typeof parsed.windowStartedAt !== "number" ||
                !Number.isSafeInteger(parsed.windowStartedAt) ||
                parsed.windowStartedAt < 0 ||
                parsed.windowStartedAt > current ||
                typeof parsed.windowMs !== "number" ||
                !Number.isSafeInteger(parsed.windowMs) ||
                parsed.windowMs < 1000 ||
                parsed.windowMs > 300000 ||
                databaseTimestampEpochMicroseconds(row.expiresAt) !==
                  BigInt(parsed.windowStartedAt + parsed.windowMs) * 1000n
              )
                unavailable();
              if (current < timestamp(row.expiresAt)) {
                if (parsed.windowMs !== windowMs) unavailable();
                attempts = parsed.attempts;
                windowStartedAt = parsed.windowStartedAt;
              }
            }
            if (attempts >= maxAttempts) return false;
            const expiresAt = new Date(windowStartedAt + windowMs);
            if (!Number.isSafeInteger(expiresAt.getTime())) unavailable();
            const value = JSON.stringify({
              version: 1,
              attempts: attempts + 1,
              windowStartedAt,
              windowMs,
            });
            const saved =
              await tx.execute(sql`INSERT INTO ${verification} (id,identifier,value,expires_at,created_at,updated_at)
            VALUES (${id},${namespace},${value},${expiresAt.toISOString()}::timestamptz,clock_timestamp(),clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=clock_timestamp()
              WHERE ${verification}.identifier=excluded.identifier RETURNING id`);
            if (saved.rows.length !== 1 || saved.rows[0]?.id !== id)
              unavailable();
            return true;
          },
          { isolationLevel: "read committed" },
        );
      } catch {
        return unavailable();
      }
    },
  };
}
