import { user } from "@entrelacos/database/schema";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type CredentialLockDatabase = NodePgDatabase<Record<string, never>>;

export type CredentialLockTransaction = Parameters<
  Parameters<CredentialLockDatabase["transaction"]>[0]
>[0];

export function normalizeCredentialEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function lockCredential(
  tx: CredentialLockTransaction,
  email: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalizeCredentialEmail(email)}, 0))`,
  );
}

export async function withCredentialAdvisoryLock<T>(
  db: CredentialLockDatabase,
  email: string,
  callback: (tx: CredentialLockTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockCredential(tx, email);
    return callback(tx);
  });
}

export async function withUserCredentialAdvisoryLock<T>(
  db: CredentialLockDatabase,
  userId: string,
  callback: (tx: CredentialLockTransaction) => Promise<T>,
): Promise<T> {
  const [record] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return record
    ? withCredentialAdvisoryLock(db, record.email, callback)
    : db.transaction(async (tx) => callback(tx));
}
