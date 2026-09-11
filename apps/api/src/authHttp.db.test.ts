import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { account, session, user } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth";
import { createAuthHttpRouter } from "./authHttp";
import { bootstrapOwner } from "./bootstrapOwner";

const adminOrigin = "https://admin.example.test";
const fixturePrefix = `t2-auth-http-${process.pid}`;
const ownerPassword = "T2-owner-password-for-tests";

let connection: DatabaseConnection;
let router: ReturnType<typeof createAuthHttpRouter>;
const fixtureUserIds: string[] = [];

async function createOwner(tag: string) {
  const owner = await bootstrapOwner(connection.db, {
    email: `${fixturePrefix}-${tag}@example.test`,
    name: `T2 ${tag} Owner`,
    password: ownerPassword,
  });
  fixtureUserIds.push(owner.userId);
  return owner;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: adminOrigin,
      ...(init.headers ?? {}),
    },
  });
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return router.request(
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("better-auth.session_token=");
  if (!setCookie) throw new Error("Expected auth session cookie");
  const cookie = setCookie.split(";", 1)[0];
  if (!cookie) throw new Error("Expected auth session cookie value");
  return cookie;
}

async function cleanupFixtures(): Promise<void> {
  for (const userId of fixtureUserIds) {
    await connection.db.delete(session).where(eq(session.userId, userId));
    await connection.db.delete(account).where(eq(account.userId, userId));
    await connection.db.delete(user).where(eq(user.id, userId));
  }
}

describe("admin authentication HTTP PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const auth = createAuth({
      db: connection.db,
      secret: "test-only-auth-http-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin,
    });
    router = createAuthHttpRouter({
      auth,
      db: connection.db,
      adminOrigin,
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
    await connection.close();
  });

  it("logs in, returns a safe actor, and revokes the session on sign-out", async () => {
    const owner = await createOwner("lifecycle");
    const email = `${fixturePrefix}-lifecycle@example.test`;

    const login = await jsonRequest("/v1/auth/sign-in/email", {
      email,
      password: ownerPassword,
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ ok: true });
    const cookie = sessionCookie(login);

    const me = await router.request(
      request("/v1/me", { headers: { Cookie: cookie } }),
    );
    expect(me.status).toBe(200);
    const actor = await me.json();
    expect(actor).toMatchObject({
      user: {
        id: owner.userId,
        name: "T2 lifecycle Owner",
        email,
        role: "OWNER",
      },
    });
    expect(Object.keys(actor.user).sort()).toEqual([
      "email",
      "id",
      "name",
      "role",
    ]);
    expect(Object.keys(actor.session).sort()).toEqual(["expiresAt", "id"]);

    const [createdSession] = await connection.db
      .select({ lastActiveAt: session.lastActiveAt })
      .from(session)
      .where(eq(session.userId, owner.userId))
      .limit(1);
    expect(createdSession?.lastActiveAt).toBeInstanceOf(Date);

    const signOut = await jsonRequest(
      "/v1/auth/sign-out",
      {},
      { Cookie: cookie },
    );
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ ok: true });

    const afterSignOut = await router.request(
      request("/v1/me", { headers: { Cookie: cookie } }),
    );
    expect(afterSignOut.status).toBe(401);
  });

  it("keeps signup unavailable at the HTTP boundary", async () => {
    const email = `${fixturePrefix}-signup@example.test`;
    const response = await jsonRequest("/v1/auth/sign-up/email", {
      email,
      password: ownerPassword,
      name: "Signup Fixture",
    });

    expect(response.status).toBe(404);
    const [created] = await connection.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    expect(created).toBeUndefined();
  });

  it.each(["PENDING", "DISABLED"] as const)(
    "denies credential login for %s accounts",
    async (state) => {
      const owner = await createOwner(state.toLowerCase());
      await connection.db
        .update(user)
        .set({ state })
        .where(eq(user.id, owner.userId));

      const response = await jsonRequest("/v1/auth/sign-in/email", {
        email: `${fixturePrefix}-${state.toLowerCase()}@example.test`,
        password: ownerPassword,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);

      const sessions = await connection.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, owner.userId));
      expect(sessions).toHaveLength(0);
    },
  );
});
