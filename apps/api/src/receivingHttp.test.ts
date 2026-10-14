import { receivingReadinessResponseSchema } from "@entrelacos/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resolveSiteAccess: vi.fn(),
}));
vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));
vi.mock("./siteAccess", () => ({ resolveSiteAccess: mocks.resolveSiteAccess }));

import { createReceivingHttpRouter } from "./receivingHttp";

const adminOrigin = "https://admin.example.test";
function router() {
  return createReceivingHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
  });
}
function request(
  path = "/v1/sites/wedding-a/receiving/readiness",
  origin = adminOrigin,
) {
  return new Request(`https://api.example.test${path}`, {
    headers: { Origin: origin },
  });
}

describe("receiving HTTP lock", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "helper-a", role: "SITE_ASSISTANT" },
    });
    mocks.resolveSiteAccess.mockResolvedValue({
      siteId: "wedding-a",
      userId: "helper-a",
    });
  });

  it("serves only the safe default-deny projection to an authorized site member", async () => {
    const response = await router().request(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parsed = receivingReadinessResponseSchema.parse(
      await response.json(),
    );
    expect(parsed.readiness).toEqual({
      siteId: "wedding-a",
      state: "NOT_CONFIGURED",
      reason: "NOT_CONFIGURED",
      observedAt: null,
      destinationVersion: null,
      catalogEligible: false,
      mode: "disabled",
    });
    expect(mocks.resolveSiteAccess).toHaveBeenCalledWith(expect.anything(), {
      siteId: "wedding-a",
      userId: "helper-a",
      platformRole: "SITE_ASSISTANT",
    });
  });

  it("consumes only an authorized server reader and rejects cross-site or private projections", async () => {
    const readiness = {
      siteId: "wedding-a",
      state: "READY" as const,
      reason: null,
      observedAt: "2026-10-12T12:00:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "sandbox" as const,
    };
    const readReadiness = vi.fn().mockResolvedValue(readiness);
    const api = createReceivingHttpRouter({
      auth: {} as never,
      db: {} as never,
      adminOrigin,
      readReadiness,
    });
    const response = await api.request(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ readiness });
    expect(readReadiness).toHaveBeenCalledWith("wedding-a");
    for (const invalid of [
      { ...readiness, siteId: "foreign" },
      { ...readiness, walletId: "private" },
    ]) {
      readReadiness.mockResolvedValue(invalid);
      expect((await api.request(request())).status).toBe(503);
    }
    mocks.resolveSiteAccess.mockResolvedValue(null);
    readReadiness.mockClear();
    expect((await api.request(request())).status).toBe(403);
    expect(readReadiness).not.toHaveBeenCalled();
  });

  it("does not accept query or header claims as receiving evidence", async () => {
    const response = await router().request(
      request(
        "/v1/sites/wedding-a/receiving/readiness?state=READY&catalogEligible=true&walletId=other",
      ),
    );
    expect((await response.json()).readiness.catalogEligible).toBe(false);
  });

  it("denies anonymous, foreign-origin, revoked and cross-site access", async () => {
    expect(
      (
        await router().request(
          request(undefined, "https://attacker.example.test"),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    mocks.requireAdminSession.mockRejectedValueOnce(new Error("No session"));
    expect((await router().request(request())).status).toBe(401);
    mocks.resolveSiteAccess.mockResolvedValueOnce(null);
    const denied = await router().request(
      request("/v1/sites/wedding-b/receiving/readiness"),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("MEMBERSHIP_DENIED");
  });

  it("fails closed on storage outage without revealing provider data", async () => {
    mocks.resolveSiteAccess.mockRejectedValueOnce(
      new Error("private credential detail"),
    );
    const response = await router().request(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private credential detail");
  });
});
