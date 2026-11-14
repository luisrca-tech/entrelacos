import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerFinanceHttpRouter } from "./ownerFinanceHttp";

const repository = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  readOwnerFinanceSummary: vi.fn(),
  listOwnerFinanceGifts: vi.fn(),
  listOwnerFinanceSites: vi.fn(),
  listOwnerFinanceAlerts: vi.fn(),
  resolveOwnerFinanceAlert: vi.fn(),
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: repository.requireAdminSession,
}));

vi.mock("./ownerFinanceRepository", () => ({
  readOwnerFinanceSummary: repository.readOwnerFinanceSummary,
  listOwnerFinanceGifts: repository.listOwnerFinanceGifts,
  listOwnerFinanceSites: repository.listOwnerFinanceSites,
  listOwnerFinanceAlerts: repository.listOwnerFinanceAlerts,
  resolveOwnerFinanceAlert: repository.resolveOwnerFinanceAlert,
}));

const adminOrigin = "https://admin.example.test";
const session = (role: "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT") => ({
  user: { id: "u1", name: "U", email: "u@example.test", role },
  session: { id: "s1", expiresAt: new Date("2026-12-01T00:00:00.000Z") },
  siteId: null,
  memberships: [],
});
const summary = {
  giftCount: 1,
  grossChargedCents: 10688,
  coupleCreditedCents: 10000,
  estimatedCommissionCents: 200,
  netCommissionCents: 200,
  commissionDifferenceCents: 0,
};
const gift = {
  orderId: "order-1",
  siteId: "site-1",
  siteName: "Ana & Bia",
  environment: "sandbox",
  paidAt: "2026-10-10T12:00:00.000Z",
  giftTitle: "Jantar",
  method: "CREDIT_CARD",
  installmentCount: 3,
  grossCents: 10688,
  coupleCreditedCents: 3334,
  coupleExpectedCents: 10000,
  creditedInstallments: 1,
  estimatedCommissionCents: 200,
  netCommissionCents: 120,
  status: "PARTIALLY_RECEIVED",
};

function router() {
  return createOwnerFinanceHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
    now: () => new Date("2026-11-01T00:00:00.000Z"),
  });
}

function call(
  path: string,
  init: { method?: string; origin?: string | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init.origin !== null) headers.Origin = init.origin ?? adminOrigin;
  return router().request(`https://api.example.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const routes = [
  ["GET", "/v1/owner/finance/summary"],
  ["GET", "/v1/owner/finance/gifts"],
  ["GET", "/v1/owner/finance/sites"],
  ["GET", "/v1/owner/finance/alerts"],
  ["POST", "/v1/owner/finance/alerts/alert-1/resolve"],
] as const;

function expectNoRepositoryCall() {
  for (const reader of [
    repository.readOwnerFinanceSummary,
    repository.listOwnerFinanceGifts,
    repository.listOwnerFinanceSites,
    repository.listOwnerFinanceAlerts,
    repository.resolveOwnerFinanceAlert,
  ])
    expect(reader).not.toHaveBeenCalled();
}

describe("owner finance HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.requireAdminSession.mockResolvedValue(session("OWNER"));
    repository.readOwnerFinanceSummary.mockResolvedValue(summary);
    repository.listOwnerFinanceGifts.mockResolvedValue({
      gifts: [gift],
      nextCursor: null,
    });
    repository.listOwnerFinanceSites.mockResolvedValue({
      sites: [{ id: "site-1", name: "Ana & Bia" }],
    });
    repository.listOwnerFinanceAlerts.mockResolvedValue({
      alerts: [],
      nextCursor: null,
      openCount: 0,
      criticalOpenCount: 0,
    });
    repository.resolveOwnerFinanceAlert.mockResolvedValue(true);
  });

  it.each(routes)(
    "rejects an untrusted origin on %s %s",
    async (method, path) => {
      const response = await call(path, {
        method,
        origin: "https://evil.example.test",
        body: method === "POST" ? { note: "ok" } : undefined,
      });
      expect(response.status).toBe(403);
      expect(repository.requireAdminSession).not.toHaveBeenCalled();
      expectNoRepositoryCall();
    },
  );

  describe.each(["SITE_ADMIN", "SITE_ASSISTANT"] as const)(
    "non-owner %s",
    (role) => {
      it.each(routes)(
        "is forbidden (403) on every owner finance endpoint: %s %s",
        async (method, path) => {
          repository.requireAdminSession.mockResolvedValue(session(role));
          const response = await call(path, {
            method,
            body: method === "POST" ? { note: "ok" } : undefined,
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
          expectNoRepositoryCall();
        },
      );
    },
  );

  it.each(routes)(
    "answers 401 without a session: %s %s",
    async (method, path) => {
      const { AdminSessionRequiredError } = await import("./authHttp");
      repository.requireAdminSession.mockRejectedValue(
        new AdminSessionRequiredError(),
      );
      const response = await call(path, {
        method,
        body: method === "POST" ? { note: "ok" } : undefined,
      });
      expect(response.status).toBe(401);
      expectNoRepositoryCall();
    },
  );

  it("returns totals for the filtered gifts", async () => {
    const response = await call(
      "/v1/owner/finance/summary?siteId=site-1&siteId=site-2&from=2026-10-01T00:00:00.000Z&to=2026-10-31T23:59:59.999Z&method=PIX&status=RECEIVED&environment=live",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(summary);
    expect(repository.readOwnerFinanceSummary).toHaveBeenCalledWith(
      {},
      {
        siteId: ["site-1", "site-2"],
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-31T23:59:59.999Z",
        method: "PIX",
        status: "RECEIVED",
        environment: "live",
      },
    );
  });

  it("lists paid gifts with a default page size and forwards the cursor", async () => {
    const response = await call(
      "/v1/owner/finance/gifts?siteId=site-1&cursor=1760097600000000_order-9",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gifts: [gift], nextCursor: null });
    expect(repository.listOwnerFinanceGifts).toHaveBeenCalledWith(
      {},
      { siteId: ["site-1"], cursor: "1760097600000000_order-9", limit: 50 },
    );
  });

  it.each([
    "from=yesterday",
    "from=2026-10-31T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    "method=BOLETO",
    "status=PAID",
    "environment=prod",
    "limit=0",
    "limit=101",
    "cursor=not-a-cursor",
    "siteId=",
    "method=PIX&method=CREDIT_CARD",
    "unknown=1",
  ])("rejects an invalid gift query: %s", async (query) => {
    const response = await call(`/v1/owner/finance/gifts?${query}`);
    expect(response.status).toBe(400);
    expect(repository.listOwnerFinanceGifts).not.toHaveBeenCalled();
  });

  it("rejects an invalid summary period", async () => {
    const response = await call("/v1/owner/finance/summary?from=yesterday");
    expect(response.status).toBe(400);
    expect(repository.readOwnerFinanceSummary).not.toHaveBeenCalled();
  });

  it("lists sites for the filter", async () => {
    const response = await call("/v1/owner/finance/sites");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sites: [{ id: "site-1", name: "Ana & Bia" }],
    });
  });

  it("lists open alerts by default and filters by site", async () => {
    const response = await call(
      "/v1/owner/finance/alerts?siteId=site-1&limit=10",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alerts: [],
      nextCursor: null,
      openCount: 0,
      criticalOpenCount: 0,
    });
    expect(repository.listOwnerFinanceAlerts).toHaveBeenCalledWith(
      {},
      { status: "open", siteId: ["site-1"], limit: 10 },
    );
  });

  it("rejects an unknown alert status", async () => {
    const response = await call("/v1/owner/finance/alerts?status=pending");
    expect(response.status).toBe(400);
  });

  it("resolves an alert with a note", async () => {
    const response = await call("/v1/owner/finance/alerts/alert-1/resolve", {
      method: "POST",
      body: { note: "  Conferido no Asaas  " },
    });
    expect(response.status).toBe(204);
    expect(repository.resolveOwnerFinanceAlert).toHaveBeenCalledWith(
      {},
      {
        id: "alert-1",
        note: "Conferido no Asaas",
        now: new Date("2026-11-01T00:00:00.000Z"),
      },
    );
  });

  it.each([{}, { note: "" }, { note: "   " }, { note: "x".repeat(501) }])(
    "requires a valid resolution note: %j",
    async (body) => {
      const response = await call("/v1/owner/finance/alerts/alert-1/resolve", {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
      expect(repository.resolveOwnerFinanceAlert).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for an unknown or already resolved alert", async () => {
    repository.resolveOwnerFinanceAlert.mockResolvedValue(false);
    const response = await call("/v1/owner/finance/alerts/missing/resolve", {
      method: "POST",
      body: { note: "ok" },
    });
    expect(response.status).toBe(404);
  });
});
