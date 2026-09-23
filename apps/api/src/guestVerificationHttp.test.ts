import { describe, expect, it } from "vitest";
import {
  createGuestVerificationHttpRouter,
  forwardedClientIp,
} from "./guestVerificationHttp";

function createTestRouter() {
  return createGuestVerificationHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin: "https://admin.example.test",
    guestFingerprintSecret:
      "invitation-access-test-secret-with-at-least-32-characters",
    guestResolveClientIp: () => "127.0.0.1",
  });
}

describe("public invitation access HTTP boundary", () => {
  it("prefers Railway client IP over forwarded fallbacks", () => {
    expect(
      forwardedClientIp(
        new Headers({
          "X-Real-IP": "198.51.100.10",
          "CF-Connecting-IP": "198.51.100.20",
          "X-Forwarded-For": "198.51.100.30, 198.51.100.40",
        }),
      ),
    ).toBe("198.51.100.10");
  });

  it("mounts only canonical access and invitation-session paths", async () => {
    const router = createTestRouter();
    const legacyPaths = [
      "/v1/public/sites/site-1/guest/challenge",
      "/v1/public/guest/challenge/challenge-1/verify",
      "/v1/public/family/session",
    ];

    for (const path of legacyPaths) {
      const response = await router.request(`http://localhost${path}`);
      expect(response.status).toBe(404);
    }

    const invalidAccess = await router.request(
      "http://localhost/v1/public/sites/site-1/invitation/access",
      {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phone: "(11) 99999-9999", accessPin: "4218" }),
      },
    );

    expect(invalidAccess.status).toBe(400);
    expect(invalidAccess.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost",
    );
    expect(invalidAccess.headers.get("Cache-Control")).toBe("no-store");
    expect(await invalidAccess.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
  });

  it("rejects request fields outside phone and access PIN", async () => {
    const router = createTestRouter();
    const response = await router.request(
      "http://localhost/v1/public/sites/site-1/invitation/access",
      {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: "(11) 99999-9999",
          accessPin: "004218",
          guestName: "Ana Silva",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
  });
});
