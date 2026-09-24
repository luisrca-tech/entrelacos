import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitationRateLimitEvent,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import {
  INVITATION_ACCESS_WINDOW_MS,
  INVITATION_SESSION_TTL_MS,
  leaveInvitationSession,
  readInvitationSession,
  startInvitationSession,
} from "./guestVerification";
import {
  createInvitation,
  getInvitationAccessPin,
  rotateInvitationAccessPin,
} from "./invitations";
import { approveReview, createSite, startReview } from "./sites";

const prefix = `invitation-access-${process.pid}`;
const now = new Date("2028-02-29T12:00:00.000Z");
const secret = "invitation-access-test-secret-with-at-least-32-characters";
const actor = { userId: "owner", role: "OWNER" as const };
const phone = "+5511999999999";
let connection: DatabaseConnection;
const siteIds: string[] = [];

async function fixture(label: string) {
  const wedding = await createSite(
    connection.db,
    {
      repositorySlug: `${prefix}-${label}`,
      provisioningKey: `${prefix}:key-${label}`,
      displayName: `Wedding ${label}`,
      coupleNames: ["Ana", "João"],
      eventDate: "2029-06-10",
    },
    now,
  );
  siteIds.push(wedding.id);
  const origin = `https://${wedding.id}.invitation-access.example.test`;
  const createdInvitation = await createInvitation(
    connection.db,
    actor,
    wedding.id,
    {
      name: "Família Silva",
      phone,
      guests: [
        { fullName: "Ana Silva", guestType: "ADULT" },
        { fullName: "Bia Silva", guestType: "CHILD" },
      ],
    },
    now,
  );
  await startReview(connection.db, wedding.id, {}, now);
  await approveReview(connection.db, wedding.id, {}, now);
  await connection.db.insert(siteOrigin).values({
    id: `${wedding.id}-origin`,
    siteId: wedding.id,
    origin,
  });
  const accessPin = (
    await getInvitationAccessPin(
      connection.db,
      actor,
      wedding.id,
      createdInvitation.id,
      secret,
    )
  ).accessPin;
  return { wedding, invitation: createdInvitation, accessPin, origin };
}

function verificationOptions(ipAddress: string, sessionToken?: string) {
  return {
    ipAddress,
    fingerprintSecret: secret,
    now,
    sessionTokenGenerator: sessionToken ? () => sessionToken : undefined,
  };
}

describe("public invitation access PostgreSQL boundary", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
  });

  afterAll(async () => {
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    await connection.close();
  });

  it("creates, reads, and revokes a site-scoped invitation session", async () => {
    const { wedding, invitation, accessPin } = await fixture("session");
    const created = await startInvitationSession(
      connection.db,
      wedding.id,
      { phone: "(11) 99999-9999", accessPin },
      verificationOptions("2001:db8::1", "s".repeat(43)),
    );

    expect(created).toMatchObject({
      siteId: wedding.id,
      invitationId: invitation.id,
      invitationName: "Família Silva",
      sessionToken: "s".repeat(43),
    });
    expect(created.guests).toHaveLength(2);
    expect(created.guests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: "Ana Silva",
          guestType: "ADULT",
        }),
        expect.objectContaining({
          fullName: "Bia Silva",
          guestType: "CHILD",
        }),
      ]),
    );
    expect(new Date(created.expiresAt).getTime()).toBe(
      now.getTime() + INVITATION_SESSION_TTL_MS,
    );
    await expect(
      readInvitationSession(connection.db, created.sessionToken, now),
    ).resolves.toMatchObject({ invitationId: invitation.id });
    await leaveInvitationSession(connection.db, created.sessionToken, now);
    await expect(
      readInvitationSession(connection.db, created.sessionToken, now),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
  });

  it("uses the same credential error for unknown phones, wrong PINs, and locked invitations", async () => {
    const { wedding, invitation, accessPin } = await fixture("lockout");
    const unknownPhone = {
      phone: "+5511999999998",
      accessPin: "000000",
    };
    const wrongPin = {
      phone,
      accessPin: accessPin === "000000" ? "000001" : "000000",
    };

    await expect(
      startInvitationSession(
        connection.db,
        wedding.id,
        unknownPhone,
        verificationOptions("2001:db8::10"),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        startInvitationSession(
          connection.db,
          wedding.id,
          wrongPin,
          verificationOptions(`2001:db8::${20 + attempt}`),
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: "INVITATION_ACCESS_INVALID",
        title: "Phone or access PIN is invalid",
      });
    }
    await expect(
      startInvitationSession(
        connection.db,
        wedding.id,
        { phone, accessPin },
        verificationOptions("2001:db8::26"),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    });

    const rotated = await rotateInvitationAccessPin(
      connection.db,
      actor,
      wedding.id,
      invitation.id,
      secret,
      new Date(now.getTime() + 1_000),
    );
    await expect(
      startInvitationSession(
        connection.db,
        wedding.id,
        { phone, accessPin: rotated.accessPin },
        {
          ...verificationOptions("2001:db8::27"),
          now: new Date(now.getTime() + 2_000),
        },
      ),
    ).resolves.toMatchObject({ invitationId: invitation.id });
  });

  it("applies a client-IP rate limit independently of invitation lookup", async () => {
    const { wedding } = await fixture("rate-limit");
    const otherSite = await fixture("rate-limit-other-site");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        startInvitationSession(
          connection.db,
          wedding.id,
          { phone: "+5511999999998", accessPin: "000000" },
          verificationOptions("2001:db8::50"),
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: "INVITATION_ACCESS_INVALID",
      });
    }
    await expect(
      startInvitationSession(
        connection.db,
        wedding.id,
        { phone, accessPin: "000000" },
        verificationOptions("2001:db8::50"),
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "INVITATION_ACCESS_RATE_LIMITED",
      retryAfterSeconds: expect.any(Number),
    });
    await expect(
      startInvitationSession(
        connection.db,
        otherSite.wedding.id,
        { phone: "+5511999999998", accessPin: "000000" },
        verificationOptions("2001:db8::50"),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
    });
  });

  it("prunes expired access-rate events when processing a new attempt", async () => {
    const { wedding } = await fixture("rate-prune");
    const expiredId = `${wedding.id}-expired-rate`;
    await connection.db.insert(invitationRateLimitEvent).values({
      id: expiredId,
      siteId: wedding.id,
      invitationId: null,
      action: "PIN_VERIFY",
      scopeKey: "expired-test-scope",
      ipFingerprint: "a".repeat(64),
      phoneFingerprint: "b".repeat(64),
      occurredAt: new Date(now.getTime() - INVITATION_ACCESS_WINDOW_MS - 1),
    });

    await expect(
      startInvitationSession(
        connection.db,
        wedding.id,
        { phone: "+5511999999998", accessPin: "000000" },
        verificationOptions("2001:db8::60"),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await connection.db
        .select({ id: invitationRateLimitEvent.id })
        .from(invitationRateLimitEvent)
        .where(eq(invitationRateLimitEvent.id, expiredId)),
    ).toEqual([]);
  });

  it("serves canonical access and session routes and leaves legacy routes unmounted", async () => {
    const { wedding, invitation, accessPin, origin } = await fixture("http");
    const app = createApp({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
      guestFingerprintSecret: secret,
      guestSessionTokenGenerator: () => "h".repeat(43),
      guestResolveClientIp: () => "203.0.113.80",
      now: () => now,
    });
    const access = await app.request(
      `/v1/public/sites/${wedding.id}/invitation/access`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ phone, accessPin }),
      },
    );
    expect(access.status).toBe(200);
    expect(access.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const session = await access.json();
    expect(session).toMatchObject({
      invitationId: invitation.id,
      sessionToken: "h".repeat(43),
    });

    const read = await app.request("/v1/public/invitation/session", {
      headers: {
        Origin: origin,
        Authorization: `Bearer ${session.sessionToken}`,
      },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ invitationId: invitation.id });

    const left = await app.request("/v1/public/invitation/session/leave", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${session.sessionToken}`,
      },
    });
    expect(left.status).toBe(200);

    const legacyPaths = [
      `/v1/public/sites/${wedding.id}/guest/challenge`,
      "/v1/public/guest/challenge/opaque-id/verify",
      "/v1/public/family/session",
    ];
    for (const path of legacyPaths) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
