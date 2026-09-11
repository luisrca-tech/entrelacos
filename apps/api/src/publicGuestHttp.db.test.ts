import { createHmac, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  guestRateLimitEvent,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { AuthHttpOptions } from "./authHttp";
import { DEMO_GUEST_GRANT_HEADER, issueDemoGuestGrant } from "./demoGuestGrant";
import { createGuestGroup } from "./guestGroups";
import { approveReview, createSite, startReview } from "./sites";

const fixturePrefix = `t3-public-http-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
const origin = "https://public-wedding.example.test";
const guestSecret = "public-http-fingerprint-secret-long-enough";
const challengeId = randomUUID().replaceAll("-", "").padEnd(43, "h");
const sessionToken = randomUUID().replaceAll("-", "").padEnd(43, "t");
const guestPhone = "+5511999999999";
const guestIp = "203.0.113.60";
let connection: DatabaseConnection;
let siteId: string;
let app: ReturnType<typeof createApp>;

function request(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Origin: origin,
      ...(init.headers ?? {}),
    },
  });
}

describe("public guest HTTP PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
    const created = await createSite(
      connection.db,
      {
        repositorySlug: `${fixturePrefix}-site`,
        provisioningKey: `${fixturePrefix}:key`,
        displayName: "Public Wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      fixedNow,
    );
    siteId = created.id;
    await connection.db
      .update(site)
      .set({ isDemo: true })
      .where(eq(site.id, siteId));
    await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      siteId,
      {
        name: "Família Silva",
        isForeign: false,
        phone: guestPhone,
        members: [
          { fullName: "Ana Silva", isRepresentative: true },
          { fullName: "Bia Silva", isRepresentative: false },
        ],
      },
      fixedNow,
    );
    await startReview(connection.db, siteId, {}, fixedNow);
    await approveReview(connection.db, siteId, {}, fixedNow);
    await connection.db.insert(siteOrigin).values({
      id: `${siteId}-origin`,
      siteId,
      origin,
    });
    const provider = {
      mode: "MOCK" as const,
      send: vi.fn().mockResolvedValue({
        status: "PROVIDER_ACCEPTED" as const,
        providerReference: "mock-http",
      }),
    };
    app = createApp({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
      guestFingerprintSecret: guestSecret,
      guestDemoGrantSecret: guestSecret,
      guestDemoPhoneAllowlist: [guestPhone],
      guestVerificationProvider: provider,
      guestCodeGenerator: () => "123456",
      guestChallengeIdGenerator: () => challengeId,
      guestSessionTokenGenerator: () => sessionToken,
      guestExposeSimulationCode: true,
      guestResolveClientIp: () => guestIp,
      now: () => fixedNow,
    } as AuthHttpOptions);
  });

  afterAll(async () => {
    const phoneFingerprint = createHmac("sha256", guestSecret)
      .update(`guest-phone:${guestPhone}`)
      .digest("hex");
    const ipFingerprint = createHmac("sha256", guestSecret)
      .update(`guest-ip:${guestIp}`)
      .digest("hex");
    await connection.db
      .delete(guestRateLimitEvent)
      .where(eq(guestRateLimitEvent.phoneFingerprint, phoneFingerprint));
    await connection.db
      .delete(guestRateLimitEvent)
      .where(eq(guestRateLimitEvent.ipFingerprint, ipFingerprint));
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.close();
  });

  it("allows only a registered origin and labels simulated delivery", async () => {
    const preflight = await request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(
      preflight.headers.get("Access-Control-Allow-Credentials"),
    ).toBeNull();

    const started = await request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DEMO_GUEST_GRANT_HEADER]: issueDemoGuestGrant({
            siteId,
            phoneE164: guestPhone,
            secret: guestSecret,
            now: fixedNow,
          }),
        },
        body: JSON.stringify({ fullName: "Ana Silva", phone: "11999999999" }),
      },
    );
    expect(started.status).toBe(201);
    expect(started.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const body = await started.json();
    expect(body).toMatchObject({
      challengeId,
      deliveryMode: "SIMULATED",
      simulationCode: "123456",
    });

    const evil = await app.request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fullName: "Ana Silva", phone: "11999999999" }),
      },
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps challenge/session errors CORS-safe and does not expose group data before verify", async () => {
    const tooSoon = await request(
      `/v1/public/guest/challenge/${challengeId}/resend`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId }),
      },
    );
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers.get("Retry-After")).toBe("60");
    expect(tooSoon.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const verified = await request(
      `/v1/public/guest/challenge/${challengeId}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, code: "123456" }),
      },
    );
    expect(verified.status).toBe(200);
    const session = await verified.json();
    expect(session.siteId).toBe(siteId);
    expect(session.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: "Ana Silva",
          isRepresentative: true,
        }),
        expect.objectContaining({
          fullName: "Bia Silva",
          isRepresentative: false,
        }),
      ]),
    );
    expect(session.groupName).toBeUndefined();
    expect(session.tokenHash).toBeUndefined();

    const read = await request("/v1/public/family/session", {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      siteId,
      groupId: session.groupId,
    });

    const malformedLeave = await request("/v1/public/family/session/leave", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: "{bad",
    });
    expect(malformedLeave.status).toBe(400);
    const preservedAfterMalformedLeave = await request(
      "/v1/public/family/session",
      { headers: { Authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(preservedAfterMalformedLeave.status).toBe(200);

    const left = await request("/v1/public/family/session/leave", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    expect(left.status).toBe(200);
    const replay = await request("/v1/public/family/session", {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const invalid = await request("/v1/public/family/session", {
      headers: { Authorization: `Bearer ${"z".repeat(43)}` },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const appWithoutIpResolver = createApp({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
      guestFingerprintSecret: guestSecret,
      guestVerificationProvider: {
        mode: "MOCK" as const,
        send: vi
          .fn()
          .mockResolvedValue({ status: "PROVIDER_ACCEPTED" as const }),
      },
      guestCodeGenerator: () => "123456",
      guestChallengeIdGenerator: () => "j".repeat(43),
      guestExposeSimulationCode: true,
      now: () => fixedNow,
    } as AuthHttpOptions);
    const spoofed = await appWithoutIpResolver.request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Forwarded-For": "198.51.100.99",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fullName: "Ana Silva", phone: "11999999999" }),
      },
    );
    expect(spoofed.status).toBe(503);
    expect((await spoofed.json()).code).toBe("CLIENT_IP_UNAVAILABLE");
  });
});
