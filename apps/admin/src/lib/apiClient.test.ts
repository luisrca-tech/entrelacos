import { describe, expect, it, vi } from "vitest";
import { apiRequest, safePanelReturn } from "./apiClient";

describe("panel API boundary", () => {
  it("uses only the same-origin BFF and never caches session data", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    await expect(
      apiRequest(
        "/v1/auth/sign-in/email",
        {
          method: "POST",
          body: { email: "person@example.test", password: "fixture-password" },
        },
        fetcher,
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/sign-in/email",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  it("rejects destinations outside the BFF", async () => {
    const fetcher = vi.fn();
    await expect(
      apiRequest("https://outside.test/v1/me", {}, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not expose upstream error details", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "UNAUTHORIZED", title: "secret provider diagnostic" },
          { status: 401 },
        ),
      );
    await expect(apiRequest("/v1/me", {}, fetcher)).rejects.toMatchObject({
      status: 401,
      message: "Sua sessão expirou ou não está autenticada. Entre novamente.",
    });
  });
  it("accepts an empty successful moderation response", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      apiRequest(
        "/v1/sites/demo/messages/message-a",
        { method: "DELETE" },
        fetcher,
      ),
    ).resolves.toBeUndefined();
  });
  it("limits login return destinations to the panel or handoff page", () => {
    expect(safePanelReturn("/handoff?siteId=one&challenge=abc")).toBe(
      "/handoff?siteId=one&challenge=abc",
    );
    expect(safePanelReturn("/sites/demo/invitations")).toBe(
      "/sites/demo/invitations",
    );
    expect(safePanelReturn("/sites/demo/settings?tab=domain")).toBe(
      "/sites/demo/settings?tab=domain",
    );
    for (const value of [
      "//evil.test",
      "https://evil.test",
      "/login",
      "/sites",
      "/sites/demo/unknown",
      "/sites/demo/guests",
      "/sites/demo/rsvp",
      "/sites/demo/overview#evil",
      "/handoff/../evil",
      "/handoff#evil",
      undefined,
    ])
      expect(safePanelReturn(value)).toBe("/");
  });
});
