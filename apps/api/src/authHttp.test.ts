import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthHttpRouter,
  getAdministrativeSession,
  readAdministrativeSession,
} from "./authHttp";

const adminOrigin = "https://admin.example.test";

function createAuthFixture(contextEvidence: unknown = undefined) {
  const auth = {
    handler: vi.fn(),
    api: { getSession: vi.fn() },
    $context: Promise.resolve(contextEvidence),
  };
  return {
    auth: auth as never,
    handler: auth.handler,
    getSession: auth.api.getSession,
  };
}

function createDatabaseFixture(result: unknown[] = []) {
  const set = vi.fn(() => ({
    where: vi.fn().mockResolvedValue(undefined),
  }));
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
        role: "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT";
        state: "PENDING" | "ACTIVE" | "DISABLED";
      };
      membership?: {
        siteId: string;
        role?: "SITE_ADMIN" | "SITE_ASSISTANT";
        revokedAt?: Date | null;
      };
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
      membershipRole: nested.membership?.role ?? "SITE_ADMIN",
      revokedAt: nested.membership?.revokedAt ?? null,
    };
  });
  const db = {
    execute: vi.fn(async (_query: SQL) => ({
      rows: normalizedResult.flatMap((entry) => {
        const row = entry as {
          siteId?: string;
          userId: string;
          userRole: string;
          userState: string;
          membershipRole: string;
          revokedAt: Date | null;
        };
        return row.siteId
          ? [
              {
                user_id: row.userId,
                account_role: row.userRole,
                account_state: row.userState,
                site_id: row.siteId,
                membership_id: `membership-${row.siteId}`,
                membership_user_id: row.userId,
                membership_role: row.membershipRole,
                revoked_at: row.revokedAt,
              },
            ]
          : [];
      }),
    })),
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
      const selected = normalizedResult;
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
    update: vi.fn(() => ({ set })),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  return {
    db: db as never,
    select: db.select,
    update: db.update,
    set,
    insert: db.insert,
    delete: db.delete,
    execute: db.execute,
    transaction: db.transaction,
    connect: db.$client.connect,
  };
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
      memberships: [],
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

  it("resolves a single site's membership without granting unassigned access", async () => {
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
    ).resolves.toMatchObject({ siteId: null, memberships: [] });
  });

  it("returns each active membership and never chooses the first wedding for multi-site actors", async () => {
    const fixture = createAuthFixture();
    fixture.getSession.mockResolvedValue({ session: { id: "session-id" } });
    const shared = {
      session: {
        id: "session-id",
        userId: "helper",
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
        expiresAt: new Date("2026-09-18T00:00:00.000Z"),
        lastActiveAt: new Date("2026-09-11T01:00:00.000Z"),
      },
      user: {
        id: "helper",
        name: "Helper",
        email: "helper@example.test",
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    };
    const fixtureDb = createDatabaseFixture([
      { ...shared, membership: { siteId: "wedding-a", role: "SITE_ADMIN" } },
      {
        ...shared,
        membership: { siteId: "wedding-b", role: "SITE_ASSISTANT" },
      },
      {
        ...shared,
        membership: {
          siteId: "revoked",
          role: "SITE_ASSISTANT",
          revokedAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      },
    ]);
    const actor = await getAdministrativeSession(request("/v1/me"), {
      auth: fixture.auth,
      db: fixtureDb.db,
      now: () => new Date("2026-09-11T02:00:00.000Z"),
    });
    expect(actor?.siteId).toBeNull();
    expect(actor?.memberships.map((entry) => entry.siteId)).toEqual([
      "wedding-a",
      "wedding-b",
    ]);
    expect(actor?.memberships[1].capabilities.readFinance).toBe(false);
    expect(actor?.memberships[1].capabilities.manageTeam).toBe(false);
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

describe("read-only administrative sessions", () => {
  const now = new Date("2026-09-11T02:00:00.000Z");

  function createReadFixture(
    overrides: Record<string, unknown> = {},
    contextEvidence: unknown = {
      options: { session: { deferSessionRefresh: true } },
    },
  ) {
    const record = {
      sessionId: "session-id",
      userId: "admin-id",
      sessionCreatedAt: new Date("2026-09-11T00:00:00.000Z"),
      sessionExpiresAt: new Date("2026-09-18T00:00:00.000Z"),
      lastActiveAt: new Date("2026-09-11T01:00:00.000Z"),
      userName: "Site Admin",
      userEmail: "admin@example.test",
      userRole: "SITE_ADMIN",
      userState: "ACTIVE",
      siteId: "site-1",
      membershipRole: "SITE_ADMIN",
      revokedAt: null,
      ...overrides,
    };
    const fixture = createAuthFixture(contextEvidence);
    fixture.getSession.mockResolvedValue({
      session: { id: "session-id", token: "private-session-token" },
      user: { id: "admin-id" },
    });
    const fixtureDb = createDatabaseFixture([record]);
    const sessionRequest = request("/v1/me", undefined, {
      Cookie: "better-auth.session_token=opaque",
    });
    const options = {
      auth: fixture.auth,
      db: fixtureDb.db,
      now: () => now,
    };
    return { fixture, fixtureDb, sessionRequest, options, record };
  }

  function expectReadOnly(fixture: ReturnType<typeof createReadFixture>) {
    expect(fixture.fixtureDb.update).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.set).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.insert).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.delete).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.transaction).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.connect).not.toHaveBeenCalled();
    expect(fixture.fixture.handler).not.toHaveBeenCalled();
    for (const [query] of fixture.fixtureDb.execute.mock.calls) {
      expect(new PgDialect().sqlToQuery(query).sql.trim()).toMatch(/^SELECT\b/);
    }
    expect(fixture.sessionRequest.headers.get("cookie")).toBe(
      "better-auth.session_token=opaque",
    );
  }

  it("returns the existing safe actor projection from a fresh lookup without writes", async () => {
    const fixture = createReadFixture();
    const result = await readAdministrativeSession(
      fixture.sessionRequest,
      fixture.options,
    );

    expect(result).toEqual({
      user: {
        id: "admin-id",
        name: "Site Admin",
        email: "admin@example.test",
        role: "SITE_ADMIN",
      },
      session: {
        id: "session-id",
        expiresAt: fixture.record.sessionExpiresAt,
      },
      siteId: "site-1",
      memberships: [
        {
          userId: "admin-id",
          siteId: "site-1",
          membershipId: "membership-site-1",
          membershipRole: "SITE_ADMIN",
          capabilities: {
            manageInvitations: true,
            manageMessages: true,
            manageCatalog: true,
            manageTeam: true,
            readFinance: true,
            configureReceiving: true,
            requestWithdrawal: false,
          },
        },
      ],
    });
    expect(fixture.fixture.getSession).toHaveBeenCalledExactlyOnceWith({
      headers: fixture.sessionRequest.headers,
      method: "GET",
      asResponse: false,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(JSON.stringify(result)).not.toContain("private-session-token");
    expectReadOnly(fixture);
  });

  it.each([
    null,
    {},
    { options: null },
    { options: {} },
    { options: { session: {} } },
    { options: { session: { deferSessionRefresh: false } } },
    { options: { session: { deferSessionRefresh: "true" } } },
  ])(
    "denies unsafe auth context %j before any session lookup",
    async (evidence) => {
      const fixture = createReadFixture({}, evidence);
      await expect(
        readAdministrativeSession(fixture.sessionRequest, fixture.options),
      ).resolves.toBeNull();
      expect(fixture.fixture.getSession).not.toHaveBeenCalled();
      expect(fixture.fixtureDb.select).not.toHaveBeenCalled();
      expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
      expectReadOnly(fixture);
    },
  );

  it("denies a missing auth context without invoking the unsafe session lookup", async () => {
    const fixture = createReadFixture();
    const auth = createAuthFixture();
    await expect(
      readAdministrativeSession(fixture.sessionRequest, {
        ...fixture.options,
        auth: auth.auth,
      }),
    ).resolves.toBeNull();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.select).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it("reads an immutable auth context without altering its session configuration", async () => {
    const context = Object.freeze({
      options: Object.freeze({
        session: Object.freeze({ deferSessionRefresh: true }),
      }),
    });
    const fixture = createReadFixture({}, context);
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toMatchObject({ user: { id: "admin-id" } });
    expect(context).toEqual({
      options: { session: { deferSessionRefresh: true } },
    });
    expectReadOnly(fixture);
  });

  it.each(["OWNER", "SITE_ADMIN", "SITE_ASSISTANT"])(
    "preserves the current %s actor and membership capabilities",
    async (role) => {
      const fixture = createReadFixture({
        userRole: role,
        membershipRole: role === "OWNER" ? "SITE_ADMIN" : role,
      });
      const result = await readAdministrativeSession(
        fixture.sessionRequest,
        fixture.options,
      );
      expect(result?.user.role).toBe(role);
      if (role === "OWNER") {
        expect(result?.memberships).toEqual([]);
        expect(result?.siteId).toBeNull();
        expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
      } else {
        expect(result?.memberships[0].membershipRole).toBe(role);
        expect(result?.memberships[0].capabilities.configureReceiving).toBe(
          role === "SITE_ADMIN",
        );
      }
      expectReadOnly(fixture);
    },
  );

  it.each([
    null,
    undefined,
    {},
    { session: null },
    { session: {} },
    { session: { id: "" } },
    { session: { id: 123 } },
  ])(
    "denies missing or malformed authenticated session evidence %j",
    async (evidence) => {
      const fixture = createReadFixture();
      fixture.fixture.getSession.mockResolvedValue(evidence);
      await expect(
        readAdministrativeSession(fixture.sessionRequest, fixture.options),
      ).resolves.toBeNull();
      expect(fixture.fixtureDb.select).not.toHaveBeenCalled();
      expectReadOnly(fixture);
    },
  );

  it("denies a revoked session that no longer exists in the current database", async () => {
    const fixture = createReadFixture();
    const missing = createDatabaseFixture();
    await expect(
      readAdministrativeSession(fixture.sessionRequest, {
        ...fixture.options,
        db: missing.db,
      }),
    ).resolves.toBeNull();
    expect(missing.update).not.toHaveBeenCalled();
    expect(missing.insert).not.toHaveBeenCalled();
    expect(missing.delete).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it("preserves current multi-site access without choosing the first membership", async () => {
    const fixture = createReadFixture();
    const fixtureDb = createDatabaseFixture([
      fixture.record,
      {
        ...fixture.record,
        siteId: "site-2",
        membershipRole: "SITE_ASSISTANT",
      },
      { ...fixture.record, siteId: "revoked-site", revokedAt: now },
    ]);
    const result = await readAdministrativeSession(fixture.sessionRequest, {
      ...fixture.options,
      db: fixtureDb.db,
    });
    expect(result?.siteId).toBeNull();
    expect(result?.memberships.map((membership) => membership.siteId)).toEqual([
      "site-1",
      "site-2",
    ]);
    expect(result?.memberships[1].capabilities.configureReceiving).toBe(false);
    expectReadOnly({ ...fixture, fixtureDb });
  });

  it("denies inconsistent stored session identity", async () => {
    const fixture = createReadFixture({ sessionId: "foreign-session" });
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toBeNull();
    expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it("denies a non-administrative stored user role", async () => {
    const fixture = createReadFixture({ userRole: "UNKNOWN" });
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toBeNull();
    expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it.each(["PENDING", "DISABLED", "UNKNOWN"])(
    "denies %s users without reading memberships or writing activity",
    async (state) => {
      const fixture = createReadFixture({ userState: state });
      await expect(
        readAdministrativeSession(fixture.sessionRequest, fixture.options),
      ).resolves.toBeNull();
      expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
      expectReadOnly(fixture);
    },
  );

  it.each([
    ["revoked membership", { revokedAt: now }],
    ["invalid membership role", { membershipRole: "OWNER" }],
    ["no assigned membership", { siteId: undefined }],
  ])("grants no site access for %s", async (_name, overrides) => {
    const fixture = createReadFixture(overrides);
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toMatchObject({ siteId: null, memberships: [] });
    expectReadOnly(fixture);
  });

  const invalidTimes: [string, unknown][] = [
    ["invalid Date", new Date(Number.NaN)],
    ["infinite Date", new Date(Number.POSITIVE_INFINITY)],
    ["ISO string", now.toISOString()],
    ["epoch number", now.getTime()],
    ["null", null],
    ["undefined", undefined],
    ["date-like object", { getTime: () => now.getTime() }],
    ["Date prototype without a timestamp", Object.create(Date.prototype)],
  ];

  it.each(
    ["now", "sessionCreatedAt", "sessionExpiresAt", "lastActiveAt"].flatMap(
      (field) =>
        invalidTimes.map(([name, value]) => [field, name, value] as const),
    ),
  )("denies %s with %s", async (field, _name, value) => {
    const fixture = createReadFixture(
      field === "now" ? {} : { [field]: value },
    );
    await expect(
      readAdministrativeSession(fixture.sessionRequest, {
        ...fixture.options,
        now: field === "now" ? () => value as Date : fixture.options.now,
      }),
    ).resolves.toBeNull();
    expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it.each([
    ["future creation", { sessionCreatedAt: new Date(now.getTime() + 1) }],
    ["future activity", { lastActiveAt: new Date(now.getTime() + 1) }],
    [
      "activity before creation",
      { lastActiveAt: new Date("2026-09-10T23:59:59.999Z") },
    ],
    ["expired", { sessionExpiresAt: new Date(now.getTime() - 1) }],
    ["expiry boundary", { sessionExpiresAt: now }],
    [
      "idle boundary",
      { lastActiveAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    ],
    [
      "absolute boundary",
      { sessionCreatedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    ],
  ])("denies %s without writing", async (_name, overrides) => {
    const fixture = createReadFixture(overrides);
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toBeNull();
    expect(fixture.fixtureDb.execute).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  it("accepts the final millisecond before expiry, idle and absolute limits", async () => {
    const fixture = createReadFixture({
      sessionCreatedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 + 1),
      lastActiveAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1),
      sessionExpiresAt: new Date(now.getTime() + 1),
    });
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toMatchObject({ user: { id: "admin-id" } });
    expectReadOnly(fixture);
  });

  it("does not keep an idle session alive across repeated reads", async () => {
    const fixture = createReadFixture();
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).resolves.toMatchObject({ user: { id: "admin-id" } });
    await expect(
      readAdministrativeSession(fixture.sessionRequest, {
        ...fixture.options,
        now: () => new Date("2026-09-12T01:00:00.000Z"),
      }),
    ).resolves.toBeNull();
    expect(fixture.fixture.getSession).toHaveBeenCalledTimes(2);
    expectReadOnly(fixture);
  });

  it("keeps current session lookup and membership failures observable without writes", async () => {
    const fixture = createReadFixture();
    const lookupFailure = new Error("Session lookup unavailable");
    fixture.fixture.getSession.mockRejectedValueOnce(lookupFailure);
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).rejects.toBe(lookupFailure);
    expect(fixture.fixtureDb.select).not.toHaveBeenCalled();
    expectReadOnly(fixture);

    const membershipFailure = new Error("Membership lookup unavailable");
    fixture.fixtureDb.execute.mockRejectedValueOnce(membershipFailure);
    await expect(
      readAdministrativeSession(fixture.sessionRequest, fixture.options),
    ).rejects.toBe(membershipFailure);
    expectReadOnly(fixture);
  });

  it("preserves the /v1/me response and activity update after a read-only lookup", async () => {
    const fixture = createReadFixture();
    const readActor = await readAdministrativeSession(
      fixture.sessionRequest,
      fixture.options,
    );
    expectReadOnly(fixture);
    const router = createAuthHttpRouter({
      ...fixture.options,
      adminOrigin,
    });
    const response = await router.request(
      new Request("https://api.example.test/v1/me", {
        headers: fixture.sessionRequest.headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(JSON.stringify(readActor)),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fixture.fixtureDb.update).toHaveBeenCalledOnce();
    expect(fixture.fixtureDb.set).toHaveBeenCalledExactlyOnceWith({
      lastActiveAt: now,
      updatedAt: now,
    });
    expect(fixture.fixtureDb.insert).not.toHaveBeenCalled();
    expect(fixture.fixtureDb.delete).not.toHaveBeenCalled();
  });
});
