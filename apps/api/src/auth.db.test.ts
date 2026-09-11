import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { account, session, user } from "@entrelacos/database/schema";
import { verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth";
import { bootstrapOwner } from "./bootstrapOwner";

const fixturePrefix = `t1-auth-${process.pid}`;
const ownerPassword = "T1-owner-password-for-tests";
let connection: DatabaseConnection;
let ownerAuth: ReturnType<typeof createAuth>;
const fixtureUserIds: string[] = [];

async function authRequest(
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  return ownerAuth.handler(
    new Request(`https://api.example.test/v1/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://admin.example.test",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function cleanupFixtures(): Promise<void> {
  for (const userId of fixtureUserIds) {
    await connection.db.delete(session).where(eq(session.userId, userId));
    await connection.db.delete(account).where(eq(account.userId, userId));
    await connection.db.delete(user).where(eq(user.id, userId));
  }
}

describe("Better Auth foundation PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    ownerAuth = createAuth({
      db: connection.db,
      secret: "test-only-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
    await connection.close();
  });

  it("disables public email signup without creating a user", async () => {
    const email = `${fixturePrefix}-signup@example.test`;
    const response = await authRequest("sign-up/email", {
      email,
      password: ownerPassword,
      name: "Signup Fixture",
    });

    expect(response.status).toBe(400);
    const [created] = await connection.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    expect(created).toBeUndefined();
  });

  it("bootstraps idempotently, stores a hash, and creates an active login session", async () => {
    const email = `${fixturePrefix}-owner@example.test`;
    const first = await bootstrapOwner(connection.db, {
      email,
      name: "T1 Owner Fixture",
      password: ownerPassword,
    });
    const second = await bootstrapOwner(connection.db, {
      email,
      name: "Ignored Replacement Name",
      password: "ignored-replacement-password",
    });
    fixtureUserIds.push(first.userId);

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, userId: first.userId });

    const [credential] = await connection.db
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, first.userId))
      .limit(1);
    expect(credential.password).toBeTypeOf("string");
    expect(credential.password).not.toBe(ownerPassword);
    await expect(
      verifyPassword({
        hash: credential.password ?? "",
        password: ownerPassword,
      }),
    ).resolves.toBe(true);

    const response = await authRequest("sign-in/email", {
      email,
      password: ownerPassword,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=",
    );

    const [createdSession] = await connection.db
      .select({ userId: session.userId, lastActiveAt: session.lastActiveAt })
      .from(session)
      .where(eq(session.userId, first.userId))
      .limit(1);
    expect(createdSession?.userId).toBe(first.userId);
    expect(createdSession?.lastActiveAt).toBeInstanceOf(Date);
  });

  it.each(["PENDING", "DISABLED"] as const)(
    "rejects credential login for %s account state",
    async (state) => {
      const email = `${fixturePrefix}-${state.toLowerCase()}@example.test`;
      const owner = await bootstrapOwner(connection.db, {
        email,
        name: `${state} Fixture`,
        password: ownerPassword,
      });
      fixtureUserIds.push(owner.userId);
      await connection.db
        .update(user)
        .set({ state })
        .where(eq(user.id, owner.userId));

      const response = await authRequest("sign-in/email", {
        email,
        password: ownerPassword,
      });
      expect(response.status).toBe(401);

      const sessions = await connection.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, owner.userId));
      expect(sessions).toHaveLength(0);
    },
  );
});
