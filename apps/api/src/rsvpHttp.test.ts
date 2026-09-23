import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  readInvitationRsvp: vi.fn(),
  writeInvitationRsvp: vi.fn(),
  readRsvpDeadline: vi.fn(),
  updateRsvpDeadline: vi.fn(),
  readSiteRsvp: vi.fn(),
  writeAdminRsvp: vi.fn(),
  listRsvpHistory: vi.fn(),
  RsvpServiceError: class RsvpServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(title);
      this.name = "RsvpServiceError";
    }
  },
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./rsvp", () => ({
  RsvpServiceError: mocks.RsvpServiceError,
  readInvitationRsvp: mocks.readInvitationRsvp,
  writeInvitationRsvp: mocks.writeInvitationRsvp,
  readRsvpDeadline: mocks.readRsvpDeadline,
  updateRsvpDeadline: mocks.updateRsvpDeadline,
  readSiteRsvp: mocks.readSiteRsvp,
  writeAdminRsvp: mocks.writeAdminRsvp,
  listRsvpHistory: mocks.listRsvpHistory,
}));

import { createRsvpHttpRouter } from "./rsvpHttp";

const adminOrigin = "https://admin.example.test";
const publicOrigin = "https://wedding.example.test";
const requestId = randomUUID();
const guest = {
  id: "guest-1",
  fullName: "Ana Silva",
  guestType: "ADULT" as const,
  state: "CONFIRMED" as const,
  revision: 1,
};
const invitationResponse = {
  siteId: "site-1",
  invitationId: "invitation-1",
  invitationName: "Família Silva",
  deadlineAt: null,
  deadlineTimezone: null,
  serverNow: "2028-04-01T12:00:00.000Z",
  canEdit: true,
  readOnlyReason: null,
  guests: [guest],
};
const writeResponse = {
  requestId,
  acceptedAt: "2028-04-01T12:00:00.000Z",
  result: "APPLIED" as const,
  replayed: false,
  guests: [guest],
};
const siteResponse = {
  siteId: "site-1",
  lifecycle: "ACTIVE" as const,
  deadlineAt: null,
  deadlineTimezone: null,
  totals: { pending: 0, confirmed: 1, declined: 0 },
  invitations: [
    {
      id: "invitation-1",
      name: "Família Silva",
      guests: [guest],
      totals: { pending: 0, confirmed: 1, declined: 0 },
    },
  ],
};
const historyResponse = { entries: [], nextCursor: null };

function createDb(results: unknown[][] = []) {
  const queue = [...results];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const selected = queue.shift() ?? [];
          return Object.assign(Promise.resolve(selected), {
            limit: vi.fn(async () => selected),
          });
        }),
      })),
    })),
  } as never;
}

function options(db: unknown = createDb()) {
  return {
    auth: {} as never,
    db: db as never,
    adminOrigin,
    now: () => new Date("2028-04-01T12:00:00.000Z"),
  };
}

function request(path: string, init: RequestInit = {}, origin = adminOrigin) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function invitationRequest(
  path: string,
  init: RequestInit = {},
  origin = publicOrigin,
) {
  return request(
    path,
    {
      ...init,
      headers: {
        Authorization: "Bearer invitation-token",
        ...(init.headers ?? {}),
      },
    },
    origin,
  );
}

describe("RSVP HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    mocks.readInvitationRsvp.mockResolvedValue(invitationResponse);
    mocks.writeInvitationRsvp.mockResolvedValue(writeResponse);
    mocks.readRsvpDeadline.mockResolvedValue({
      deadlineAt: null,
      deadlineTimezone: null,
    });
    mocks.updateRsvpDeadline.mockResolvedValue({
      deadlineAt: "2028-04-02T03:00:00.000Z",
      deadlineTimezone: "America/Sao_Paulo",
    });
    mocks.readSiteRsvp.mockResolvedValue(siteResponse);
    mocks.writeAdminRsvp.mockResolvedValue(writeResponse);
    mocks.listRsvpHistory.mockResolvedValue(historyResponse);
  });

  it("checks exact admin origin before session or service access", async () => {
    const router = createRsvpHttpRouter(options());
    const response = await router.request(
      request(
        "/v1/sites/site-1/rsvp",
        { method: "GET" },
        "https://evil.example.test",
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(mocks.readSiteRsvp).not.toHaveBeenCalled();
  });

  it("requires an admin session and filters the site invitation list", async () => {
    const router = createRsvpHttpRouter(options());
    const response = await router.request(
      request(
        "/v1/sites/site-1/rsvp?invitationId=invitation-1&state=CONFIRMED",
        {
          method: "GET",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(siteResponse);
    expect(mocks.readSiteRsvp).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { invitationId: "invitation-1", state: "CONFIRMED" },
    );
  });

  it("accepts canonical guest writes and serves deadline and history routes", async () => {
    const router = createRsvpHttpRouter(options());
    const payload = {
      requestId,
      guests: [{ guestId: guest.id, state: "CONFIRMED", expectedRevision: 1 }],
    };
    const update = await router.request(
      request("/v1/sites/site-1/rsvp", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual(writeResponse);
    expect(mocks.writeAdminRsvp).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      payload,
      expect.any(Date),
    );

    const invalid = await router.request(
      request("/v1/sites/site-1/rsvp", {
        method: "POST",
        body: JSON.stringify({ ...payload, extra: true }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("VALIDATION_ERROR");

    const deadline = await router.request(
      request("/v1/sites/site-1/rsvp/deadline", { method: "GET" }),
    );
    expect(deadline.status).toBe(200);
    expect(mocks.readRsvpDeadline).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
    );

    const history = await router.request(
      request("/v1/sites/site-1/rsvp/history?limit=10", { method: "GET" }),
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual(historyResponse);
    expect(mocks.listRsvpHistory).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { limit: 10 },
    );
  });

  it("serves invitation sessions with exact site origin and no legacy family paths", async () => {
    const router = createRsvpHttpRouter(
      options(createDb([[{ siteId: "site-1" }], [{ origin: publicOrigin }]])),
    );
    const response = await router.request(
      invitationRequest("/v1/public/invitation/rsvp", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(invitationResponse);
    expect(mocks.readInvitationRsvp).toHaveBeenCalledWith(
      expect.anything(),
      "invitation-token",
      expect.any(Date),
    );

    const hostile = await createRsvpHttpRouter(
      options(createDb([[{ siteId: "site-1" }], []])),
    ).request(
      invitationRequest(
        "/v1/public/invitation/rsvp",
        { method: "GET" },
        "https://evil.example.test",
      ),
    );
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("Access-Control-Allow-Origin")).toBeNull();

    for (const path of [
      "/v1/public/family/rsvp",
      "/v1/public/family/session",
    ]) {
      expect(
        (await router.request(invitationRequest(path, { method: "GET" })))
          .status,
      ).toBe(404);
    }
  });

  it("returns current guest revisions for public optimistic-concurrency conflicts", async () => {
    mocks.writeInvitationRsvp.mockRejectedValue(
      new mocks.RsvpServiceError(409, "RSVP_CONFLICT", "RSVP data changed", {
        guests: [{ id: guest.id, state: "DECLINED", revision: 2 }],
      }),
    );
    const router = createRsvpHttpRouter(
      options(createDb([[{ siteId: "site-1" }], [{ origin: publicOrigin }]])),
    );
    const response = await router.request(
      invitationRequest("/v1/public/invitation/rsvp", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          guests: [
            { guestId: guest.id, state: "CONFIRMED", expectedRevision: 1 },
          ],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 409,
      code: "RSVP_CONFLICT",
      details: { guests: [{ id: guest.id, state: "DECLINED", revision: 2 }] },
    });
  });

  it("requires a registered origin for a credential-free preflight", async () => {
    const router = createRsvpHttpRouter(
      options(createDb([[{ origin: publicOrigin }]])),
    );
    const response = await router.request(
      request(
        "/v1/public/invitation/rsvp",
        { method: "OPTIONS" },
        publicOrigin,
      ),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
