import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminAccessHttpRouter } from "./adminAccessHttp";

const {
  requireAdminSession,
  issueAdminAccess,
  revokeAdminAccess,
  disableAdmin,
  consumeAdminAccess,
} = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  issueAdminAccess: vi.fn(),
  revokeAdminAccess: vi.fn(),
  disableAdmin: vi.fn(),
  consumeAdminAccess: vi.fn(),
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession,
}));

vi.mock("./adminAccess", () => ({
  AdminAccessRejectedError: class AdminAccessRejectedError extends Error {},
  issueAdminAccess,
  revokeAdminAccess,
  disableAdmin,
  consumeAdminAccess,
}));

const adminOrigin = "https://admin.example.test";
const owner = {
  user: {
    id: "owner-1",
    name: "Owner",
    email: "owner@example.test",
    role: "OWNER" as const,
  },
  session: {
    id: "owner-session",
    expiresAt: new Date("2026-09-18T00:00:00.000Z"),
  },
  siteId: null,
};

function options() {
  return {
    auth: {} as never,
    db: {} as never,
    adminOrigin,
  };
}

function request(
  path: string,
  body: unknown,
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

describe("admin access HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminSession.mockResolvedValue(owner);
    issueAdminAccess.mockResolvedValue({
      userId: "admin-1",
      siteId: "site-1",
      purpose: "ACTIVATION",
      token: "a".repeat(43),
      expiresAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    consumeAdminAccess.mockResolvedValue({
      userId: "admin-1",
      siteId: "site-1",
      email: "admin@example.test",
      purpose: "ACTIVATION",
    });
  });

  it("requires owner session and exact trusted origin for owner access routes", async () => {
    const router = createAdminAccessHttpRouter(options());
    const wrongOrigin = await router.request(
      request(
        "/v1/owner/admins/admin-1/access",
        { userId: "admin-1", purpose: "ACTIVATION" },
        { Origin: "https://evil.example.test" },
      ),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(requireAdminSession).not.toHaveBeenCalled();

    requireAdminSession.mockResolvedValue({
      ...owner,
      user: { ...owner.user, role: "SITE_ADMIN" },
      siteId: "site-1",
    });
    const tenant = await router.request(
      request("/v1/owner/admins/admin-1/access", {
        userId: "admin-1",
        purpose: "ACTIVATION",
      }),
    );
    expect(tenant.status).toBe(403);
    expect(issueAdminAccess).not.toHaveBeenCalled();
  });

  it("uses one purpose-aware route and requires path/body user identity", async () => {
    const router = createAdminAccessHttpRouter(options());
    const mismatch = await router.request(
      request("/v1/owner/admins/admin-1/access", {
        userId: "admin-2",
        purpose: "ACTIVATION",
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(issueAdminAccess).not.toHaveBeenCalled();

    const recovery = await router.request(
      request("/v1/owner/admins/admin-1/access", {
        userId: "admin-1",
        purpose: "RECOVERY",
      }),
    );
    expect(recovery.status).toBe(200);
    expect(issueAdminAccess).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      purpose: "RECOVERY",
    });
  });

  it("binds public consume URL to its purpose and never returns a session", async () => {
    const router = createAdminAccessHttpRouter(options());
    const activation = await router.request(
      request("/v1/auth/activation/consume", {
        token: "a".repeat(43),
        password: "password10",
      }),
    );
    expect(activation.status).toBe(200);
    expect(await activation.json()).toEqual({
      userId: "admin-1",
      siteId: "site-1",
      email: "admin@example.test",
      purpose: "ACTIVATION",
      requiresExplicitLogin: true,
    });
    expect(consumeAdminAccess).toHaveBeenCalledWith(expect.anything(), {
      token: "a".repeat(43),
      password: "password10",
      purpose: "ACTIVATION",
    });
    expect((await activation.headers.get("set-cookie")) ?? "").toBe("");

    consumeAdminAccess.mockResolvedValueOnce({
      userId: "admin-1",
      siteId: "site-1",
      email: "admin@example.test",
      purpose: "RECOVERY",
    });
    const recovery = await router.request(
      request("/v1/auth/recovery/consume", {
        token: "a".repeat(43),
        password: "password10",
      }),
    );
    expect(recovery.status).toBe(200);
    expect(consumeAdminAccess).toHaveBeenLastCalledWith(expect.anything(), {
      token: "a".repeat(43),
      password: "password10",
      purpose: "RECOVERY",
    });
  });
});
