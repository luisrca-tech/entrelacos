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
  text: "Viva os noivos!",
  createdAt: "2026-09-12T12:00:00.000Z",
};

describe("public mural client", () => {
  it("counts Unicode code points", () => {
    expect(countMessageCodePoints("Olá\r\n🎉")).toBe(5);
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
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("creates an independent public message without invitation credentials", async () => {
    const requestId = "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5";
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          requestId,
          acceptedAt: "2026-09-12T12:00:00.000Z",
          replayed: false,
          message,
        }),
    );
    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    await expect(
      api.createPublicSiteMessage({
        requestId,
        authorName: " Ana Silva ",
        text: "Viva os noivos!",
      }),
    ).resolves.toMatchObject({ message: { authorName: "Ana Silva" } });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.test/v1/public/sites/casamento-a/mural",
    );
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    });
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId,
      authorName: "Ana Silva",
      text: "Viva os noivos!",
    });
  });

  it("keeps Retry-After seconds on public post rate-limit errors", async () => {
    const api = new WeddingMessagesApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher: vi.fn(async () =>
        response(
          { code: "RATE_LIMITED" },
          { status: 429, headers: { "Retry-After": "60" } },
        ),
      ),
    });

    await expect(
      api.createPublicSiteMessage({
        requestId: "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5",
        authorName: "Ana Silva",
        text: "Viva os noivos!",
      }),
    ).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 60,
    });
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
      getMessageErrorMessage(new WeddingMessagesApiError(0, "NETWORK_ERROR")),
    ).toContain("conexão");
    expect(
      getMessageErrorMessage(
        new WeddingMessagesApiError(429, "RATE_LIMITED", 60),
      ),
    ).toContain("60 segundos");
    expect(
      getMessageErrorMessage(
        new WeddingMessagesApiError(409, "MURAL_DISABLED"),
      ),
    ).toContain("desativado");
    expect(
      getMessageErrorMessage(new WeddingMessagesApiError(409, "SITE_INACTIVE")),
    ).toContain("temporariamente indisponível");
  });

  it("namespaces the local refresh event by site", () => {
    expect(muralRefreshEventName("casamento-a")).not.toBe(
      muralRefreshEventName("casamento-b"),
    );
  });
});
