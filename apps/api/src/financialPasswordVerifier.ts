import { giftQuoteSchema } from "@entrelacos/contracts";
import { account, user } from "@entrelacos/database/schema";
import { verifyPassword as verifyBetterAuthPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import type { AuthDatabase } from "./auth";

export type FinancialPasswordVerifierDatabase = Pick<AuthDatabase, "execute">;

export interface FinancialPasswordVerifierInput {
  userId: string;
  password: string;
}

export interface FinancialPasswordVerifier {
  verifyPassword(input: FinancialPasswordVerifierInput): Promise<boolean>;
}

export class FinancialPasswordVerifierServiceError extends Error {
  readonly status = 503;
  readonly code = "FINANCIAL_PASSWORD_UNAVAILABLE";
  readonly title = "Financial password verification is unavailable";

  constructor() {
    super("Financial password verification is unavailable");
    this.name = "FinancialPasswordVerifierServiceError";
  }
}

function unavailable(): never {
  throw new FinancialPasswordVerifierServiceError();
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function readInput(value: unknown): FinancialPasswordVerifierInput | null {
  const raw = record(value);
  if (!raw) return null;
  const keys = Reflect.ownKeys(raw);
  const userId = giftQuoteSchema.shape.siteId.safeParse(raw.userId);
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "userId" && key !== "password") ||
    !userId.success ||
    typeof raw.password !== "string" ||
    raw.password.length < 1 ||
    raw.password.length > 200
  )
    return null;
  return { userId: userId.data, password: raw.password };
}

// Actor/site/session authorization is resolved by the calling server service.
// This adapter only verifies the current local credential; it grants no action.
export function createFinancialPasswordVerifier(
  db: FinancialPasswordVerifierDatabase,
): FinancialPasswordVerifier {
  try {
    if (typeof db?.execute !== "function") return unavailable();
    const execute = db.execute.bind(db);
    return {
      async verifyPassword(input) {
        try {
          const value = readInput(input);
          if (!value) return false;
          const result =
            await execute(sql`SELECT a.password FROM ${account} a INNER JOIN ${user} u ON u.id = a.user_id
            WHERE a.user_id = ${value.userId} AND a.provider_id = 'credential' AND u.state = 'ACTIVE' LIMIT 2`);
          if (!result || !Array.isArray(result.rows) || result.rows.length > 1)
            return unavailable();
          if (result.rows.length === 0) return false;
          const row = record(result.rows[0]);
          if (
            !row ||
            Reflect.ownKeys(row).length !== 1 ||
            !Object.hasOwn(row, "password")
          )
            return unavailable();
          const hash = row.password;
          if (hash === null) return false;
          // The installed Better Auth default scrypt format is salt16:key64 hex.
          // Reject corruption that its split parser could silently ignore.
          if (
            typeof hash !== "string" ||
            hash.length !== 161 ||
            !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)
          )
            return unavailable();
          return await verifyBetterAuthPassword({
            hash,
            password: value.password,
          });
        } catch {
          return unavailable();
        }
      },
    };
  } catch {
    return unavailable();
  }
}
