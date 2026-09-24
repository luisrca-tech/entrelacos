import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  createPublicSiteMessage: vi.fn(),
  readPublicMural: vi.fn(),
  listSiteMessages: vi.fn(),
  deleteSiteMessage: vi.fn(),
  readMuralConfiguration: vi.fn(),
  updateMuralConfiguration: vi.fn(),
  MessagesServiceError: class MessagesServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
      readonly details?: Record<string, unknown>,
      readonly retryAfterSeconds?: number,
    ) {
      super(title);
      this.name = "MessagesServiceError";
    }
  },
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./messages", () => ({
  MessagesServiceError: mocks.MessagesServiceError,
  createPublicSiteMessage: mocks.createPublicSiteMessage,
  readPublicMural: mocks.readPublicMural,
  listSiteMessages: mocks.listSiteMessages,
  deleteSiteMessage: mocks.deleteSiteMessage,
  readMuralConfiguration: mocks.readMuralConfiguration,
  updateMuralConfiguration: mocks.updateMuralConfiguration,
}));

import { createMessagesHttpRouter } from "./messagesHttp";

const publicOrigin = "https://wedding.example.test";
const adminOrigin = "https://admin.example.test";
const createdMessage = {
  id: "message-1",
  authorName: "Ana Silva",
  text: "Com carinho",
  createdAt: "2029-01-10T12:00:00.000Z",
};
const createResponse = {
  requestId: "00000000-0000-4000-8000-000000000001",
  acceptedAt: "2029-01-10T12:00:00.000Z",
  replayed: false,
  message: createdMessage,
};

function request(path: string, init: RequestInit = {}, origin = publicOrigin) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: { Origin: origin, ...(init.headers ?? {}) },
  });
}

function router(ipAddress: string | undefined = "203.0.113.10") {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      leftJoin: vi.fn(() => ({
        where: vi.fn(async () => [
          { publicUrl: `${publicOrigin}/`, origin: publicOrigin },
        ]),
      })),
    })),
  }));
  const db = { select };
  const app = createMessagesHttpRouter({
    auth: {} as never,
    db: db as never,
    adminOrigin,
    guestFingerprintSecret: "s".repeat(64),
    guestResolveClientIp: () => ipAddress ?? "",
    now: () => new Date("2029-01-10T12:00:00.000Z"),
  });
  return { app, db, select };
}

describe("messages HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    mocks.createPublicSiteMessage.mockResolvedValue(createResponse);
    mocks.readPublicMural.mockResolvedValue({
      enabled: true,
      messages: [createdMessage],
      nextCursor: null,
    });
    mocks.listSiteMessages.mockResolvedValue({
      messages: [],
      nextCursor: null,
    });
    mocks.deleteSiteMessage.mockResolvedValue({ ok: true });
    mocks.readMuralConfiguration.mockResolvedValue({
      siteId: "site-1",
      enabled: true,
    });
    mocks.updateMuralConfiguration.mockResolvedValue({
      siteId: "site-1",
      enabled: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains the public GET response and accepts a message without a guest bearer", async () => {
    const { app } = router();
    const get = await app.request(
      request("/v1/public/sites/site-1/mural?limit=10"),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe(publicOrigin);
    expect(await get.json()).toEqual({
      enabled: true,
      messages: [createdMessage],
      nextCursor: null,
    });

    const response = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: createResponse.requestId,
          authorName: " Ana Silva ",
          text: "Com carinho",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      publicOrigin,
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    await expect(response.json()).resolves.toEqual(createResponse);
    expect(mocks.createPublicSiteMessage).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      {
        requestId: createResponse.requestId,
        authorName: "Ana Silva",
        text: "Com carinho",
      },
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      new Date("2029-01-10T12:00:00.000Z"),
    );
  });

  it("returns stored messages from the public mural while disabled", async () => {
    mocks.readPublicMural.mockResolvedValue({
      enabled: false,
      messages: [createdMessage],
      nextCursor: "next-page",
    });
    const { app } = router();
    const response = await app.request(
      request("/v1/public/sites/site-1/mural?limit=10&cursor=next-page"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      messages: [createdMessage],
      nextCursor: "next-page",
    });
  });

  it("rejects invalid or oversized public message bodies before service writes", async () => {
    const { app } = router();
    const invalid = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: createResponse.requestId,
          authorName: " ",
          text: "Com carinho",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const oversized = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: createResponse.requestId,
          authorName: "Ana Silva",
          text: "Com carinho",
          extra: "x".repeat(5_000),
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(mocks.createPublicSiteMessage).not.toHaveBeenCalled();
  });

  it("applies the fast IP limit before parsing an over-limit request", async () => {
    const { app } = router();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const accepted = await app.request(
        request("/v1/public/sites/site-1/mural", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: createResponse.requestId,
            authorName: "Ana Silva",
            text: "Com carinho",
          }),
        }),
      );
      expect(accepted.status).toBe(201);
    }
    const blocked = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(blocked.headers.get("access-control-allow-origin")).toBe(
      publicOrigin,
    );
    expect(mocks.createPublicSiteMessage).toHaveBeenCalledTimes(30);
  });

  it("does not charge the fast IP limit for requests from an unregistered origin", async () => {
    const { app } = router();
    const body = JSON.stringify({
      requestId: createResponse.requestId,
      authorName: "Ana Silva",
      text: "Com carinho",
    });
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const rejected = await app.request(
        request(
          "/v1/public/sites/site-1/mural",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          },
          "https://unregistered.example.test",
        ),
      );
      expect(rejected.status).toBe(403);
    }

    const accepted = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
    expect(accepted.status).toBe(201);
    expect(mocks.createPublicSiteMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when trusted client IP is unavailable", async () => {
    const { app, select } = router("");
    const response = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "CLIENT_IP_UNAVAILABLE",
    });
    expect(select).not.toHaveBeenCalled();
    expect(mocks.createPublicSiteMessage).not.toHaveBeenCalled();
  });

  it("uses 429 Retry-After for the shared hourly publication limit", async () => {
    mocks.createPublicSiteMessage.mockRejectedValue(
      new mocks.MessagesServiceError(
        429,
        "RATE_LIMITED",
        "Too many public messages",
        undefined,
        145,
      ),
    );
    const { app } = router();
    const response = await app.request(
      request("/v1/public/sites/site-1/mural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: createResponse.requestId,
          authorName: "Ana Silva",
          text: "Com carinho",
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("145");
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "Retry-After",
    );
  });

  it("lists and deletes individual messages through site-scoped admin routes", async () => {
    mocks.listSiteMessages.mockResolvedValue({
      messages: [createdMessage],
      nextCursor: null,
    });
    const { app } = router();
    const listed = await app.request(
      request("/v1/sites/site-1/messages?limit=10", {}, adminOrigin),
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      messages: [createdMessage],
      nextCursor: null,
    });
    expect(mocks.listSiteMessages).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { limit: 10 },
    );

    const deleted = await app.request(
      request(
        "/v1/sites/site-1/messages/message-1",
        { method: "DELETE" },
        adminOrigin,
      ),
    );
    expect(deleted.status).toBe(204);
    expect(mocks.deleteSiteMessage).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      "message-1",
    );
  });

  it("passes the optional author search with the admin message cursor", async () => {
    const { app } = router();
    const listed = await app.request(
      request(
        "/v1/sites/site-1/messages?limit=10&search=Ana+Silva&cursor=cursor-token",
        {},
        adminOrigin,
      ),
    );

    expect(listed.status).toBe(200);
    expect(mocks.listSiteMessages).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { limit: 10, search: "Ana Silva", cursor: "cursor-token" },
    );
  });

  it("keeps mural configuration while removing invitation-specific routes", async () => {
    const { app } = router();
    const configuration = await app.request(
      request("/v1/sites/site-1/mural", {}, adminOrigin),
    );
    expect(configuration.status).toBe(200);
    await expect(configuration.json()).resolves.toEqual({
      siteId: "site-1",
      enabled: true,
    });

    const legacyPublic = await app.request(
      request("/v1/public/invitation/message"),
    );
    const legacyDelete = await app.request(
      request(
        "/v1/sites/site-1/invitations/invitation-1/message",
        { method: "DELETE" },
        adminOrigin,
      ),
    );
    const legacyBlock = await app.request(
      request(
        "/v1/sites/site-1/invitations/invitation-1/message-block",
        { method: "PATCH" },
        adminOrigin,
      ),
    );
    expect(legacyPublic.status).toBe(404);
    expect(legacyDelete.status).toBe(404);
    expect(legacyBlock.status).toBe(404);
  });
});
