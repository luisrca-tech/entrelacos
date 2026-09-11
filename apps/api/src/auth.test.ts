import { describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
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
      role: { input: false },
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
