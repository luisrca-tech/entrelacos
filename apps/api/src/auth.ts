import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  account,
  session,
  user,
  verification,
} from "@entrelacos/database/schema";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export const AUTH_BASE_PATH = "/v1/auth";
export const ADMIN_SESSION_EXPIRES_IN = 60 * 60 * 24 * 7;

export type AuthDatabase = NodePgDatabase<Record<string, never>>;

export interface AuthFactoryOptions {
  db: AuthDatabase;
  secret: string;
  baseURL: string;
  adminOrigin: string;
}

function requiredSetting(value: string, name: string): string {
  if (!value.trim()) {
    throw new Error(`${name} is required for Better Auth`);
  }
  return value;
}

export function createAuth(options: AuthFactoryOptions) {
  const secret = requiredSetting(options.secret, "secret");
  const baseURL = requiredSetting(options.baseURL, "baseURL");
  const adminOrigin = requiredSetting(options.adminOrigin, "adminOrigin");
  const db = options.db;

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
      transaction: true,
    }),
    secret,
    baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [adminOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
    },
    user: {
      additionalFields: {
        role: {
          type: ["OWNER", "SITE_ADMIN"],
          required: true,
          defaultValue: "SITE_ADMIN",
          input: false,
        },
        state: {
          type: ["PENDING", "ACTIVE", "DISABLED"],
          required: true,
          defaultValue: "PENDING",
          input: false,
        },
      },
    },
    session: {
      expiresIn: ADMIN_SESSION_EXPIRES_IN,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        lastActiveAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
          defaultValue: () => new Date(),
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (newSession) => {
            const [accountUser] = await db
              .select({ state: user.state })
              .from(user)
              .where(eq(user.id, newSession.userId))
              .limit(1);

            if (accountUser?.state !== "ACTIVE") {
              return false;
            }

            return { data: { lastActiveAt: new Date() } };
          },
        },
      },
    },
  });
}
