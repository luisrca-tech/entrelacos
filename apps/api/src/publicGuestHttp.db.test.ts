import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { site, siteOrigin } from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createGuestGroup, getGuestGroupAccessPin } from "./guestGroups";
import { approveReview, createSite, startReview } from "./sites";

const prefix = `pin-public-http-${process.pid}`;
const now = new Date("2028-02-29T12:00:00.000Z");
const secret = "public-guest-fingerprint-secret-with-at-least-32-characters";
const publicOrigin = "https://pin-public.example.test";
const phone = "+5511999999999";
let connection: DatabaseConnection;
let siteId: string;
let currentIp = "203.0.113.80";
const lookupRateLimitIp = "203.0.113.90";
let app: ReturnType<typeof createApp>;
let testPin: string;

describe("manual guest PIN HTTP boundary", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    const wedding = await createSite(
      connection.db,
      {
        repositorySlug: `${prefix}-site`,
        provisioningKey: `${prefix}:key`,
        displayName: "Public Wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      now,
    );
    siteId = wedding.id;
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      siteId,
      {
        name: "Família Silva",
        isForeign: false,
        phone,
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      now,
    );
    await startReview(connection.db, siteId, {}, now);
    await approveReview(connection.db, siteId, {}, now);
    await connection.db.insert(siteOrigin).values({
      id: `${siteId}-origin`,
      siteId,
      origin: publicOrigin,
    });
    testPin = (
      await getGuestGroupAccessPin(
        connection.db,
        { userId: "owner", role: "OWNER" },
        siteId,
        group.id,
        secret,
      )
    ).accessPin;
    app = createApp({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
      guestFingerprintSecret: secret,
      guestChallengeIdGenerator: () => "n".repeat(43),
      guestSessionTokenGenerator: () => "o".repeat(43),
      guestResolveClientIp: () => currentIp,
      now: () => now,
    });
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.close();
  });

  it("supports registered-origin PIN verification and removes resend/provider routes", async () => {
    const preflight = await app.request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "OPTIONS",
        headers: {
          Origin: publicOrigin,
          "Access-Control-Request-Method": "POST",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(preflight.headers.get("Access-Control-Allow-Headers")).not.toContain(
      "Demo",
    );

    const started = await app.request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "POST",
        headers: { Origin: publicOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: "Ana Silva", phone }),
      },
    );
    expect(started.status).toBe(201);
    const challenge = await started.json();
    expect(challenge).toMatchObject({ challengeId: "n".repeat(43) });
    expect(challenge).not.toHaveProperty("deliveryMode");
    expect(challenge).not.toHaveProperty("resendAvailableAt");

    const resend = await app.request(
      `/v1/public/guest/challenge/${challenge.challengeId}/resend`,
      {
        method: "POST",
        headers: { Origin: publicOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId }),
      },
    );
    expect(resend.status).toBe(404);

    currentIp = "203.0.113.81";
    const verified = await app.request(
      `/v1/public/guest/challenge/${challenge.challengeId}/verify`,
      {
        method: "POST",
        headers: { Origin: publicOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code: testPin,
        }),
      },
    );
    expect(verified.status).toBe(200);
    const session = await verified.json();
    expect(session).toMatchObject({
      siteId,
      sessionToken: "o".repeat(43),
    });

    const read = await app.request("/v1/public/family/session", {
      headers: {
        Origin: publicOrigin,
        Authorization: `Bearer ${session.sessionToken}`,
      },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      siteId,
      groupId: session.groupId,
    });

    const invalidBearer = await app.request("/v1/public/family/session", {
      headers: {
        Origin: publicOrigin,
        Authorization: `Bearer ${"z".repeat(43)}`,
      },
    });
    expect(invalidBearer.status).toBe(401);
    expect(invalidBearer.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );

    const left = await app.request("/v1/public/family/session/leave", {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        Authorization: `Bearer ${session.sessionToken}`,
      },
    });
    expect(left.status).toBe(200);
    const replay = await app.request("/v1/public/family/session", {
      headers: {
        Origin: publicOrigin,
        Authorization: `Bearer ${session.sessionToken}`,
      },
    });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
  });

  it("rejects an unregistered origin before exposing guest data", async () => {
    const response = await app.request(
      `/v1/public/sites/${siteId}/guest/challenge`,
      {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fullName: "Ana Silva", phone }),
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("propagates lookup rate limits with CORS-safe errors", async () => {
    const rateLimitApp = createApp({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
      guestFingerprintSecret: secret,
      guestResolveClientIp: () => lookupRateLimitIp,
      now: () => now,
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await rateLimitApp.request(
        `/v1/public/sites/${siteId}/guest/challenge`,
        {
          method: "POST",
          headers: {
            Origin: publicOrigin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fullName: "Missing Guest",
            phone: "+5511999999998",
          }),
        },
      );
      statuses.push(response.status);
      if (attempt === 10) {
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
          publicOrigin,
        );
        expect(response.headers.get("Retry-After")).toBe("900");
        await expect(response.json()).resolves.toMatchObject({
          code: "LOOKUP_RATE_LIMITED",
          status: 429,
        });
      }
    }
    expect(statuses).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404, 404, 404, 429,
    ]);
  });
});
