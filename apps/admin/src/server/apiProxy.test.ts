import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyApiRequest } from "./apiProxy";

const config = {
  apiBaseUrl: "https://api.example.test",
  adminOrigin: "https://admin.example.test",
};

afterEach(() => vi.unstubAllGlobals());

function proxyRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://admin.example.test${path}`, {
    ...init,
    headers: {
      Origin: config.adminOrigin,
      ...(init.headers ?? {}),
    },
  });
}

describe("admin API proxy", () => {
  it("forwards only the fixed API path and safe request headers", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "better-auth.session_token=opaque; Path=/; HttpOnly",
          "X-Request-Id": "request-id",
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=opaque",
          "Content-Type": "application/json",
          "X-Forwarded-Host": "evil.example.test",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "secret",
        }),
      }),
      config,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=opaque",
    );
    expect(response.headers.get("x-request-id")).toBe("request-id");
    expect(await response.json()).toEqual({ ok: true });
    const [target, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("https://api.example.test/v1/auth/sign-in/email");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      cookie: "better-auth.session_token=opaque",
      "content-type": "application/json",
      origin: config.adminOrigin,
    });
  });

  it("allows same-origin GET without Origin and preserves its query", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me?tab=summary"),
      config,
    );

    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v1/me?tab=summary",
    );
  });

  it("preserves attachment metadata and binary report bytes", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="entrelacos-rsvp-casamento.csv"',
          },
        }),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/sites/casamento-a/reports/rsvp.csv"),
      config,
    );

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="entrelacos-rsvp-casamento.csv"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects foreign Origin and cross-site fetch metadata for safe reads", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const foreignOrigin = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me", {
        headers: { Origin: "https://evil.example.test" },
      }),
      config,
    );
    const crossSite = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      config,
    );

    expect(foreignOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects hostile origins, traversal, and open-proxy paths without fetching", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const hostile = await proxyApiRequest(
      proxyRequest("/api/v1/me", {
        headers: { Origin: "https://evil.example.test" },
      }),
      config,
    );
    expect(hostile.status).toBe(403);

    const traversal = await proxyApiRequest(
      proxyRequest("/api/v1/%2e%2e%2fsecret"),
      config,
    );
    expect(traversal.status).toBe(404);

    const openProxy = await proxyApiRequest(
      proxyRequest("/api/https://evil.example.test"),
      config,
    );
    expect(openProxy.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("removes tokens from native auth JSON while leaving safe /me session metadata intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            token: "secret",
            session: { token: "secret-2", id: "safe-id" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/sign-in/email"),
      config,
    );
    expect(await response.json()).toEqual({
      ok: true,
      session: { id: "safe-id" },
    });
  });

  it("preserves intentional tokens on non-native auth paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, token: "one-time-link" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/activate"),
      config,
    );
    expect(await response.json()).toEqual({
      ok: true,
      token: "one-time-link",
    });
  });
});
