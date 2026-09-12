import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  listGuestGroups: vi.fn(),
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./guestGroups", () => ({
  GuestGroupServiceError: class GuestGroupServiceError extends Error {},
  createGuestGroup: vi.fn(),
  deleteGuestGroup: vi.fn(),
  listGuestGroups: mocks.listGuestGroups,
  updateGuestGroup: vi.fn(),
}));

import { createGuestGroupsHttpRouter } from "./guestGroupsHttp";

const adminOrigin = "https://admin.example.test";

function options() {
  return {
    auth: {} as never,
    db: {} as never,
    adminOrigin,
  };
}

describe("guest groups HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-1", role: "OWNER" },
    });
    mocks.listGuestGroups.mockResolvedValue([]);
  });

  it("does not disguise an authentication dependency failure as a bad session", async () => {
    mocks.requireAdminSession.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await createGuestGroupsHttpRouter(options()).request(
      new Request("https://api.example.test/v1/sites/site-1/groups", {
        headers: { Origin: adminOrigin },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });
});
