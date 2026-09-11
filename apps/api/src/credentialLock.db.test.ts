import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { account, session, user } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthDatabase } from "./auth";
import { createAuth } from "./auth";
import { createAuthHttpRouter } from "./authHttp";
import { bootstrapOwner } from "./bootstrapOwner";
import { resetOwnerPassword } from "./ownerRecovery";

const fixturePrefix = `t4-credential-lock-${process.pid}-${randomUUID()}`;
const email = `${fixturePrefix}@example.test`;
const oldPassword = "old-owner-password";
const newPassword = "new-owner-password";
let connection: DatabaseConnection;
let ownerId: string;

function signInRequest(password: string): Request {
  return new Request("https://api.example.test/v1/auth/sign-in/email", {
    method: "POST",
    headers: {
      Origin: "https://admin.example.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
}

describe("credential advisory lock PostgreSQL barrier", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const owner = await bootstrapOwner(connection.db, {
      email,
      name: "Credential Lock Owner",
      password: oldPassword,
    });
    ownerId = owner.userId;
  });

  afterAll(async () => {
    await connection.db.delete(session).where(eq(session.userId, ownerId));
    await connection.db.delete(account).where(eq(account.userId, ownerId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("waits for in-flight native login, then leaves no old session after owner reset", async () => {
    const auth = createAuth({
      db: connection.db,
      secret: "test-only-credential-lock-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releaseLogin = new Promise<void>((resolve) => {
      release = resolve;
    });

    const api = createAuthHttpRouter({
      db: connection.db,
      auth,
      adminOrigin: "https://admin.example.test",
      authForDatabase: (db: AuthDatabase) => {
        const lockedAuth = createAuth({
          db,
          secret: "test-only-credential-lock-secret-that-is-long-enough",
          baseURL: "https://api.example.test",
          adminOrigin: "https://admin.example.test",
        });
        const nativeHandler = lockedAuth.handler;
        lockedAuth.handler = async (request) => {
          started();
          await releaseLogin;
          return nativeHandler(request);
        };
        return lockedAuth;
      },
    });
    const login = api.fetch(signInRequest(oldPassword));
    await loginStarted;

    let resetFinished = false;
    const reset = resetOwnerPassword(connection.db, {
      email,
      password: newPassword,
    }).then((result) => {
      resetFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(resetFinished).toBe(false);

    release();
    const [loginResponse, resetResult] = await Promise.all([login, reset]);
    expect(loginResponse.status).toBe(200);
    expect(resetResult.userId).toBe(ownerId);

    const sessions = await connection.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, ownerId));
    expect(sessions).toHaveLength(0);

    const oldLogin = await auth.handler(signInRequest(oldPassword));
    expect(oldLogin.status).toBe(401);
    const newLogin = await auth.handler(signInRequest(newPassword));
    expect(newLogin.status).toBe(200);
  });
});
