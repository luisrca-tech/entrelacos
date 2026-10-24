import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SESSION_EXPIRES_IN,
  createAuth,
  createSessionReadAuth,
} from "./auth";
import { readAdministrativeSession } from "./authHttp";
import { bootstrapOwner } from "./bootstrapOwner";

function createAuthDatabase(
  userRows: Array<{ state: "ACTIVE" | "PENDING" | "DISABLED" }> = [],
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(userRows),
        })),
      })),
    })),
  } as never;
}

function createBootstrapDatabase(
  existingUsers: Array<{ id: string; role: "OWNER" | "SITE_ADMIN" }> = [],
) {
  const inserted: Record<string, unknown>[] = [];
  const transaction = vi.fn(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => existingUsers }),
          }),
        }),
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            inserted.push(value);
          },
        }),
      }),
  );

  return { db: { transaction } as never, inserted, transaction };
}

describe("Better Auth foundation", () => {
  it("requires explicit auth connection settings and freezes the admin config", () => {
    const auth = createAuth({
      db: createAuthDatabase(),
      secret: "test-only-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });

    expect(auth.options.basePath).toBe("/v1/auth");
    expect(auth.options.baseURL).toBe("https://api.example.test");
    expect(auth.options.secret).toBe(
      "test-only-auth-secret-that-is-long-enough",
    );
    expect(auth.options.trustedOrigins).toEqual(["https://admin.example.test"]);
    expect(auth.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      maxPasswordLength: 200,
    });
    expect(auth.options.session).toMatchObject({
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    });
    expect(auth.options.user?.additionalFields).toMatchObject({
      role: { input: false, type: ["OWNER", "SITE_ADMIN", "SITE_ASSISTANT"] },
      state: { input: false },
    });
    expect(auth.options.session?.additionalFields).toMatchObject({
      lastActiveAt: { input: false, returned: false },
    });
  });

  it.each([
    ["secret", { secret: "" }],
    ["baseURL", { baseURL: "" }],
    ["adminOrigin", { adminOrigin: "" }],
  ])("rejects missing explicit %s", (_name, override) => {
    expect(() =>
      createAuth({
        db: createAuthDatabase(),
        secret: "test-only-auth-secret-that-is-long-enough",
        baseURL: "https://api.example.test",
        adminOrigin: "https://admin.example.test",
        ...override,
      }),
    ).toThrow();
  });

  it("rejects a session for a non-active account and initializes lastActiveAt for an active account", async () => {
    const activeDatabase = createAuthDatabase([{ state: "ACTIVE" }]);
    const activeAuth = createAuth({
      db: activeDatabase,
      secret: "test-only-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });
    const activeHook =
      activeAuth.options.databaseHooks?.session?.create?.before;
    const activeResult = await activeHook?.({ userId: "owner-id" } as never);
    expect(activeResult).toMatchObject({
      data: { lastActiveAt: expect.any(Date) },
    });

    const disabledAuth = createAuth({
      db: createAuthDatabase([{ state: "DISABLED" }]),
      secret: "test-only-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });
    const disabledHook =
      disabledAuth.options.databaseHooks?.session?.create?.before;
    await expect(
      disabledHook?.({ userId: "disabled-id" } as never),
    ).resolves.toBe(false);
  });
});

describe("isolated native administrative session reads", () => {
  const now = new Date("2026-10-12T12:00:00.000Z");
  const secret = "test-only-session-read-secret-that-is-long-enough";
  const adminOrigin = "https://admin.example.test";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function nativeFixture(
    sessionOverrides: Record<string, unknown> = {},
    userOverrides: Record<string, unknown> = {},
    missing = false,
  ) {
    const storedSession = {
      id: "read-session",
      userId: "read-user",
      token: "fictional-read-token",
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      ipAddress: null,
      userAgent: null,
      ...sessionOverrides,
    };
    const storedUser = {
      id: "read-user",
      name: "Read Fixture",
      email: "read@example.test",
      emailVerified: true,
      image: null,
      role: "OWNER",
      state: "ACTIVE",
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      ...userOverrides,
    };
    const limit = vi.fn().mockResolvedValue([
      {
        sessionId: storedSession.id,
        userId: storedSession.userId,
        sessionCreatedAt: storedSession.createdAt,
        sessionExpiresAt: storedSession.expiresAt,
        lastActiveAt: storedSession.lastActiveAt,
        userName: storedUser.name,
        userEmail: storedUser.email,
        userRole: storedUser.role,
        userState: storedUser.state,
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit }) }),
        }),
      })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    };
    const options = {
      db: db as never,
      secret,
      baseURL: "https://api.example.test",
      adminOrigin,
    };
    const auth = createSessionReadAuth(options);
    const context = await auth.$context;
    const findSession = vi
      .spyOn(context.internalAdapter, "findSession")
      .mockResolvedValue(
        missing
          ? null
          : ({ session: storedSession, user: storedUser } as never),
      );
    const deleteSession = vi.spyOn(context.internalAdapter, "deleteSession");
    const getSession = vi.spyOn(auth.api, "getSession");
    const signature = createHmac("sha256", secret)
      .update("fictional-read-token")
      .digest("base64");
    const headers = new Headers({
      Origin: adminOrigin,
      Cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`fictional-read-token.${signature}`)}`,
    });
    const request = new Request("https://api.example.test/fixture/context", {
      headers,
    });
    return {
      auth,
      context,
      db,
      options,
      findSession,
      deleteSession,
      getSession,
      request,
    };
  }

  function expectNoPersistentWrites(
    fixture: Awaited<ReturnType<typeof nativeFixture>>,
  ) {
    expect(fixture.deleteSession).not.toHaveBeenCalled();
    expect(fixture.db.insert).not.toHaveBeenCalled();
    expect(fixture.db.update).not.toHaveBeenCalled();
    expect(fixture.db.delete).not.toHaveBeenCalled();
    expect(fixture.db.transaction).not.toHaveBeenCalled();
  }

  it("constructs a separate deferred GET instance without changing default auth options", async () => {
    const fixture = await nativeFixture();
    const standard = createAuth(fixture.options);
    expect(standard.options.session).not.toHaveProperty("deferSessionRefresh");
    expect(fixture.auth.options.session).toMatchObject({
      expiresIn: ADMIN_SESSION_EXPIRES_IN,
      disableSessionRefresh: true,
      deferSessionRefresh: true,
      cookieCache: { enabled: false },
    });
    expect(fixture.auth.options.user).toEqual(standard.options.user);
    expect(fixture.auth.options.emailAndPassword).toEqual(
      standard.options.emailAndPassword,
    );
    expect(fixture.auth).not.toBe(standard);
    expect(fixture.context).not.toBe(await standard.$context);
    const standardLookup = vi.spyOn(standard.api, "getSession");
    await expect(
      readAdministrativeSession(fixture.request, {
        auth: standard,
        db: fixture.options.db,
        now: () => now,
      }),
    ).resolves.toBeNull();
    expect(standardLookup).not.toHaveBeenCalled();
    expect(standard.options.session).not.toHaveProperty("deferSessionRefresh");
    expectNoPersistentWrites(fixture);
  });

  it("uses installed native signature verification and a fresh lookup for active sessions", async () => {
    const fixture = await nativeFixture();
    const actor = await readAdministrativeSession(fixture.request, {
      auth: fixture.auth,
      db: fixture.options.db,
      now: () => now,
    });
    expect(actor).toEqual({
      user: {
        id: "read-user",
        name: "Read Fixture",
        email: "read@example.test",
        role: "OWNER",
      },
      session: {
        id: "read-session",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
      siteId: null,
      memberships: [],
    });
    expect(fixture.findSession).toHaveBeenCalledExactlyOnceWith(
      "fictional-read-token",
    );
    expect(fixture.getSession).toHaveBeenCalledExactlyOnceWith({
      headers: fixture.request.headers,
      method: "GET",
      asResponse: false,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(fixture.db.select).toHaveBeenCalledOnce();
    expect(JSON.stringify(actor)).not.toContain("fictional-read-token");
    expectNoPersistentWrites(fixture);
  });

  it.each(["active", "expired", "missing", "revoked"])(
    "does not forward native %s session cookies from body-only reads",
    async (state) => {
      const fixture = await nativeFixture(
        state === "expired" ? { expiresAt: new Date(now.getTime() - 1) } : {},
        {},
        state === "missing" || state === "revoked",
      );
      const nativeResponse = await fixture.auth.api.getSession({
        headers: fixture.request.headers,
        method: "GET",
        query: { disableCookieCache: true, disableRefresh: true },
        asResponse: true,
      });
      if (state === "active") {
        expect(await nativeResponse.json()).toMatchObject({
          session: { id: "read-session" },
        });
        expect(nativeResponse.headers.get("set-cookie")).toBeNull();
      } else {
        expect(await nativeResponse.json()).toBeNull();
        expect(nativeResponse.headers.get("set-cookie")).toContain("Max-Age=0");
      }

      const router = new Hono();
      router.get("/fixture/context", async (context) => {
        const actor = await readAdministrativeSession(context.req.raw, {
          auth: fixture.auth,
          db: fixture.options.db,
          now: () => now,
        });
        return context.json(
          actor ? { actor } : { code: "UNAUTHORIZED" },
          actor ? 200 : 401,
        );
      });
      const response = await router.request(fixture.request);
      expect(response.status).toBe(state === "active" ? 200 : 401);
      if (state === "active") {
        expect(await response.json()).toMatchObject({
          actor: { session: { id: "read-session" } },
        });
      } else {
        expect(await response.json()).toEqual({ code: "UNAUTHORIZED" });
        expect(fixture.db.select).not.toHaveBeenCalled();
      }
      expect(response.headers.get("set-cookie")).toBeNull();
      expectNoPersistentWrites(fixture);
    },
  );

  it.each([
    ["invalid creation", { createdAt: new Date(Number.NaN) }],
    ["invalid expiry", { expiresAt: new Date(Number.NaN) }],
    ["future creation", { createdAt: new Date(now.getTime() + 1) }],
    ["future activity", { lastActiveAt: new Date(now.getTime() + 1) }],
    ["missing identity", { id: undefined }],
  ])("denies native %s evidence without writes", async (_name, overrides) => {
    const fixture = await nativeFixture(overrides);
    await expect(
      readAdministrativeSession(fixture.request, {
        auth: fixture.auth,
        db: fixture.options.db,
        now: () => now,
      }),
    ).resolves.toBeNull();
    expect(fixture.findSession).toHaveBeenCalledExactlyOnceWith(
      "fictional-read-token",
    );
    expectNoPersistentWrites(fixture);
  });

  it("rejects a forged signature before any native or administrative database lookup", async () => {
    const fixture = await nativeFixture();
    const request = new Request(fixture.request.url, {
      headers: {
        Origin: adminOrigin,
        Cookie: `${fixture.context.authCookies.sessionToken.name}=fictional-read-token.invalid-signature`,
      },
    });
    await expect(
      readAdministrativeSession(request, {
        auth: fixture.auth,
        db: fixture.options.db,
        now: () => now,
      }),
    ).resolves.toBeNull();
    expect(fixture.findSession).not.toHaveBeenCalled();
    expect(fixture.db.select).not.toHaveBeenCalled();
    expectNoPersistentWrites(fixture);
  });

  it("rejects requests without a signed session cookie before any database lookup", async () => {
    const fixture = await nativeFixture();
    await expect(
      readAdministrativeSession(
        new Request(fixture.request.url, { headers: { Origin: adminOrigin } }),
        {
          auth: fixture.auth,
          db: fixture.options.db,
          now: () => now,
        },
      ),
    ).resolves.toBeNull();
    expect(fixture.findSession).not.toHaveBeenCalled();
    expect(fixture.db.select).not.toHaveBeenCalled();
    expectNoPersistentWrites(fixture);
  });

  it.each(["PENDING", "DISABLED"])(
    "denies native current %s users without writing",
    async (state) => {
      const fixture = await nativeFixture({}, { state });
      await expect(
        readAdministrativeSession(fixture.request, {
          auth: fixture.auth,
          db: fixture.options.db,
          now: () => now,
        }),
      ).resolves.toBeNull();
      expect(fixture.findSession).toHaveBeenCalledExactlyOnceWith(
        "fictional-read-token",
      );
      expectNoPersistentWrites(fixture);
    },
  );

  it("never accepts cached actor data for a revoked server-side session", async () => {
    const fixture = await nativeFixture({}, {}, true);
    const headers = new Headers(fixture.request.headers);
    headers.set(
      "Cookie",
      `${headers.get("Cookie")}; ${fixture.context.authCookies.sessionData.name}=fictional-cached-admin`,
    );
    await expect(
      readAdministrativeSession(new Request(fixture.request.url, { headers }), {
        auth: fixture.auth,
        db: fixture.options.db,
        now: () => now,
      }),
    ).resolves.toBeNull();
    expect(fixture.findSession).toHaveBeenCalledExactlyOnceWith(
      "fictional-read-token",
    );
    expect(fixture.db.select).not.toHaveBeenCalled();
    expectNoPersistentWrites(fixture);
  });

  it("preserves native expired-session cleanup in the standard instance", async () => {
    const fixture = await nativeFixture();
    const standard = createAuth(fixture.options);
    const context = await standard.$context;
    vi.spyOn(context.internalAdapter, "findSession").mockResolvedValue({
      session: {
        token: "fictional-read-token",
        expiresAt: new Date(now.getTime() - 1),
      },
    } as never);
    const deleteSession = vi
      .spyOn(context.internalAdapter, "deleteSession")
      .mockResolvedValue(undefined);
    await expect(
      standard.api.getSession({
        headers: fixture.request.headers,
        method: "GET",
        query: { disableCookieCache: true, disableRefresh: true },
      }),
    ).resolves.toBeNull();
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(
      "fictional-read-token",
    );
    expect(standard.options.session).not.toHaveProperty("deferSessionRefresh");
    expectNoPersistentWrites(fixture);
  });
});

describe("owner bootstrap", () => {
  it("creates an active OWNER and a credential account in one transaction", async () => {
    const fixture = createBootstrapDatabase();
    const result = await bootstrapOwner(fixture.db, {
      email: "owner@example.test",
      name: "Example Owner",
      password: "correct horse battery staple",
    });

    expect(result.created).toBe(true);
    expect(result.userId).toEqual(expect.any(String));
    expect(fixture.transaction).toHaveBeenCalledOnce();
    expect(fixture.inserted).toHaveLength(2);
    expect(fixture.inserted[0]).toMatchObject({
      email: "owner@example.test",
      role: "OWNER",
      state: "ACTIVE",
      emailVerified: true,
    });
    expect(fixture.inserted[1]).toMatchObject({
      providerId: "credential",
      accountId: result.userId,
    });
    expect(fixture.inserted[1].password).not.toBe(
      "correct horse battery staple",
    );
  });

  it("preserves an existing OWNER without resetting credentials", async () => {
    const fixture = createBootstrapDatabase([
      { id: "existing-owner", role: "OWNER" },
    ]);
    await expect(
      bootstrapOwner(fixture.db, {
        email: "owner@example.test",
        name: "Ignored Name",
        password: "ignored password",
      }),
    ).resolves.toEqual({ created: false, userId: "existing-owner" });
    expect(fixture.inserted).toHaveLength(0);
  });

  it("rejects an existing non-owner email and invalid private input", async () => {
    const duplicate = createBootstrapDatabase([
      { id: "site-admin", role: "SITE_ADMIN" },
    ]);
    await expect(
      bootstrapOwner(duplicate.db, {
        email: "owner@example.test",
        name: "Owner",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow(/non-owner/i);

    const fixture = createBootstrapDatabase();
    await expect(
      bootstrapOwner(fixture.db, { email: "bad", name: "", password: "short" }),
    ).rejects.toThrow();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
});
