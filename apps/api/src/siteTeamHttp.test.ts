import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionRequiredError } from "./authHttp";
import { SiteAccessDeniedError } from "./siteAccess";
import { SiteTeamServiceError } from "./siteTeam";
import { createSiteTeamHttpRouter } from "./siteTeamHttp";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  session: vi.fn(),
  access: vi.fn(),
  issue: vi.fn(),
  list: vi.fn(),
  revokeInvite: vi.fn(),
  revokeMember: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("./authHttp", async (original) => ({
  ...(await original<typeof import("./authHttp")>()),
  requireAdminSession: mocks.actor,
  getAdministrativeSession: mocks.session,
}));
vi.mock("./siteAccess", async (original) => ({
  ...(await original<typeof import("./siteAccess")>()),
  resolveSiteAccess: mocks.access,
}));
vi.mock("./siteTeam", () => ({
  issueSiteAssessorInvitation: mocks.issue,
  listSiteTeam: mocks.list,
  revokeSiteAssessorInvitation: mocks.revokeInvite,
  revokeSiteAssessorMembership: mocks.revokeMember,
  acceptSiteAssessorInvitation: mocks.accept,
  SiteTeamServiceError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
    }
  },
}));
const adminOrigin = "https://panel.example.test";
const actor = {
  user: { id: "admin-a", role: "SITE_ADMIN" },
  session: { id: "session-a" },
  siteId: "wedding-a",
};
const access = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "membership-a",
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
const invitation = {
  id: "invite-a",
  siteId: "wedding-a",
  email: "helper@example.test",
  inviteeName: "Helper",
  expiresAt: "2026-10-13T00:00:00.000Z",
  consumedAt: null,
  revokedAt: null,
};
const token = "a".repeat(43);
const db = {} as never;
const router = () =>
  createSiteTeamHttpRouter({ db, auth: {} as never, adminOrigin });
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  origin = adminOrigin,
) =>
  new Request(`https://api.example.test${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(actor);
  mocks.session.mockResolvedValue(null);
  mocks.access.mockResolvedValue(access);
  mocks.list.mockResolvedValue({ members: [], invitations: [] });
  mocks.issue.mockResolvedValue({ invitation, token });
  mocks.accept.mockResolvedValue({ siteId: "wedding-a" });
  mocks.revokeInvite.mockResolvedValue({ ok: true });
  mocks.revokeMember.mockResolvedValue({ ok: true });
});

describe("site team HTTP boundary", () => {
  it("returns no-store exact-site server access and denies absent membership", async () => {
    let response = await router().request(
      request("/v1/sites/wedding-a/access"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ access });
    expect(mocks.access).toHaveBeenCalledWith(db, {
      userId: "admin-a",
      platformRole: "SITE_ADMIN",
      siteId: "wedding-a",
    });
    mocks.access.mockResolvedValue(null);
    response = await router().request(request("/v1/sites/wedding-b/access"));
    expect(response.status).toBe(403);
  });
  it("requires exact origin and authenticated identity before team reads or issuance", async () => {
    expect(
      (
        await router().request(
          request(
            "/v1/sites/wedding-a/team",
            "GET",
            undefined,
            "https://other.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
    mocks.actor.mockRejectedValue(new AdminSessionRequiredError());
    expect(
      (await router().request(request("/v1/sites/wedding-a/team"))).status,
    ).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("issues only strict named-email invitations scoped by the route and server actor", async () => {
    const response = await router().request(
      request("/v1/sites/wedding-a/team/invitations", "POST", {
        name: "Helper",
        email: "helper@example.test",
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ invitation, token });
    expect(mocks.issue).toHaveBeenCalledWith(
      db,
      { userId: "admin-a", role: "SITE_ADMIN" },
      "wedding-a",
      { name: "Helper", email: "helper@example.test" },
      undefined,
    );
    for (const extra of [
      { role: "SITE_ADMIN" },
      { siteId: "wedding-b" },
      { userId: "other" },
    ]) {
      expect(
        (
          await router().request(
            request("/v1/sites/wedding-a/team/invitations", "POST", {
              name: "Helper",
              email: "helper@example.test",
              ...extra,
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });
  it("preserves server membership denial without exposing service diagnostics", async () => {
    mocks.list.mockRejectedValue(new SiteAccessDeniedError());
    const response = await router().request(
      request("/v1/sites/wedding-a/team"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "MEMBERSHIP_DENIED" });
  });
  it("revokes only route-bound targets and rejects privilege-bearing bodies", async () => {
    expect(
      (
        await router().request(
          request(
            "/v1/sites/wedding-a/team/members/helper-a/revoke",
            "POST",
            {},
          ),
        )
      ).status,
    ).toBe(200);
    expect(mocks.revokeMember).toHaveBeenCalledWith(
      db,
      { userId: "admin-a", role: "SITE_ADMIN" },
      "wedding-a",
      "helper-a",
      undefined,
    );
    expect(
      (
        await router().request(
          request(
            "/v1/sites/wedding-a/team/invitations/invite-a/revoke",
            "POST",
            {},
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/team/members/helper-a/revoke", "POST", {
            role: "OWNER",
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.revokeMember).toHaveBeenCalledTimes(1);
  });
  it("passes new-account acceptance capability only in the body and existing identity separately", async () => {
    expect(
      (
        await router().request(
          request("/v1/team-invitations/accept", "POST", {
            token,
            password: "secret12",
          }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.accept).toHaveBeenLastCalledWith(
      db,
      { token, password: "secret12" },
      null,
      undefined,
    );
    mocks.session.mockResolvedValue(actor);
    expect(
      (
        await router().request(
          request("/v1/team-invitations/accept", "POST", { token }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.accept).toHaveBeenLastCalledWith(
      db,
      { token },
      { userId: "admin-a", role: "SITE_ADMIN" },
      undefined,
    );
    expect(
      (
        await router().request(
          request("/v1/team-invitations/accept", "POST", {
            token,
            role: "OWNER",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("sanitizes invitation and unexpected errors and never includes the capability", async () => {
    mocks.accept.mockRejectedValue(
      new SiteTeamServiceError(
        400,
        "TEAM_INVITATION_INVALID",
        `private ${token}`,
      ),
    );
    let response = await router().request(
      request("/v1/team-invitations/accept", "POST", { token }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(token);
    mocks.accept.mockRejectedValue(new Error(`private ${token}`));
    response = await router().request(
      request("/v1/team-invitations/accept", "POST", { token }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(token);
  });
});
