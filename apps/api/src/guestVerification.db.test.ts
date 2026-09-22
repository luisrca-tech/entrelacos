import { createHmac } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familySession,
  guestRateLimitEvent,
  guestVerificationChallenge,
  site,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAMILY_SESSION_TTL_MS,
  leaveFamilySession,
  readFamilySession,
} from "./familySession";
import {
  createGuestGroup,
  getGuestGroupAccessPin,
  rotateGuestGroupAccessPin,
} from "./guestGroups";
import { startGuestChallenge, verifyGuestChallenge } from "./guestVerification";
import { approveReview, createSite, startReview } from "./sites";

const prefix = `pin-verification-${process.pid}`;
const now = new Date("2028-02-29T12:00:00.000Z");
const secret = "guest-verification-db-secret-with-at-least-32-characters";
const phone = "+5511999999999";
let connection: DatabaseConnection;
const siteIds: string[] = [];
const verificationIps = new Set<string>();

function options(ip: string, challengeId: string, sessionToken?: string) {
  verificationIps.add(ip);
  return {
    ipAddress: ip,
    fingerprintSecret: secret,
    now,
    challengeIdGenerator: () => challengeId,
    sessionTokenGenerator: sessionToken ? () => sessionToken : undefined,
  };
}

function ipFingerprint(ip: string): string {
  return createHmac("sha256", secret).update(`guest-ip:${ip}`).digest("hex");
}

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
  const group = await createGuestGroup(
    connection.db,
    { userId: "owner", role: "OWNER" },
    wedding.id,
    {
      name: "Família Silva",
      isForeign: false,
      phone,
      members: [{ fullName: "Ana Silva", isRepresentative: true }],
    },
    now,
  );
  await startReview(connection.db, wedding.id, {}, now);
  await approveReview(connection.db, wedding.id, {}, now);
  return { wedding, group };
}

describe("manual guest PIN verification PostgreSQL boundary", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
  });

  afterAll(async () => {
    for (const siteId of siteIds)
      await connection.db.delete(site).where(eq(site.id, siteId));
    for (const ip of verificationIps) {
      await connection.db
        .delete(guestRateLimitEvent)
        .where(eq(guestRateLimitEvent.ipFingerprint, ipFingerprint(ip)));
    }
    await connection.close();
  });

  it("requires the registered name and phone, then creates a family session", async () => {
    const { wedding, group } = await fixture("identity");
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "áNA   SILVA", phone: "(11) 99999-9999" },
      options("2001:db8::1", "c".repeat(43)),
    );
    expect(challenge).toMatchObject({
      challengeId: "c".repeat(43),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });

    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: "+5511999999998" },
        options("2001:db8::2", "d".repeat(43)),
      ),
    ).rejects.toMatchObject({ status: 404, code: "GUEST_NOT_FOUND" });

    const pin = (
      await getGuestGroupAccessPin(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
        secret,
      )
    ).accessPin;
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "000000" },
        options("2001:db8::1", "x".repeat(43)),
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_CODE" });
    const session = await verifyGuestChallenge(
      connection.db,
      challenge.challengeId,
      { challengeId: challenge.challengeId, code: pin },
      options("2001:db8::3", "x".repeat(43), "s".repeat(43)),
    );
    expect(session).toMatchObject({
      siteId: wedding.id,
      groupId: group.id,
      sessionToken: "s".repeat(43),
    });
    expect(new Date(session.expiresAt).getTime()).toBe(
      now.getTime() + FAMILY_SESSION_TTL_MS,
    );
    await expect(
      readFamilySession(connection.db, session.sessionToken, now),
    ).resolves.toMatchObject({ siteId: wedding.id, groupId: group.id });
    await expect(
      readFamilySession(
        connection.db,
        session.sessionToken,
        new Date(now.getTime() + FAMILY_SESSION_TTL_MS),
      ),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
  });

  it("expires challenges and locks after five wrong PIN attempts", async () => {
    const { wedding } = await fixture("cooldown");
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::10", "e".repeat(43)),
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        verifyGuestChallenge(
          connection.db,
          challenge.challengeId,
          { challengeId: challenge.challengeId, code: "000000" },
          options(`2001:db8::${11 + attempt}`, "f".repeat(43)),
        ),
      ).rejects.toMatchObject({ status: 401, code: "INVALID_CODE" });
    }
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "000000" },
        options("2001:db8::15", "g".repeat(43)),
      ),
    ).rejects.toMatchObject({ status: 429, code: "CHALLENGE_COOLDOWN" });
    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone },
        options("2001:db8::16", "z".repeat(43)),
      ),
    ).rejects.toMatchObject({ status: 429, code: "CHALLENGE_COOLDOWN" });

    const { wedding: expiredWedding } = await fixture("expiry");
    const expired = await startGuestChallenge(
      connection.db,
      expiredWedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::20", "h".repeat(43)),
    );
    await expect(
      verifyGuestChallenge(
        connection.db,
        expired.challengeId,
        { challengeId: expired.challengeId, code: "000000" },
        {
          ...options("2001:db8::21", "i".repeat(43)),
          now: new Date(now.getTime() + 10 * 60_000),
        },
      ),
    ).rejects.toMatchObject({ status: 410, code: "CHALLENGE_EXPIRED" });
  });

  it("revokes superseded challenges, rotated PINs, and family sessions", async () => {
    const { wedding, group } = await fixture("rotation");
    const first = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::30", "j".repeat(43)),
    );
    const second = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::31", "k".repeat(43)),
    );
    const [revoked] = await connection.db
      .select({ status: guestVerificationChallenge.status })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, first.challengeId));
    expect(revoked?.status).toBe("REVOKED");

    const pin = (
      await getGuestGroupAccessPin(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
        secret,
      )
    ).accessPin;
    const session = await verifyGuestChallenge(
      connection.db,
      second.challengeId,
      { challengeId: second.challengeId, code: pin },
      options("2001:db8::32", "l".repeat(43), "m".repeat(43)),
    );
    await rotateGuestGroupAccessPin(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      group.id,
      secret,
      now,
    );
    await expect(
      readFamilySession(connection.db, session.sessionToken, now),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
  });

  it("allows explicit leave after the site becomes inactive", async () => {
    const { wedding, group } = await fixture("leave-inactive");
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::40", "l".repeat(43)),
    );
    const pin = (
      await getGuestGroupAccessPin(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
        secret,
      )
    ).accessPin;
    const session = await verifyGuestChallenge(
      connection.db,
      challenge.challengeId,
      { challengeId: challenge.challengeId, code: pin },
      options("2001:db8::41", "m".repeat(43), "n".repeat(43)),
    );
    await connection.db
      .update(site)
      .set({ lifecycle: "INACTIVE", previousLifecycle: "ACTIVE" })
      .where(eq(site.id, wedding.id));
    await expect(
      leaveFamilySession(connection.db, session.sessionToken, now),
    ).resolves.toEqual({ ok: true });
  });

  it("allows only one concurrent PIN verification to create a session", async () => {
    const { wedding, group } = await fixture("concurrent");
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone },
      options("2001:db8::50", "o".repeat(43)),
    );
    const pin = (
      await getGuestGroupAccessPin(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
        secret,
      )
    ).accessPin;
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        verifyGuestChallenge(
          connection.db,
          challenge.challengeId,
          { challengeId: challenge.challengeId, code: pin },
          options("2001:db8::51", "p".repeat(43), "q".repeat(43)),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await connection.db
        .select()
        .from(familySession)
        .where(eq(familySession.groupId, group.id)),
    ).toHaveLength(1);
  });

  it("propagates the PIN verification rate limit", async () => {
    const ip = "2001:db8::60";
    const challengeId = "r".repeat(43);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        verifyGuestChallenge(
          connection.db,
          challengeId,
          { challengeId, code: "000000" },
          options(ip, "s".repeat(43)),
        ),
      ).rejects.toMatchObject({ status: 404, code: "CHALLENGE_NOT_FOUND" });
    }
    await expect(
      verifyGuestChallenge(
        connection.db,
        challengeId,
        { challengeId, code: "000000" },
        options(ip, "t".repeat(43)),
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "PIN_VERIFY_RATE_LIMITED",
    });
  });
});
