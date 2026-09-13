import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  readSmsUsage: vi.fn(),
  updateSmsQuota: vi.fn(),
  SmsUsageServiceError: class SmsUsageServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
    }
  },
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));
vi.mock("./smsUsage", () => ({
  SmsUsageServiceError: mocks.SmsUsageServiceError,
  readSmsUsage: mocks.readSmsUsage,
  updateSmsQuota: mocks.updateSmsQuota,
}));

import { createSmsUsageHttpRouter } from "./smsUsageHttp";

const adminOrigin = "https://admin.example.test";
const usage = {
  siteId: "site-1",
  timezone: "America/Sao_Paulo",
  periodStart: "2028-02-01T03:00:00.000Z",
  periodEnd: "2028-03-01T03:00:00.000Z",
  monthlyLimit: 100,
  alert: "BELOW_80",
  realSms: {
    reserved: 0,
    providerAccepted: 1,
    failedFinal: 0,
    unknown: 0,
    consumed: 1,
  },
  simulated: {
    reserved: 0,
    providerAccepted: 2,
    failedFinal: 0,
    unknown: 0,
    consumed: 2,
  },
};

function router() {
  return createSmsUsageHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
    now: () => new Date("2028-02-29T12:00:00.000Z"),
  });
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: { Origin: adminOrigin, ...(init.headers ?? {}) },
  });
}

describe("SMS usage HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-1", role: "OWNER" },
    });
    mocks.readSmsUsage.mockResolvedValue(usage);
    mocks.updateSmsQuota.mockResolvedValue({
      siteId: "site-1",
      monthlyLimit: 100,
    });
  });

  it("returns no-store usage to a site-scoped administrator", async () => {
    const response = await router().request(
      request("/v1/sites/site-1/sms-usage"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(usage);
    expect(mocks.readSmsUsage).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "owner-1", role: "OWNER" },
      "site-1",
      expect.any(Date),
    );
  });

  it("allows only OWNER to update a strict quota body", async () => {
    mocks.requireAdminSession.mockResolvedValueOnce({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    const forbidden = await router().request(
      request("/v1/owner/sites/site-1/sms-quota", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimit: 100 }),
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.updateSmsQuota).not.toHaveBeenCalled();

    const invalid = await router().request(
      request("/v1/owner/sites/site-1/sms-quota", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimit: 100, extra: true }),
      }),
    );
    expect(invalid.status).toBe(400);

    const accepted = await router().request(
      request("/v1/owner/sites/site-1/sms-quota", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimit: 100 }),
      }),
    );
    expect(accepted.status).toBe(200);
  });

  it("rejects foreign origins before authentication", async () => {
    const response = await router().request(
      new Request("https://api.example.test/v1/sites/site-1/sms-usage", {
        headers: { Origin: "https://evil.example.test" },
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
  });
});
