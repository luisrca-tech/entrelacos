import { createHmac } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionReadAuth } from "./auth";
import type { GiftPaymentHistoryRepository } from "./giftPaymentHistory";

const instant = new Date("2026-10-13T14:00:00.000Z");
const origin = "https://admin.example.test";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const session = {
    id: "session-one",
    userId: "viewer-one",
    token: "fictional-history-session",
    createdAt: new Date(instant.getTime() - 60000),
    updatedAt: new Date(instant.getTime() - 60000),
    lastActiveAt: new Date(instant.getTime() - 60000),
    expiresAt: new Date(instant.getTime() + 3600000),
    ipAddress: null,
    userAgent: null,
  };
  const user = {
    id: "viewer-one",
    name: "Fictional Admin",
    email: "fictional@example.test",
    role: "SITE_ADMIN",
    state: "ACTIVE",
    emailVerified: true,
    image: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  const membership = {
    user_id: "viewer-one",
    account_role: "SITE_ADMIN",
    account_state: "ACTIVE",
    site_id: "site-one",
    membership_id: "membership-one",
    membership_user_id: "viewer-one",
    membership_role: "SITE_ADMIN",
    revoked_at: null as string | null,
  };
  const state = { missing: false };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                sessionId: session.id,
                userId: session.userId,
                sessionCreatedAt: session.createdAt,
                sessionExpiresAt: session.expiresAt,
                lastActiveAt: session.lastActiveAt,
                userName: user.name,
                userEmail: user.email,
                userRole: user.role,
                userState: user.state,
              },
            ],
          }),
        }),
      }),
    })),
    execute: vi.fn(async (value) => {
      expect(new PgDialect().sqlToQuery(value).sql).toMatch(/SELECT/);
      return {
        rows:
          membership.revoked_at === null
            ? [
                {
                  ...membership,
                  account_role: user.role,
                  account_state: user.state,
                },
              ]
            : [],
      };
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const secret = "fictional-history-cookie-secret-32-only";
  const auth = createSessionReadAuth({
    db: db as never,
    secret,
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  });
  const context = await auth.$context;
  const native = vi
    .spyOn(context.internalAdapter, "findSession")
    .mockImplementation(async () =>
      state.missing
        ? null
        : ({
            session: structuredClone(session),
            user: structuredClone(user),
          } as never),
    );
  const deletes = vi
    .spyOn(context.internalAdapter, "deleteSession")
    .mockResolvedValue(undefined);
  const signature = createHmac("sha256", secret)
    .update(session.token)
    .digest("base64");
  const request = () =>
    new Request("https://api.example.test/history", {
      headers: {
        origin,
        cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
      },
    });
  const scope = {
    siteId: "site-one",
    mode: "sandbox" as const,
    policy: "SITE_HISTORY" as const,
  };
  const page = {
    history: {
      scope,
      consistency: "PER_READ" as const,
      readObservedAtMicros: "1791900000000000",
      currentKnowledge: "UNKNOWN" as const,
      sourceOrdering: "UNAVAILABLE" as const,
      items: [],
      nextCursor: null,
    },
  };
  const repository = {
    database: db,
    mode: "sandbox",
    applicationEnvironment: "test",
    policy: "SITE_HISTORY",
    readPurchasePage: vi.fn<GiftPaymentHistoryRepository["readPurchasePage"]>(
      async () => page,
    ),
    readPurchaseDetailPage: vi.fn(async () => {
      throw new Error("fictional-not-installed");
    }),
    close: vi.fn(async () => {}),
  };
  const options = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policy: "SITE_HISTORY" as const,
    adminOrigin: origin,
    now: () => new Date(instant),
    authentication: { auth, db },
    repository,
  };
  const module = await import("./giftPaymentHistory");
  const service = module.createGiftPaymentHistory(options as never);
  return {
    module,
    service,
    options,
    db,
    native,
    deletes,
    request,
    membership,
    session,
    user,
    state,
    repository,
    page,
  };
}
describe("native owned private purchase history service", () => {
  it("retains signed session ownership while admitting another localhost port in development", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "development");
    const v = await fixture();
    expect(v.service.available).toBe(true);
    const request = v.request();
    request.headers.set("origin", "http://localhost:3001");
    const owner = v.service.readPurchasePage({ request, siteId: "site-one" });
    await expect(owner.result).resolves.toEqual(v.page);
    await owner.completion;
    expect(v.native).toHaveBeenCalledTimes(2);
    for (const write of [v.db.insert, v.db.update, v.db.delete, v.deletes]) {
      expect(write).not.toHaveBeenCalled();
    }
    await v.service.close();
  });
  it("reads for a freshly verified OWNER without fabricating a site membership", async () => {
    const v = await fixture();
    v.user.role = "OWNER";
    Object.assign(v.membership, {
      membership_id: null,
      membership_user_id: null,
      membership_role: null,
    });
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await expect(owner.result).resolves.toEqual(v.page);
    await owner.completion;
    expect(v.repository.readPurchasePage.mock.calls[0]?.[0]).toMatchObject({
      membershipId: null,
      userId: "viewer-one",
      siteId: "site-one",
    });
    expect(v.db.update).not.toHaveBeenCalled();
    await v.service.close();
  });
  it("uses actual signed native session and fresh memberships before and after a stored read", async () => {
    const v = await fixture();
    expect(v.service.available).toBe(true);
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    expect(await owner.result).toEqual(v.page);
    await owner.completion;
    expect(v.native).toHaveBeenCalledTimes(2);
    expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1);
    expect(v.repository.readPurchasePage.mock.calls[0]?.[0]).toMatchObject({
      siteId: "site-one",
      mode: "sandbox",
      policy: "SITE_HISTORY",
      userId: "viewer-one",
      sessionId: "session-one",
      membershipId: "membership-one",
    });
    for (const write of [v.db.insert, v.db.update, v.db.delete, v.deletes])
      expect(write).not.toHaveBeenCalled();
    await v.service.close();
  });
  it.each([
    "cookie",
    "origin",
    "role",
    "membership",
    "state",
    "session",
    "expiry",
    "idle",
    "absolute",
    "site",
  ] as const)(
    "denies current %s without invoking the stored reader",
    async (fault) => {
      const v = await fixture();
      const request = v.request();
      if (fault === "cookie")
        request.headers.set("cookie", "better-auth.session_token=unsigned");
      if (fault === "origin")
        request.headers.set("origin", "https://foreign.example.test");
      if (fault === "role") v.user.role = "SITE_ASSISTANT";
      if (fault === "membership")
        v.membership.revoked_at = "2026-10-13T13:59:00Z";
      if (fault === "state") v.user.state = "DISABLED";
      if (fault === "session") v.state.missing = true;
      if (fault === "expiry") v.session.expiresAt = new Date(instant);
      if (fault === "idle")
        v.session.lastActiveAt = new Date(instant.getTime() - 86400000);
      if (fault === "absolute")
        v.session.createdAt = new Date(instant.getTime() - 7 * 86400000);
      const owner = v.service.readPurchasePage({
        request,
        siteId: fault === "site" ? "foreign-site" : "site-one",
      });
      await expect(owner.result).rejects.toThrow(
        "Purchase history unavailable",
      );
      await owner.completion;
      expect(v.repository.readPurchasePage).not.toHaveBeenCalled();
      await v.service.close();
    },
  );
  it("current membership revocation during the actual stored read suppresses its late private reply", async () => {
    const v = await fixture();
    const pending = deferred<typeof v.page>();
    v.repository.readPurchasePage.mockImplementation(() => pending.promise);
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await vi.waitFor(() =>
      expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1),
    );
    v.membership.revoked_at = "2026-10-13T13:59:00Z";
    pending.resolve(v.page);
    await expect(owner.result).rejects.toThrow("Purchase history unavailable");
    await owner.completion;
    await v.service.close();
  });
  it("a changed genuine native session at settlement cannot adopt the original private read", async () => {
    const v = await fixture();
    v.repository.readPurchasePage.mockImplementation(async () => {
      v.session.id = "session-replaced";
      return v.page;
    });
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await expect(owner.result).rejects.toThrow("Purchase history unavailable");
    await owner.completion;
    await v.service.close();
  });
  it("close and cancellation await the actual pending reader before closing its port", async () => {
    const v = await fixture();
    const pending = deferred<typeof v.page>();
    v.repository.readPurchasePage.mockImplementation(() => pending.promise);
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await vi.waitFor(() =>
      expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1),
    );
    owner.cancel();
    let completed = false;
    const close = v.service.close().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(v.repository.close).not.toHaveBeenCalled();
    pending.resolve(v.page);
    await expect(owner.result).rejects.toThrow("Purchase history unavailable");
    await owner.completion;
    await close;
    expect(v.repository.close).toHaveBeenCalledTimes(1);
  });
  it("close owns a pending actual native settlement confirmation", async () => {
    const v = await fixture();
    const confirmation = deferred<null>();
    const original = v.native.getMockImplementation();
    let calls = 0;
    v.native.mockImplementation(async (token) => {
      if (++calls === 2) await confirmation.promise;
      return original ? original(token) : null;
    });
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await vi.waitFor(() => expect(v.native).toHaveBeenCalledTimes(2));
    let completed = false;
    void owner.completion.then(() => {
      completed = true;
    });
    const close = v.service.close();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(v.repository.close).not.toHaveBeenCalled();
    confirmation.resolve(null);
    await expect(owner.result).rejects.toThrow("Purchase history unavailable");
    await owner.completion;
    await close;
    expect(v.repository.close).toHaveBeenCalledTimes(1);
  });
  it("captures the stored normalized reply before pending native confirmation", async () => {
    const v = await fixture();
    const confirmation = deferred<null>();
    const original = v.native.getMockImplementation();
    let calls = 0;
    v.native.mockImplementation(async (token) => {
      if (++calls === 2) await confirmation.promise;
      return original ? original(token) : null;
    });
    const owner = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await vi.waitFor(() => expect(v.native).toHaveBeenCalledTimes(2));
    v.page.history.readObservedAtMicros = "1791900000000001";
    confirmation.resolve(null);
    const reply = await owner.result;
    expect(reply.history.readObservedAtMicros).toBe("1791900000000000");
    expect(Object.isFrozen(reply.history)).toBe(true);
    await owner.completion;
    await v.service.close();
  });
  it("configuration mismatch and disabled mode remain unavailable before native admission", async () => {
    const v = await fixture();
    const wrong = v.module.createGiftPaymentHistory({
      ...v.options,
      mode: "live",
    } as never);
    const owner = wrong.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await expect(owner.result).rejects.toThrow("Purchase history unavailable");
    await owner.completion;
    expect(v.native).not.toHaveBeenCalled();
    const disabled = v.module.createGiftPaymentHistory({
      mode: "disabled",
      get authentication() {
        throw new Error("private getter must remain untouched");
      },
    } as never);
    expect(disabled.available).toBe(false);
    await disabled.close();
    await v.service.close();
  });
  it("captures the original request headers before an await and cannot leak a private repository cause", async () => {
    const v = await fixture();
    const request = v.request();
    const owner = v.service.readPurchasePage({ request, siteId: "site-one" });
    request.headers.set("cookie", "changed");
    expect(await owner.result).toEqual(v.page);
    await owner.completion;
    v.repository.readPurchasePage.mockRejectedValueOnce(
      new Error("private-bank-and-secret"),
    );
    const failed = v.service.readPurchasePage({
      request: v.request(),
      siteId: "site-one",
    });
    await expect(failed.result).rejects.toMatchObject({
      message: "Purchase history unavailable",
    });
    await expect(failed.result).rejects.not.toHaveProperty("cause");
    await failed.completion;
    await v.service.close();
  });
});
