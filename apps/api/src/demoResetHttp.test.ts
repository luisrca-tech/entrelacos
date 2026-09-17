import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resetDemoSite: vi.fn(),
}));

vi.mock("./authHttp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authHttp")>()),
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./demoReset", () => ({
  DemoResetServiceError: class DemoResetServiceError extends Error {
    readonly status: number;
    readonly code: string;
    readonly title: string;

    constructor(status: number, code: string, title: string) {
      super(title);
      this.status = status;
      this.code = code;
      this.title = title;
    }
  },
  resetDemoSite: mocks.resetDemoSite,
}));

import { createApp } from "./app";
import { AdminSessionRequiredError } from "./authHttp";
import { createDemoResetHttpRouter } from "./demoResetHttp";

const adminOrigin = "https://admin.example.test";
const db = {} as never;
const resetResponse = {
  siteId: "site-demo",
  datasetVersion: "block7-demo-v1",
  result: "RESET",
  resetAt: "2028-04-01T12:00:00.000Z",
  counts: { groups: 5, members: 10, messages: 1 },
};

function router() {
  return createDemoResetHttpRouter({
    auth: {} as never,
    db,
    adminOrigin,
  });
}

function request(
  path = "/v1/owner/sites/site-demo/demo/reset",
  body: unknown = { datasetVersion: "block7-demo-v1" },
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

describe("demo reset HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-1", role: "OWNER" },
    });
    mocks.resetDemoSite.mockResolvedValue(resetResponse);
  });

  it("resets through the authenticated OWNER route and returns no-store JSON", async () => {
    const response = await router().request(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(resetResponse);
    expect(mocks.resetDemoSite).toHaveBeenCalledWith(
      db,
      { userId: "owner-1", role: "OWNER" },
      "site-demo",
      expect.objectContaining({ clock: expect.any(Object) }),
    );
  });

  it("passes the configured clock without evaluating it before the reset lock", async () => {
    const now = vi.fn(() => new Date("2028-04-01T12:00:00.000Z"));
    const response = await createDemoResetHttpRouter({
      auth: {} as never,
      db,
      adminOrigin,
      now,
    }).request(request());

    expect(response.status).toBe(200);
    const [, , , options] = mocks.resetDemoSite.mock.calls[0] ?? [];
    expect(now).not.toHaveBeenCalled();
    expect(options).toEqual({
      clock: expect.objectContaining({ now: expect.any(Function) }),
    });
    options.clock.now();
    expect(now).toHaveBeenCalledOnce();
  });

  it("rejects malformed, unknown, and wrong-version bodies before service access", async () => {
    for (const body of [
      undefined,
      {},
      { datasetVersion: "block7-demo-v1", extra: true },
      { datasetVersion: "block6-demo-v1" },
      ["block7-demo-v1"],
    ]) {
      const response = await router().request(
        request(
          "/v1/owner/sites/site-demo/demo/reset",
          body,
          body === undefined ? { "Content-Type": "text/plain" } : {},
        ),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
  });

  it("rejects query-string overrides", async () => {
    const response = await router().request(
      request(
        "/v1/owner/sites/site-demo/demo/reset?datasetVersion=block7-demo-v1",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
  });

  it("uses stable authentication and authorization problem shapes", async () => {
    mocks.requireAdminSession.mockRejectedValueOnce(
      new AdminSessionRequiredError(),
    );
    const unauthorized = await router().request(request());
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });

    mocks.requireAdminSession.mockResolvedValueOnce({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    const forbidden = await router().request(request());
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
  });

  it("requires the exact configured admin origin before session access", async () => {
    const response = await router().request(
      request("/v1/owner/sites/site-demo/demo/reset", undefined, {
        Origin: "https://other.example.test",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
  });

  it("maps missing and non-demo targets to the same not-found boundary", async () => {
    const errorClass = (await import("./demoReset")).DemoResetServiceError;
    mocks.resetDemoSite.mockRejectedValue(
      new errorClass(404, "DEMO_SITE_NOT_FOUND", "Demo site was not found"),
    );

    for (const path of [
      "/v1/owner/sites/missing/demo/reset",
      "/v1/owner/sites/sentinel/demo/reset",
    ]) {
      const response = await router().request(request(path));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        type: "about:blank",
        title: "Demo site was not found",
        status: 404,
        code: "DEMO_SITE_NOT_FOUND",
      });
    }
  });

  it("maps reset service errors and unexpected failures without leaking details", async () => {
    const errorClass = (await import("./demoReset")).DemoResetServiceError;
    mocks.resetDemoSite.mockRejectedValueOnce(
      new errorClass(503, "RESET_FAILED", "Demo reset failed"),
    );
    const serviceFailure = await router().request(request());
    expect(serviceFailure.status).toBe(503);
    await expect(serviceFailure.json()).resolves.toEqual({
      type: "about:blank",
      title: "Demo reset failed",
      status: 503,
      code: "RESET_FAILED",
    });

    mocks.resetDemoSite.mockRejectedValueOnce(
      new Error("private database URL and stack details"),
    );
    const unexpectedFailure = await router().request(request());
    expect(unexpectedFailure.status).toBe(503);
    const body = await unexpectedFailure.text();
    expect(body).toContain("SERVICE_UNAVAILABLE");
    expect(body).not.toContain("private database URL");
  });

  it("emits a safe reset event through the composed observability context", async () => {
    const events: unknown[] = [];
    const requestId = "22222222-2222-4222-8222-222222222222";
    const api = createApp(
      {
        auth: {} as never,
        db,
        adminOrigin,
        now: () => new Date("2028-04-01T12:00:00.000Z"),
      },
      {
        id: () => requestId,
        now: () => new Date("2028-04-01T12:00:00.000Z"),
        sink: (event) => events.push(event),
      },
    );

    const response = await api.request(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "demo.reset",
          requestId,
          routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
          method: "POST",
          status: 200,
          operation: "demo_reset",
          result: "success",
          siteId: "site-demo",
          actorRole: "OWNER",
          mode: "manual",
          datasetVersion: "block7-demo-v1",
          count: 16,
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("cookie");
  });
});
