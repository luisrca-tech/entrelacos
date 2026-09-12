import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  account,
  familySession,
  session,
  site,
  siteOrigin,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createAuth } from "./auth";
import type { AuthHttpOptions } from "./authHttp";
import { bootstrapOwner } from "./bootstrapOwner";
import { hashFamilySessionToken } from "./familySession";
import { createGuestGroup } from "./guestGroups";
import { approveReview, createSite, startReview } from "./sites";

const adminOrigin = "https://admin.example.test";
const fixturePrefix = `b4-rsvp-http-${process.pid}-${randomUUID().slice(0, 8)}`;
const publicOrigin = `https://${fixturePrefix}.example.test`;
const fixedNow = new Date("2026-09-13T12:00:00.000Z");
const familyToken = randomUUID().replaceAll("-", "").padEnd(43, "t");
const ownerPassword = randomUUID();

let connection: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let siteId: string;
let ownerId: string;
let cookie: string;
let memberId: string;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: adminOrigin,
      ...(init.headers ?? {}),
    },
  });
}

function publicRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: publicOrigin,
      Authorization: `Bearer ${familyToken}`,
      ...(init.headers ?? {}),
    },
  });
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected admin session cookie");
  return value.split(";", 1)[0] as string;
}

describe("RSVP HTTP PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const owner = await bootstrapOwner(connection.db, {
      email: `${fixturePrefix}@example.test`,
      name: "RSVP HTTP Owner",
      password: ownerPassword,
    });
    ownerId = owner.userId;
    const wedding = await createSite(
      connection.db,
      {
        repositorySlug: fixturePrefix,
        provisioningKey: `${fixturePrefix}:key`,
        displayName: "RSVP HTTP Wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      fixedNow,
    );
    siteId = wedding.id;
    const group = await createGuestGroup(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      {
        name: "Família Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      fixedNow,
    );
    memberId = group.members[0]?.id ?? "";
    await startReview(connection.db, siteId, {}, fixedNow);
    await approveReview(connection.db, siteId, {}, fixedNow);
    await connection.db.insert(siteOrigin).values({
      id: `${siteId}-origin`,
      siteId,
      origin: publicOrigin,
    });
    await connection.db.insert(familySession).values({
      id: `${siteId}-family-session`,
      siteId,
      groupId: group.id,
      tokenHash: hashFamilySessionToken(familyToken),
      expiresAt: new Date("2026-09-20T11:59:59.999Z"),
      createdAt: new Date("2026-09-13T11:59:59.999Z"),
    });

    const auth = createAuth({
      db: connection.db,
      secret: "rsvp-http-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin,
    });
    app = createApp({
      auth,
      authForDatabase: (db) =>
        createAuth({
          db,
          secret: "rsvp-http-auth-secret-that-is-long-enough",
          baseURL: "https://api.example.test",
          adminOrigin,
        }),
      db: connection.db,
      adminOrigin,
      now: () => fixedNow,
    } as AuthHttpOptions);
    const login = await app.request(
      request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `${fixturePrefix}@example.test`,
          password: ownerPassword,
        }),
      }),
    );
    expect(login.status).toBe(200);
    cookie = sessionCookie(login);
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    if (ownerId) {
      await connection.db.delete(session).where(eq(session.userId, ownerId));
      await connection.db.delete(account).where(eq(account.userId, ownerId));
      await connection.db.delete(user).where(eq(user.id, ownerId));
    }
    await connection.close();
  });

  it("serves admin and family RSVP routes through the real database boundary", async () => {
    const adminRead = await app.request(
      request(`/v1/sites/${siteId}/rsvp`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(adminRead.status).toBe(200);
    expect(adminRead.headers.get("cache-control")).toBe("no-store");
    expect((await adminRead.json()).totals).toEqual({
      pending: 1,
      confirmed: 0,
      declined: 0,
    });

    const familyRead = await app.request(
      publicRequest("/v1/public/family/rsvp"),
    );
    expect(familyRead.status).toBe(200);
    expect(familyRead.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    const initial = await familyRead.json();
    expect(initial.members).toEqual([
      expect.objectContaining({ id: memberId, state: "PENDING", revision: 0 }),
    ]);

    const update = await app.request(
      publicRequest("/v1/public/family/rsvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: randomUUID(),
          members: [{ memberId, state: "CONFIRMED", expectedRevision: 0 }],
        }),
      }),
    );
    expect(update.status).toBe(200);
    expect((await update.json()).members).toEqual([
      expect.objectContaining({
        id: memberId,
        state: "CONFIRMED",
        revision: 1,
      }),
    ]);

    const stale = await app.request(
      publicRequest("/v1/public/family/rsvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: randomUUID(),
          members: [{ memberId, state: "DECLINED", expectedRevision: 0 }],
        }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "RSVP_CONFLICT",
      details: { members: [{ id: memberId, state: "CONFIRMED", revision: 1 }] },
    });

    const history = await app.request(
      request(`/v1/sites/${siteId}/rsvp/history`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(history.status).toBe(200);
    expect((await history.json()).entries).toEqual([
      expect.objectContaining({
        memberId,
        actorType: "FAMILY",
        afterState: "CONFIRMED",
      }),
    ]);
  });

  it("does not return family data for an unregistered origin", async () => {
    const response = await app.request(
      publicRequest("/v1/public/family/rsvp", {}),
    );
    expect(response.status).toBe(200);

    const hostile = await app.request(
      new Request("https://api.example.test/v1/public/family/rsvp", {
        headers: {
          Origin: "https://evil.example.test",
          Authorization: `Bearer ${familyToken}`,
        },
      }),
    );
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await hostile.text()).not.toContain(memberId);
  });

  it("rejects expired and revoked family sessions without leaking data", async () => {
    await connection.db
      .update(familySession)
      .set({ expiresAt: fixedNow })
      .where(eq(familySession.siteId, siteId));
    const expired = await app.request(publicRequest("/v1/public/family/rsvp"));
    expect(expired.status).toBe(401);
    expect(expired.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(await expired.text()).not.toContain(memberId);

    await connection.db
      .update(familySession)
      .set({
        expiresAt: new Date("2026-09-20T11:59:59.999Z"),
        revokedAt: fixedNow,
      })
      .where(eq(familySession.siteId, siteId));
    const revoked = await app.request(publicRequest("/v1/public/family/rsvp"));
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(memberId);
  });
});
