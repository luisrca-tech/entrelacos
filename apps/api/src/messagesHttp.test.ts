import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  readInvitationMessage: vi.fn(),
  writeInvitationMessage: vi.fn(),
  listSiteMessages: vi.fn(),
  MessagesServiceError: class MessagesServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
      readonly details?: Record<string, unknown>,
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
  readInvitationMessage: mocks.readInvitationMessage,
  writeInvitationMessage: mocks.writeInvitationMessage,
  listSiteMessages: mocks.listSiteMessages,
}));

import { createMessagesHttpRouter } from "./messagesHttp";

const publicOrigin = "https://wedding.example.test";
const invitationResponse = {
  siteId: "site-1",
  invitationId: "invitation-1",
  currentRevision: 1,
  canEdit: true,
  readOnlyReason: null,
  message: {
    id: "message-1",
    authorName: "Ana Silva",
    invitationName: "Família Silva",
    text: "Com carinho",
    revision: 1,
    createdAt: "2028-04-01T12:00:00.000Z",
    updatedAt: "2028-04-01T12:00:00.000Z",
  },
};

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: publicOrigin,
      Authorization: "Bearer invitation-token",
      ...(init.headers ?? {}),
    },
  });
}

function router() {
  return createMessagesHttpRouter({
    auth: {} as never,
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table) {
            return {
              where: () => ({
                limit: async () => [{ siteId: "site-1" }],
              }),
              leftJoin: () => ({
                where: async () => [
                  {
                    publicUrl: "https://wedding.example.test/",
                    origin: publicOrigin,
                  },
                ],
              }),
            };
          }
          return {};
        },
      }),
    } as never,
    adminOrigin: "https://admin.example.test",
  });
}

describe("messages HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    mocks.readInvitationMessage.mockResolvedValue(invitationResponse);
    mocks.listSiteMessages.mockResolvedValue({
      invitations: [],
      nextCursor: null,
    });
  });

  it("reads invitation message through the bearer session and exact public origin", async () => {
    const response = await router().request(
      request("/v1/public/invitation/message", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      publicOrigin,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readInvitationMessage).toHaveBeenCalledWith(
      expect.anything(),
      "invitation-token",
      undefined,
    );
    await expect(response.json()).resolves.toEqual(invitationResponse);
  });

  it("rejects extra fields before invoking the invitation write service", async () => {
    const response = await router().request(
      request("/v1/public/invitation/message", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "00000000-0000-4000-8000-000000000001",
          expectedRevision: 1,
          text: "Com carinho",
          authorName: "Pessoa inventada",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("keeps administration on the exact admin origin and tenant actor", async () => {
    const response = await router().request(
      new Request(
        "https://api.example.test/v1/sites/site-1/messages?limit=10",
        {
          headers: { Origin: "https://admin.example.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      invitations: [],
      nextCursor: null,
    });
    expect(mocks.listSiteMessages).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { limit: 10 },
    );
  });

  it("does not expose legacy family or group message routes", async () => {
    const publicLegacy = await router().request(
      request("/v1/public/family/message"),
    );
    expect(publicLegacy.status).toBe(404);
    const adminLegacy = await router().request(
      new Request(
        "https://api.example.test/v1/sites/site-1/groups/group-1/message",
        { method: "DELETE", headers: { Origin: "https://admin.example.test" } },
      ),
    );
    expect(adminLegacy.status).toBe(404);
  });
});
