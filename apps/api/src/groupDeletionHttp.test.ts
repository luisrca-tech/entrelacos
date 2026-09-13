import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  deleteGuestGroup: vi.fn(),
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./guestGroups", () => ({
  GuestGroupServiceError: class GuestGroupServiceError extends Error {},
  createGuestGroup: vi.fn(),
  deleteGuestGroup: mocks.deleteGuestGroup,
  getGuestGroupAccessPin: vi.fn(),
  listGuestGroups: vi.fn(),
  rotateGuestGroupAccessPin: vi.fn(),
  updateGuestGroup: vi.fn(),
}));

import { createGuestGroupsHttpRouter } from "./guestGroupsHttp";

const adminOrigin = "https://admin.example.test";
const db = {} as never;

describe("group deletion HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-1", role: "OWNER" },
    });
    mocks.deleteGuestGroup.mockResolvedValue({ ok: true });
  });

  it("passes strict confirmation JSON to the deletion service", async () => {
    const router = createGuestGroupsHttpRouter({
      auth: {} as never,
      db,
      adminOrigin,
    });
    const response = await router.request(
      new Request("https://api.example.test/v1/sites/site-1/groups/group-1", {
        method: "DELETE",
        headers: {
          Origin: adminOrigin,
          Cookie: "better-auth.session_token=session",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmGroupId: "group-1",
          confirmGroupName: "Família Silva",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteGuestGroup).toHaveBeenCalledWith(
      db,
      { userId: "owner-1", role: "OWNER" },
      "site-1",
      "group-1",
      { confirmGroupId: "group-1", confirmGroupName: "Família Silva" },
      undefined,
    );
  });

  it("rejects missing or extra confirmation fields before service access", async () => {
    const router = createGuestGroupsHttpRouter({
      auth: {} as never,
      db,
      adminOrigin,
    });
    const response = await router.request(
      new Request("https://api.example.test/v1/sites/site-1/groups/group-1", {
        method: "DELETE",
        headers: {
          Origin: adminOrigin,
          Cookie: "better-auth.session_token=session",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmGroupId: "group-1",
          confirmGroupName: "Família Silva",
          extra: true,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.deleteGuestGroup).not.toHaveBeenCalled();
  });
});
