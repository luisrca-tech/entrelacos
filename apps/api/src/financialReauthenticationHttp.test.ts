import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resolveSiteAccess: vi.fn(),
  AdminSessionRequiredError: class extends Error {},
}));
vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
  AdminSessionRequiredError: mocks.AdminSessionRequiredError,
}));
vi.mock("./siteAccess", () => ({ resolveSiteAccess: mocks.resolveSiteAccess }));

import { FinancialReauthenticationError } from "./financialReauthentication";
import { createFinancialReauthenticationHttpRouter } from "./financialReauthenticationHttp";

const origin = "https://admin.example.test";
const token = `fr1.${"a".repeat(80)}.${"b".repeat(43)}`;
const access = {
  siteId: "site-one",
  userId: "admin-one",
  membershipId: "membership-one",
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
};
function fixture(enabled = true) {
  const authenticate = vi.fn().mockResolvedValue({
    reauthenticationToken: token,
    expiresAt: "2026-10-12T18:02:00.000Z",
  });
  return {
    authenticate,
    router: createFinancialReauthenticationHttpRouter({
      auth: {} as never,
      db: {} as never,
      adminOrigin: origin,
      financialReauthentication: enabled
        ? { authenticate, readProof: vi.fn() }
        : undefined,
    }),
  };
}
function request(
  body: unknown = {
    action: "REQUEST_WITHDRAWAL",
    password: "test-only-password",
  },
  settings: { origin?: string; query?: string; mime?: string } = {},
) {
  return new Request(
    `https://api.example.test/v1/sites/site-one/financial-reauthentication${settings.query ?? ""}`,
    {
      method: "POST",
      headers: {
        Origin: settings.origin ?? origin,
        "Content-Type": settings.mime ?? "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdminSession.mockResolvedValue({
    user: { id: "admin-one", role: "SITE_ADMIN" },
    session: { id: "session-one" },
  });
  mocks.resolveSiteAccess.mockResolvedValue(access);
});
describe("financial reauthentication HTTP boundary", () => {
  it("binds verification to the backend actor and returns body-only proof", async () => {
    const v = fixture();
    const response = await v.router.request(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reauthenticationToken: token,
      expiresAt: "2026-10-12T18:02:00.000Z",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.authenticate).toHaveBeenCalledExactlyOnceWith(
      { userId: "admin-one", siteId: "site-one", sessionId: "session-one" },
      "REQUEST_WITHDRAWAL",
      "test-only-password",
    );
  });
  it("defaults to unavailable without any verifier or provider", async () => {
    const v = fixture(false);
    expect((await v.router.request(request())).status).toBe(409);
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it("rejects origin before sessions or password processing", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request(undefined, { origin: "https://attacker.test" }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it("requires an active session before body parsing", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    const attempted = request("{private malformed");
    expect((await v.router.request(attempted)).status).toBe(401);
    expect(attempted.bodyUsed).toBe(false);
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...access, userId: "another-user" },
    { ...access, siteId: "another-site" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipId: null },
  ])("denies incorrect current membership %j", async (candidate) => {
    const v = fixture();
    mocks.resolveSiteAccess.mockResolvedValue(candidate);
    expect((await v.router.request(request())).status).toBe(403);
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it.each(["CONFIGURE_RECEIVING", "REQUEST_WITHDRAWAL"])(
    "requires the current capability for %s",
    async (action) => {
      const v = fixture();
      mocks.resolveSiteAccess.mockResolvedValue({
        ...access,
        capabilities: {
          ...access.capabilities,
          configureReceiving: false,
          readFinance: false,
        },
      });
      expect(
        (
          await v.router.request(
            request({ action, password: "test-only-password" }),
          )
        ).status,
      ).toBe(403);
      expect(v.authenticate).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      action: "REQUEST_WITHDRAWAL",
      password: "test-only-password",
      sessionId: "other",
    },
    {
      action: "REQUEST_WITHDRAWAL",
      password: "test-only-password",
      verified: true,
    },
    { action: "OTHER", password: "test-only-password" },
    { action: "REQUEST_WITHDRAWAL", password: "" },
    "{broken",
  ])("rejects invalid or client-authority payload %j", async (body) => {
    const v = fixture();
    expect((await v.router.request(request(body))).status).toBe(400);
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed input and query capabilities", async () => {
    const v = fixture();
    expect((await v.router.request(request("x".repeat(4097)))).status).toBe(
      400,
    );
    expect(
      (
        await v.router.request(
          request(undefined, { query: "?password=private" }),
        )
      ).status,
    ).toBe(400);
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it.each([
    "text/plain",
    "application/json-bad",
    "application/json; charset=latin1",
  ])("rejects unsafe MIME %s", async (mime) => {
    const v = fixture();
    expect((await v.router.request(request(undefined, { mime }))).status).toBe(
      400,
    );
    expect(v.authenticate).not.toHaveBeenCalled();
  });
  it.each([
    { reauthenticationToken: token, expiresAt: "invalid" },
    {
      reauthenticationToken: token,
      expiresAt: "2026-10-12T18:02:00.000Z",
      password: "private",
    },
  ])("rejects invalid service output %j", async (output) => {
    const v = fixture();
    v.authenticate.mockResolvedValue(output);
    const response = await v.router.request(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
  it.each([
    new FinancialReauthenticationError(403, "RECENT_AUTH_REQUIRED"),
    new FinancialReauthenticationError(429, "REAUTHENTICATION_RATE_LIMITED"),
    new Error("private-password"),
  ])("sanitizes service failures %j", async (error) => {
    const v = fixture();
    v.authenticate.mockRejectedValue(error);
    const response = await v.router.request(request());
    expect(response.status).toBe(
      error instanceof FinancialReauthenticationError ? error.status : 503,
    );
    expect(await response.text()).not.toContain("private-password");
  });
});
