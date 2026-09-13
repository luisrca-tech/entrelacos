import { describe, expect, it, vi } from "vitest";
import {
  countMessageCodePoints,
  getMessageErrorMessage,
  muralRefreshEventName,
  WeddingMessagesApi,
  WeddingMessagesApiError,
} from "./messages";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const message = {
  id: "message-a",
  authorName: "Ana Silva",
  groupName: "Família Silva",
  text: "Viva os noivos!",
  revision: 1,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
};

describe("wedding messages client", () => {
  it("counts Unicode code points and normalizes line endings before writes", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          requestId: "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5",
          acceptedAt: "2026-09-12T12:00:00.000Z",
          result: "APPLIED",
          replayed: false,
          message: { ...message, text: "Olá\n🎉" },
        }),
    );
    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    expect(countMessageCodePoints("Olá\r\n🎉")).toBe(5);
    await api.saveFamilyMessage("s".repeat(43), {
      requestId: "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5",
      expectedRevision: 0,
      text: "Olá\r\n🎉",
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.test/v1/public/family/message",
    );
    expect(init).toMatchObject({
      method: "PUT",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${"s".repeat(43)}`,
        "Content-Type": "application/json",
      },
    });
    expect(init?.body).toContain('"text":"Olá\\n🎉"');
  });

  it("reads the family message with only the family bearer", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          siteId: "casamento-a",
          groupId: "group-a",
          currentRevision: 1,
          canEdit: true,
          readOnlyReason: null,
          message,
        }),
    );
    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    await expect(api.getFamilyMessage("s".repeat(43))).resolves.toMatchObject({
      currentRevision: 1,
      message: { authorName: "Ana Silva" },
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${"s".repeat(43)}`,
    });
  });

  it("reads a cursor-bound public mural without credentials or authorization", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({ enabled: true, messages: [], nextCursor: null }),
    );
    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    await api.getMural({ cursor: "created/id+site", limit: 12 });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.test/v1/public/sites/casamento-a/mural?cursor=created%2Fid%2Bsite&limit=12",
    );
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("rejects invalid configuration and invalid API responses", async () => {
    expect(
      () =>
        new WeddingMessagesApi({
          apiOrigin: "https://api.example.test/path",
          siteId: "casamento-a",
        }),
    ).toThrow("Invalid public API origin");

    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher: vi.fn(async () => response({ enabled: true })),
    });
    await expect(api.getMural()).rejects.toMatchObject({
      status: 502,
      code: "INVALID_API_RESPONSE",
    });
  });

  it("maps message failures to honest Portuguese feedback", () => {
    expect(
      getMessageErrorMessage(
        new WeddingMessagesApiError(409, "MESSAGE_CONFLICT"),
      ),
    ).toContain("alterada em outro acesso");
    expect(
      getMessageErrorMessage(
        new WeddingMessagesApiError(403, "MESSAGE_BLOCKED"),
      ),
    ).toContain("bloqueou novas mensagens");
    expect(
      getMessageErrorMessage(new WeddingMessagesApiError(0, "NETWORK_ERROR")),
    ).toContain("conexão");
  });

  it("namespaces the local refresh event by site", () => {
    expect(muralRefreshEventName("casamento-a")).not.toBe(
      muralRefreshEventName("casamento-b"),
    );
  });
});
