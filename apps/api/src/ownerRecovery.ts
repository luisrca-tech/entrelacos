import { user } from "@entrelacos/database/schema";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  revokeUserSessionsAndDerivedRecognition,
  setCredential,
} from "./adminAccess";
import { withCredentialAdvisoryLock } from "./credentialLock";

export type OwnerRecoveryDatabase = NodePgDatabase<Record<string, never>>;

export interface OwnerRecoveryInput {
  email: string;
  password: string;
  now?: Date;
}

export interface OwnerRecoveryResult {
  userId: string;
}

export class OwnerRecoveryRejectedError extends Error {
  readonly code = "OWNER_RECOVERY_REJECTED";

  constructor() {
    super("Owner recovery request rejected");
    this.name = "OwnerRecoveryRejectedError";
  }
}

function reject(): never {
  throw new OwnerRecoveryRejectedError();
}

function validateEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) reject();
  return email;
}

function currentTime(value: Date | undefined): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) reject();
  return now;
}

export async function resetOwnerPassword(
  db: OwnerRecoveryDatabase,
  input: OwnerRecoveryInput,
): Promise<OwnerRecoveryResult> {
  const email = validateEmail(input.email);
  if (input.password.length < 12 || input.password.length > 200) reject();
  const now = currentTime(input.now);

  return withCredentialAdvisoryLock(db, email, async (tx) => {
    const lockedOwner = await tx.execute(sql`
      SELECT id
      FROM "user"
      WHERE email = ${email} AND role = 'OWNER'
      FOR UPDATE
    `);
    const owner = lockedOwner.rows[0] as { id: string } | undefined;
    if (!owner) reject();

    await setCredential(tx, owner.id, input.password, now);
    await tx
      .update(user)
      .set({ state: "ACTIVE", emailVerified: true, updatedAt: now })
      .where(eq(user.id, owner.id));
    await revokeUserSessionsAndDerivedRecognition(tx, owner.id);

    return { userId: owner.id };
  });
}

export const OWNER_RECOVERY_EMAIL_ENV = "ENTRELACOS_OWNER_RECOVERY_EMAIL";
export const OWNER_RECOVERY_PASSWORD_ENV = "ENTRELACOS_OWNER_RECOVERY_PASSWORD";
export const OWNER_RECOVERY_TARGET_ENV = "ENTRELACOS_DATABASE_TARGET";

export function readOwnerRecoveryEnvironment(env: NodeJS.ProcessEnv): {
  email: string;
  password: string;
  target: "test" | "development";
} {
  const email = env[OWNER_RECOVERY_EMAIL_ENV]?.trim();
  const password = env[OWNER_RECOVERY_PASSWORD_ENV];
  const target = env[OWNER_RECOVERY_TARGET_ENV];
  if (!email || !password) {
    throw new Error(
      `Missing ${OWNER_RECOVERY_EMAIL_ENV} or ${OWNER_RECOVERY_PASSWORD_ENV}`,
    );
  }
  if (target !== "test" && target !== "development") {
    throw new Error(`${OWNER_RECOVERY_TARGET_ENV} must be test or development`);
  }
  return { email, password, target };
}
