import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createAuth } from "./auth";

const configuredOrigin = "https://admin.example.test";
const localOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://localhost:4242",
  "http://localhost",
];
const hostileOrigins = [
  "http://localhost.evil:3000",
  "http://localhostevil:3000",
  "http://evil.localhost:3000",
  "http://user@localhost:3000",
  "http://localhost:3000/path",
  "http://localhost:3000?query=1",
  "http://localhost:3000#fragment",
  "http://localhost:03000",
  "http://localhost:65536",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "null",
  "invalid",
];

afterEach(() => vi.unstubAllEnvs());

function application() {
  const getSession = vi.fn().mockResolvedValue(null);
  const handler = vi.fn().mockResolvedValue(Response.json({ success: true }));
  const auth = { api: { getSession }, handler } as never;
  const app = createApp(
    { db: {} as never, auth, adminOrigin: configuredOrigin },
    { sink: () => {} },
  );
  return { app, getSession, handler };
}

describe("development localhost API origins", () => {
  it.each(localOrigins)(
    "admits %s on authentication and protected API paths",
    async (origin) => {
      vi.stubEnv("APP_ENV", "development");
      vi.stubEnv("NODE_ENV", "development");
      const { app, handler } = application();
      for (const path of [
        "/v1/me",
        "/v1/owner/sites",
        "/v1/owner/sites/site-a/admins",
        "/v1/sites/site-a/receiving/readiness",
        "/v1/sites/site-a/rsvp",
        "/v1/sites/site-a/invitations",
        "/v1/sites/site-a/messages",
        "/v1/sites/site-a/team",
        "/v1/sites/site-a/access",
      ]) {
        const response = await app.request(path, {
          headers: { Origin: origin },
        });
        expect(response.status, path).toBe(401);
      }
      const response = await app.request("/v1/auth/sign-out", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it.each(hostileOrigins)(
    "rejects malformed or foreign origin %s before authentication",
    async (origin) => {
      vi.stubEnv("APP_ENV", "development");
      vi.stubEnv("NODE_ENV", "development");
      const { app, getSession, handler } = application();
      for (const path of ["/v1/me", "/v1/owner/sites"]) {
        expect(
          (await app.request(path, { headers: { Origin: origin } })).status,
        ).toBe(403);
      }
      expect(getSession).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["production", "development"],
    ["development", "production"],
    ["test", "development"],
    [undefined, "development"],
  ])(
    "keeps exact configured origins for APP_ENV=%s and NODE_ENV=%s",
    async (appEnv, nodeEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { app } = application();
      expect(
        (await app.request("/v1/me", { headers: { Origin: localOrigins[0] } }))
          .status,
      ).toBe(403);
      expect(
        (await app.request("/v1/me", { headers: { Origin: configuredOrigin } }))
          .status,
      ).toBe(401);
      const auth = createAuth({
        db: {} as never,
        secret: "test-only-auth-secret-that-is-long-enough",
        baseURL: "https://api.example.test",
        adminOrigin: configuredOrigin,
      });
      expect(auth.options.trustedOrigins).toEqual([configuredOrigin]);
    },
  );

  it("adds only documented localhost port patterns to Better Auth in development", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "development");
    const auth = createAuth({
      db: {} as never,
      secret: "test-only-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: configuredOrigin,
    });
    expect(auth.options.trustedOrigins).toEqual([
      configuredOrigin,
      "http://localhost:*",
      "https://localhost:*",
      "http://localhost",
      "https://localhost",
    ]);
    for (const origin of localOrigins) {
      const response = await auth.handler(
        new Request("https://api.example.test/v1/auth/sign-out", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status, origin).toBe(200);
    }
  });
});
