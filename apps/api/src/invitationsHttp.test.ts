import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  listInvitations: vi.fn(),
  createInvitation: vi.fn(),
  updateInvitation: vi.fn(),
  deleteInvitation: vi.fn(),
  getInvitationAccessPin: vi.fn(),
  rotateInvitationAccessPin: vi.fn(),
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./invitations", () => ({
  InvitationServiceError: class InvitationServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
    }
  },
  createInvitation: mocks.createInvitation,
  deleteInvitation: mocks.deleteInvitation,
  getInvitationAccessPin: mocks.getInvitationAccessPin,
  listInvitations: mocks.listInvitations,
  rotateInvitationAccessPin: mocks.rotateInvitationAccessPin,
  updateInvitation: mocks.updateInvitation,
}));

import { createInvitationsHttpRouter } from "./invitationsHttp";

const adminOrigin = "https://admin.example.test";
const invitation = {
  id: "invitation-1",
  siteId: "site-1",
  name: "Família Silva",
  phone: "+5511999999999",
  email: null,
  guests: [
    {
      id: "guest-1",
      fullName: "Ana Silva",
      guestType: "ADULT",
      rsvpState: "PENDING",
      rsvpRevision: 0,
    },
  ],
  createdAt: "2028-01-01T00:00:00.000Z",
  updatedAt: "2028-01-01T00:00:00.000Z",
};

function options() {
  return { auth: {} as never, db: {} as never, adminOrigin };
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", adminOrigin);
  return new Request(`https://api.example.test${path}`, { ...init, headers });
}

describe("invitations HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-1", role: "OWNER" },
    });
    mocks.listInvitations.mockResolvedValue([invitation]);
    mocks.createInvitation.mockResolvedValue(invitation);
    mocks.updateInvitation.mockResolvedValue(invitation);
    mocks.deleteInvitation.mockResolvedValue({ ok: true });
    mocks.getInvitationAccessPin.mockResolvedValue({ accessPin: "123456" });
    mocks.rotateInvitationAccessPin.mockResolvedValue({ accessPin: "654321" });
  });

  it("serves the contract CRUD routes and does not expose a groups alias", async () => {
    const router = createInvitationsHttpRouter(options());
    const listed = await router.request(
      request("/v1/sites/site-1/invitations"),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ invitations: [invitation] });

    const created = await router.request(
      request("/v1/sites/site-1/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Família Silva",
          phone: "+5511999999999",
          guests: [{ fullName: "Ana Silva", guestType: "ADULT" }],
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ invitation });

    const oldPath = await router.request(request("/v1/sites/site-1/groups"));
    expect(oldPath.status).toBe(404);
  });

  it("passes invitation and exact deletion confirmation to the service", async () => {
    const router = createInvitationsHttpRouter(options());
    const updated = await router.request(
      request("/v1/sites/site-1/invitations/invitation-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Família Silva Atualizada" }),
      }),
    );
    expect(updated.status).toBe(200);

    const deleted = await router.request(
      request("/v1/sites/site-1/invitations/invitation-1", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmInvitationId: "invitation-1",
          confirmInvitationName: "Família Silva",
        }),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(mocks.deleteInvitation).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "owner-1", role: "OWNER" },
      "site-1",
      "invitation-1",
      {
        confirmInvitationId: "invitation-1",
        confirmInvitationName: "Família Silva",
      },
      undefined,
    );
  });

  it("supports current and rotated invitation access PIN routes", async () => {
    const router = createInvitationsHttpRouter(options());
    const current = await router.request(
      request("/v1/sites/site-1/invitations/invitation-1/access-pin"),
    );
    const rotated = await router.request(
      request("/v1/sites/site-1/invitations/invitation-1/access-pin/rotate", {
        method: "POST",
      }),
    );

    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ accessPin: "123456" });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ accessPin: "654321" });
  });

  it("rejects malformed deletion confirmation before service access", async () => {
    const response = await createInvitationsHttpRouter(options()).request(
      request("/v1/sites/site-1/invitations/invitation-1", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmInvitationId: "invitation-1" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.deleteInvitation).not.toHaveBeenCalled();
  });

  it("does not disguise authentication dependency failures as bad sessions", async () => {
    mocks.requireAdminSession.mockRejectedValue(
      new Error("database unavailable"),
    );
    const response = await createInvitationsHttpRouter(options()).request(
      request("/v1/sites/site-1/invitations"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
