import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerFinanceHttpRouter } from "./ownerFinanceHttp";

const { requireAdminSession, readSummary, listAlerts, resolveAlert } =
  vi.hoisted(() => ({
    requireAdminSession: vi.fn(),
    readSummary: vi.fn(),
    listAlerts: vi.fn(),
    resolveAlert: vi.fn(),
  }));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession,
}));

vi.mock("./ownerFinanceRepository", () => ({
  readOwnerFinanceSummary: readSummary,
  listOwnerFinanceAlerts: listAlerts,
  resolveOwnerFinanceAlert: resolveAlert,
}));

const adminOrigin = "https://admin.example.test";
const session = (role: "OWNER" | "ADMIN") => ({
  user: { id: "u1", name: "U", email: "u@example.test", role },
  session: { id: "s1", expiresAt: new Date("2026-12-01T00:00:00.000Z") },
  siteId: null,
});
const summary = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  grossChargedCents: 10688,
  recipientSplitCents: 10000,
  platformNetCents: 600,
  anticipationCents: 88,
  estimatedCommissionCents: 600,
  commissionDifferenceCents: 0,
  paymentCountsByStatus: { RECEIVED: 1 },
  openAlertCount: 1,
  criticalAlertCount: 1,
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

describe("owner finance HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminSession.mockResolvedValue(session("OWNER"));
    readSummary.mockResolvedValue(summary);
    listAlerts.mockResolvedValue([]);
    resolveAlert.mockResolvedValue(true);
  });

  const routes = [
    ["GET", "/v1/owner/finance/summary"],
    ["GET", "/v1/owner/finance/alerts"],
    ["POST", "/v1/owner/finance/alerts/alert-1/resolve"],
  ] as const;

  it.each(routes)(
    "rejects an untrusted origin on %s %s",
    async (method, path) => {
      const response = await call(path, {
        method,
        origin: "https://evil.example.test",
        body: method === "POST" ? { note: "ok" } : undefined,
      });
      expect(response.status).toBe(403);
      expect(requireAdminSession).not.toHaveBeenCalled();
    },
  );

  it.each(routes)("rejects a non-owner on %s %s", async (method, path) => {
    requireAdminSession.mockResolvedValue(session("ADMIN"));
    const response = await call(path, {
      method,
      body: method === "POST" ? { note: "ok" } : undefined,
    });
    expect(response.status).toBe(403);
    expect(readSummary).not.toHaveBeenCalled();
    expect(listAlerts).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    const { AdminSessionRequiredError } = await import("./authHttp");
    requireAdminSession.mockRejectedValue(new AdminSessionRequiredError());
    const response = await call("/v1/owner/finance/summary");
    expect(response.status).toBe(401);
  });

  it("returns the summary to the owner, forwarding the period", async () => {
    const response = await call(
      "/v1/owner/finance/summary?from=2026-10-01T00:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(summary);
    expect(readSummary).toHaveBeenCalledWith(
      {},
      {
        from: new Date("2026-10-01T00:00:00.000Z"),
        to: undefined,
        now: new Date("2026-11-01T00:00:00.000Z"),
      },
    );
  });

  it("rejects an invalid period", async () => {
    const response = await call("/v1/owner/finance/summary?from=yesterday");
    expect(response.status).toBe(400);
  });

  it("lists open alerts by default", async () => {
    const response = await call("/v1/owner/finance/alerts?status=open");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alerts: [] });
    expect(listAlerts).toHaveBeenCalledWith({}, "open");
  });

  it("resolves an alert with a note", async () => {
    const response = await call("/v1/owner/finance/alerts/alert-1/resolve", {
      method: "POST",
      body: { note: "  Conferido no Asaas  " },
    });
    expect(response.status).toBe(204);
    expect(resolveAlert).toHaveBeenCalledWith(
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
      expect(resolveAlert).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for an unknown or already resolved alert", async () => {
    resolveAlert.mockResolvedValue(false);
    const response = await call("/v1/owner/finance/alerts/missing/resolve", {
      method: "POST",
      body: { note: "ok" },
    });
    expect(response.status).toBe(404);
  });
});
