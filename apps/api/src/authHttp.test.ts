import { describe, expect, it, vi } from "vitest";
import { createAuthHttpRouter, getAdministrativeSession } from "./authHttp";

const adminOrigin = "https://admin.example.test";

function createAuthFixture() {
  const auth = {
    handler: vi.fn(),
    api: { getSession: vi.fn() },
  };
  return {
    auth: auth as never,
    handler: auth.handler,
    getSession: auth.api.getSession,
  };
}

function createDatabaseFixture(result: unknown[] = []) {
  let selectCalls = 0;
  const normalizedResult = result.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("session" in entry) ||
      !("user" in entry)
    ) {
      return entry;
    }
    const nested = entry as {
      session: {
        id: string;
        userId: string;
        createdAt: Date;
        expiresAt: Date;
        lastActiveAt: Date;
      };
      user: {
        id: string;
        name: string;
        email: string;
        role: "OWNER" | "SITE_ADMIN";
        state: "PENDING" | "ACTIVE" | "DISABLED";
      };
      membership?: { siteId: string };
    };
    return {
      sessionId: nested.session.id,
      userId: nested.session.userId,
      sessionCreatedAt: nested.session.createdAt,
      sessionExpiresAt: nested.session.expiresAt,
      lastActiveAt: nested.session.lastActiveAt,
      userName: nested.user.name,
      userEmail: nested.user.email,
      userRole: nested.user.role,
      userState: nested.user.state,
      siteId: nested.membership?.siteId,
    };
  });
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ execute: vi.fn().mockResolvedValue({ rows: [] }) }),
    ),
    $client: {
      connect: vi.fn(async () => ({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      })),
    },
    select: vi.fn(() => {
      selectCalls += 1;
      const selected =
        selectCalls === 1
          ? normalizedResult
          : normalizedResult.filter((entry) =>
              Boolean(
                entry &&
                  typeof entry === "object" &&
                  "siteId" in entry &&
                  entry.siteId,
              ),
            );
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(selected),
            })),
          })),
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(selected),
          })),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };
  return { db: db as never, select: db.select, update: db.update };
}

function request(
  path: string,
  body: unknown = undefined,
  headers: Record<string, string> = {},
) {
  return new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: {
      Origin: adminOrigin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("admin authentication HTTP boundary", () => {
  it("sanitizes successful sign-in JSON while preserving Set-Cookie", async () => {
    const fixture = createAuthFixture();
    fixture.handler.mockResolvedValue(
      new Response(
        JSON.stringify({ token: "secret-token", user: { id: "owner" } }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "better-auth.session_token=opaque; Path=/; HttpOnly",
          },
        },
      ),
    );
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const response = await router.request(
      request("/v1/auth/sign-in/email", {
        email: "owner@example.test",
        password: "secret",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=opaque",
    );
    expect(fixture.handler).toHaveBeenCalledOnce();
    const forwarded = fixture.handler.mock.calls[0][0] as Request;
    expect(await forwarded.json()).toEqual({
      email: "owner@example.test",
      password: "secret",
    });
  });

  it("fails closed when no transaction-bound Better Auth factory is configured", async () => {
    const fixture = createAuthFixture();
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const response = await router.request(
      request("/v1/auth/sign-in/email", {
        email: "owner@example.test",
        password: "secret",
      }),
    );
    expect(response.status).toBe(503);
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it("requires exact admin origin and rejects extra login fields", async () => {
    const fixture = createAuthFixture();
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const hostile = await router.request(
      request(
        "/v1/auth/sign-in/email",
        { email: "owner@example.test", password: "secret" },
        { Origin: "https://evil.example.test" },
      ),
    );
    expect(hostile.status).toBe(403);
    expect(fixture.handler).not.toHaveBeenCalled();

    const callback = await router.request(
      request("/v1/auth/sign-in/email", {
        email: "owner@example.test",
        password: "secret",
        callbackURL: "https://evil.example.test",
      }),
    );
    expect(callback.status).toBe(400);
    expect((await callback.json()).code).toBe("VALIDATION_ERROR");
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it.each([
    ["a 5xx response", new Response("internal details", { status: 500 })],
    ["a handler failure", new Error("database secret")],
  ])("does not expose %s as invalid credentials", async (_label, failure) => {
    const fixture = createAuthFixture();
    if (failure instanceof Response) fixture.handler.mockResolvedValue(failure);
    else fixture.handler.mockRejectedValue(failure);
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const response = await router.request(
      request("/v1/auth/sign-in/email", {
        email: "owner@example.test",
        password: "secret",
      }),
    );

    expect(response.status).toBe(failure instanceof Response ? 503 : 502);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      type: "about:blank",
      title: "Authentication service unavailable",
      status: failure instanceof Response ? 503 : 502,
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(responseText).not.toContain("database secret");
  });

  it("exposes only the selected native auth routes", async () => {
    const fixture = createAuthFixture();
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const signup = await router.request(
      request("/v1/auth/sign-up/email", {
        email: "owner@example.test",
        password: "secret",
      }),
    );
    expect(signup.status).toBe(404);
    expect((await signup.json()).code).toBe("NOT_FOUND");
  });

  it("returns a safe actor from /v1/me and updates activity timestamp", async () => {
    const fixture = createAuthFixture();
    fixture.getSession.mockResolvedValue({
      session: {
        id: "session-id",
        userId: "owner-id",
        token: "secret-token",
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
        expiresAt: new Date("2026-09-18T00:00:00.000Z"),
      },
      user: {
        id: "owner-id",
        name: "Owner",
        email: "owner@example.test",
        role: "OWNER",
        state: "ACTIVE",
      },
    });
    const fixtureDb = createDatabaseFixture([
      {
        session: {
          id: "session-id",
          userId: "owner-id",
          createdAt: new Date("2026-09-11T00:00:00.000Z"),
          expiresAt: new Date("2026-09-18T00:00:00.000Z"),
          lastActiveAt: new Date("2026-09-11T01:00:00.000Z"),
        },
        user: {
          id: "owner-id",
          name: "Owner",
          email: "owner@example.test",
          role: "OWNER",
          state: "ACTIVE",
        },
      },
    ]);
    const result = await getAdministrativeSession(
      request("/v1/me", undefined, {
        Cookie: "better-auth.session_token=opaque",
      }),
      {
        auth: fixture.auth,
        db: fixtureDb.db,
        now: () => new Date("2026-09-11T02:00:00.000Z"),
      },
    );

    expect(result).toEqual({
      user: {
        id: "owner-id",
        name: "Owner",
        email: "owner@example.test",
        role: "OWNER",
      },
      session: {
        id: "session-id",
        expiresAt: new Date("2026-09-18T00:00:00.000Z"),
      },
      siteId: null,
    });
    expect(fixtureDb.update).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("sanitizes unexpected session-store failures as service unavailable", async () => {
    const fixture = createAuthFixture();
    fixture.getSession.mockRejectedValue(new Error("database password"));
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: createDatabaseFixture().db,
      adminOrigin,
    });

    const response = await router.request(
      new Request("https://api.example.test/v1/me", {
        headers: {
          Origin: adminOrigin,
          Cookie: "better-auth.session_token=opaque",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Service unavailable",
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("resolves one site membership for site administrators and rejects dangling membership", async () => {
    const fixture = createAuthFixture();
    fixture.getSession.mockResolvedValue({
      session: {
        id: "session-id",
        userId: "site-admin-id",
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
        expiresAt: new Date("2026-09-18T00:00:00.000Z"),
      },
      user: {
        id: "site-admin-id",
        name: "Site Admin",
        email: "admin@example.test",
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    });
    const fixtureDb = createDatabaseFixture([
      {
        session: {
          id: "session-id",
          userId: "site-admin-id",
          createdAt: new Date("2026-09-11T00:00:00.000Z"),
          expiresAt: new Date("2026-09-18T00:00:00.000Z"),
          lastActiveAt: new Date("2026-09-11T01:00:00.000Z"),
        },
        user: {
          id: "site-admin-id",
          name: "Site Admin",
          email: "admin@example.test",
          role: "SITE_ADMIN",
          state: "ACTIVE",
        },
        membership: { siteId: "site-1" },
      },
    ]);

    await expect(
      getAdministrativeSession(request("/v1/me"), {
        auth: fixture.auth,
        db: fixtureDb.db,
        now: () => new Date("2026-09-11T02:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      user: { role: "SITE_ADMIN" },
      siteId: "site-1",
    });

    const dangling = createDatabaseFixture([
      {
        session: {
          id: "session-id",
          userId: "site-admin-id",
          createdAt: new Date("2026-09-11T00:00:00.000Z"),
          expiresAt: new Date("2026-09-18T00:00:00.000Z"),
          lastActiveAt: new Date("2026-09-11T01:00:00.000Z"),
        },
        user: {
          id: "site-admin-id",
          name: "Site Admin",
          email: "admin@example.test",
          role: "SITE_ADMIN",
          state: "ACTIVE",
        },
      },
    ]);
    await expect(
      getAdministrativeSession(request("/v1/me"), {
        auth: fixture.auth,
        db: dangling.db,
        now: () => new Date("2026-09-11T02:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("sanitizes unexpected database query failures as service unavailable", async () => {
    const fixture = createAuthFixture();
    fixture.getSession.mockResolvedValue({
      session: { id: "session-id" },
      user: { id: "owner-id" },
    });
    const fixtureDb = createDatabaseFixture();
    fixtureDb.select.mockImplementation(() => {
      throw new Error("database password");
    });
    const router = createAuthHttpRouter({
      auth: fixture.auth,
      authForDatabase: () => fixture.auth,
      db: fixtureDb.db,
      adminOrigin,
    });

    const response = await router.request(
      new Request("https://api.example.test/v1/me", {
        headers: {
          Origin: adminOrigin,
          Cookie: "better-auth.session_token=opaque",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Service unavailable",
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it.each(["inactive", "idle", "absolute"])(
    "rejects %s sessions",
    async (failure) => {
      const fixture = createAuthFixture();
      const now = new Date("2026-09-11T00:00:00.000Z");
      const createdAt =
        failure === "absolute"
          ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          : new Date(now.getTime() - 60 * 60 * 1000);
      const expiresAt =
        failure === "absolute"
          ? new Date(now.getTime() + 60 * 60 * 1000)
          : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const lastActiveAt =
        failure === "idle"
          ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
          : new Date(now.getTime() - 60 * 60 * 1000);
      fixture.getSession.mockResolvedValue({
        session: {
          id: "session-id",
          userId: "owner-id",
          createdAt,
          expiresAt,
        },
        user: {
          id: "owner-id",
          name: "Owner",
          email: "owner@example.test",
          role: "OWNER",
          state: failure === "inactive" ? "DISABLED" : "ACTIVE",
        },
      });
      const fixtureDb = createDatabaseFixture([
        {
          session: {
            id: "session-id",
            userId: "owner-id",
            createdAt,
            expiresAt,
            lastActiveAt,
          },
          user: {
            id: "owner-id",
            name: "Owner",
            email: "owner@example.test",
            role: "OWNER",
            state: failure === "inactive" ? "DISABLED" : "ACTIVE",
          },
        },
      ]);
      const result = await getAdministrativeSession(
        request("/v1/me", undefined, {
          Cookie: "better-auth.session_token=opaque",
        }),
        { auth: fixture.auth, db: fixtureDb.db, now: () => now },
      );
      expect(result).toBeNull();
    },
  );

  it("accepts sessions just before idle and absolute limits", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z");
    const fixture = createAuthFixture();
    fixture.getSession.mockResolvedValue({
      session: {
        id: "session-id",
        userId: "owner-id",
        createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 + 1),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
      user: {
        id: "owner-id",
        name: "Owner",
        email: "owner@example.test",
        role: "OWNER",
        state: "ACTIVE",
      },
    });
    const fixtureDb = createDatabaseFixture([
      {
        session: {
          id: "session-id",
          userId: "owner-id",
          createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 + 1),
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          lastActiveAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1),
        },
        user: {
          id: "owner-id",
          name: "Owner",
          email: "owner@example.test",
          role: "OWNER",
          state: "ACTIVE",
        },
      },
    ]);
    await expect(
      getAdministrativeSession(
        request("/v1/me", undefined, {
          Cookie: "better-auth.session_token=opaque",
        }),
        { auth: fixture.auth, db: fixtureDb.db, now: () => now },
      ),
    ).resolves.toMatchObject({ user: { id: "owner-id" } });
  });
});
