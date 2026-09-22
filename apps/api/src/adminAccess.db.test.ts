import { createHash, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  account,
  adminAccessToken,
  session,
  site,
  siteMembership,
  user,
  verification,
} from "@entrelacos/database/schema";
import { verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_ACCESS_TTL_MS,
  consumeAdminAccess,
  createSiteAdmin,
  disableAdmin,
  issueAdminAccess,
  revokeAdminAccess,
} from "./adminAccess";
import { createAuth } from "./auth";
import { HANDOFF_RECOGNITION_IDENTIFIER, recognizeSite } from "./handoff";

const fixturePrefix = `t4-access-${process.pid}-${randomUUID()}`;
const fixtureNow = new Date("2026-09-11T12:00:00.000Z");
const accessPassword = "password10";
const ownerId = `${fixturePrefix}-owner`;
const fixtureUsers: string[] = [ownerId];
const fixtureSites: string[] = [];
const fixtureMemberships: string[] = [];
const fixtureSessions: string[] = [];
const fixtureVerification: string[] = [];
let connection: DatabaseConnection;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createSiteAdminFixture(
  tag: string,
  state: "PENDING" | "ACTIVE" = "PENDING",
) {
  const siteId = `${fixturePrefix}-${tag}-site`;
  const userId = `${fixturePrefix}-${tag}-user`;
  const membershipId = `${fixturePrefix}-${tag}-membership`;
  fixtureSites.push(siteId);
  fixtureUsers.push(userId);
  fixtureMemberships.push(membershipId);
  await connection.db.insert(site).values({
    id: siteId,
    repositorySlug: siteId,
    provisioningKey: `${siteId}:provision`,
    displayName: "Access fixture",
    partnerOneName: "Ana",
    partnerTwoName: "João",
    eventDate: "2027-05-22",
  });
  await connection.db.insert(user).values({
    id: userId,
    name: `Admin ${tag}`,
    email: `${userId}@example.test`,
    emailVerified: state === "ACTIVE",
    role: "SITE_ADMIN",
    state,
  });
  await connection.db.insert(siteMembership).values({
    id: membershipId,
    siteId,
    userId,
  });
  return { siteId, userId, membershipId };
}

async function sessionFor(userId: string, tag: string): Promise<string> {
  const id = `${fixturePrefix}-${tag}-session`;
  fixtureSessions.push(id);
  await connection.db.insert(session).values({
    id,
    userId,
    token: randomUUID(),
    expiresAt: new Date(fixtureNow.getTime() + 7 * 24 * 60 * 60_000),
    lastActiveAt: fixtureNow,
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
  });
  return id;
}

describe("administrative access PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Fixture Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
    });
  });

  afterAll(async () => {
    for (const id of fixtureVerification) {
      await connection.db.delete(verification).where(eq(verification.id, id));
    }
    for (const id of fixtureSessions) {
      await connection.db.delete(session).where(eq(session.id, id));
    }
    for (const userId of fixtureUsers) {
      await connection.db
        .delete(adminAccessToken)
        .where(eq(adminAccessToken.userId, userId));
      await connection.db.delete(account).where(eq(account.userId, userId));
    }
    for (const id of fixtureMemberships) {
      await connection.db
        .delete(siteMembership)
        .where(eq(siteMembership.id, id));
    }
    for (const id of fixtureSites) {
      await connection.db.delete(site).where(eq(site.id, id));
    }
    for (const userId of fixtureUsers) {
      await connection.db.delete(user).where(eq(user.id, userId));
    }
    await connection.close();
  });

  it("creates one pending membership, stores only a hash, and activates once", async () => {
    const fixture = await createSiteAdminFixture("activation");
    const issued = await issueAdminAccess(connection.db, {
      userId: fixture.userId,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    const [stored] = await connection.db
      .select({ tokenHash: adminAccessToken.tokenHash })
      .from(adminAccessToken)
      .where(eq(adminAccessToken.userId, fixture.userId));
    expect(stored?.tokenHash).toHaveLength(64);
    expect(stored?.tokenHash).not.toBe(issued.token);

    const consumed = await consumeAdminAccess(connection.db, {
      token: issued.token,
      password: accessPassword,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    expect(consumed).toMatchObject({
      userId: fixture.userId,
      siteId: fixture.siteId,
      purpose: "ACTIVATION",
    });
    const [activated] = await connection.db
      .select({ state: user.state })
      .from(user)
      .where(eq(user.id, fixture.userId));
    expect(activated?.state).toBe("ACTIVE");
    const [credential] = await connection.db
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, fixture.userId));
    await expect(
      verifyPassword({
        hash: credential?.password ?? "",
        password: accessPassword,
      }),
    ).resolves.toBe(true);
    const auth = createAuth({
      db: connection.db,
      secret: "test-only-t4-access-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin: "https://admin.example.test",
    });
    const login = await auth.handler(
      new Request("https://api.example.test/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          Origin: "https://admin.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: `${fixture.userId}@example.test`,
          password: accessPassword,
        }),
      }),
    );
    expect(login.status).toBe(200);
    await expect(
      consumeAdminAccess(connection.db, {
        token: issued.token,
        password: accessPassword,
        purpose: "ACTIVATION",
        now: fixtureNow,
      }),
    ).rejects.toThrow();
  });

  it("invalidates a previous issue and rejects expired tokens", async () => {
    const reissueFixture = await createSiteAdminFixture("reissue");
    const first = await issueAdminAccess(connection.db, {
      userId: reissueFixture.userId,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    const second = await issueAdminAccess(connection.db, {
      userId: reissueFixture.userId,
      purpose: "ACTIVATION",
      now: new Date(fixtureNow.getTime() + 1),
    });
    await expect(
      consumeAdminAccess(connection.db, {
        token: first.token,
        password: accessPassword,
        purpose: "ACTIVATION",
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    await expect(
      consumeAdminAccess(connection.db, {
        token: second.token,
        password: accessPassword,
        purpose: "ACTIVATION",
        now: new Date(fixtureNow.getTime() + 1),
      }),
    ).resolves.toMatchObject({ purpose: "ACTIVATION" });

    const expiredFixture = await createSiteAdminFixture("expired");
    const expired = await issueAdminAccess(connection.db, {
      userId: expiredFixture.userId,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    await expect(
      consumeAdminAccess(connection.db, {
        token: expired.token,
        password: accessPassword,
        purpose: "ACTIVATION",
        now: new Date(fixtureNow.getTime() + ADMIN_ACCESS_TTL_MS),
      }),
    ).rejects.toThrow();
  });

  it("recovers with atomic single use and revokes all sessions and recognition", async () => {
    const recoveryFixture = await createSiteAdminFixture("recovery");
    const activation = await issueAdminAccess(connection.db, {
      userId: recoveryFixture.userId,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    await consumeAdminAccess(connection.db, {
      token: activation.token,
      password: accessPassword,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    const parentSessionId = await sessionFor(
      recoveryFixture.userId,
      "recovery",
    );
    const recognitionToken = "r".repeat(43);
    const recognitionId = sha256(recognitionToken);
    fixtureVerification.push(recognitionId);
    await connection.db.insert(verification).values({
      id: recognitionId,
      identifier: HANDOFF_RECOGNITION_IDENTIFIER,
      value: JSON.stringify({
        siteId: recoveryFixture.siteId,
        origin: "https://fixture.example.test",
        parentSessionId,
      }),
      expiresAt: new Date(fixtureNow.getTime() + 60_000),
      createdAt: fixtureNow,
      updatedAt: fixtureNow,
    });
    const recovery = await issueAdminAccess(connection.db, {
      userId: recoveryFixture.userId,
      purpose: "RECOVERY",
      now: fixtureNow,
    });
    await expect(
      consumeAdminAccess(connection.db, {
        token: recovery.token,
        password: accessPassword,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
    ).resolves.toMatchObject({ purpose: "RECOVERY" });
    const sessions = await connection.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, recoveryFixture.userId));
    expect(sessions).toHaveLength(0);
    await expect(
      recognizeSite(connection.db, {
        recognitionToken,
        siteId: recoveryFixture.siteId,
        origin: "https://fixture.example.test",
        now: fixtureNow,
      }),
    ).resolves.toBe(false);

    const concurrentFixture = await createSiteAdminFixture("concurrent");
    const concurrentActivation = await issueAdminAccess(connection.db, {
      userId: concurrentFixture.userId,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    await consumeAdminAccess(connection.db, {
      token: concurrentActivation.token,
      password: accessPassword,
      purpose: "ACTIVATION",
      now: fixtureNow,
    });
    const concurrentRecovery = await issueAdminAccess(connection.db, {
      userId: concurrentFixture.userId,
      purpose: "RECOVERY",
      now: fixtureNow,
    });
    const attempts = await Promise.allSettled([
      consumeAdminAccess(connection.db, {
        token: concurrentRecovery.token,
        password: accessPassword,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
      consumeAdminAccess(connection.db, {
        token: concurrentRecovery.token,
        password: accessPassword,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
  });

  it("disables only site admins, revokes all credentials, and rejects owner targets", async () => {
    const fixture = await createSiteAdminFixture("disable", "ACTIVE");
    await sessionFor(fixture.userId, "disable");
    const recovery = await issueAdminAccess(connection.db, {
      userId: fixture.userId,
      purpose: "RECOVERY",
      now: fixtureNow,
    });
    await disableAdmin(connection.db, {
      userId: fixture.userId,
      now: fixtureNow,
    });
    await expect(
      consumeAdminAccess(connection.db, {
        token: recovery.token,
        password: accessPassword,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    const [disabled] = await connection.db
      .select({ state: user.state })
      .from(user)
      .where(eq(user.id, fixture.userId));
    expect(disabled?.state).toBe("DISABLED");
    await expect(
      issueAdminAccess(connection.db, {
        userId: ownerId,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
    ).rejects.toThrow();
  });

  it("normalizes email and creates exactly one membership", async () => {
    const fixture = await createSiteAdminFixture("create", "PENDING");
    const created = await createSiteAdmin(connection.db, {
      siteId: fixture.siteId,
      name: " New Admin ",
      email: "New.Admin@Example.Test",
      now: fixtureNow,
    });
    fixtureUsers.push(created.userId);
    const memberships = await connection.db
      .select({ id: siteMembership.id })
      .from(siteMembership)
      .where(eq(siteMembership.userId, created.userId));
    expect(created).toMatchObject({
      siteId: fixture.siteId,
      name: "New Admin",
      email: "new.admin@example.test",
      state: "PENDING",
    });
    expect(memberships).toHaveLength(1);
  });

  it("revokes a purpose without changing account state", async () => {
    const fixture = await createSiteAdminFixture("revoke", "ACTIVE");
    const issued = await issueAdminAccess(connection.db, {
      userId: fixture.userId,
      purpose: "RECOVERY",
      now: fixtureNow,
    });
    await revokeAdminAccess(connection.db, {
      userId: fixture.userId,
      purpose: "RECOVERY",
      now: fixtureNow,
    });
    await expect(
      consumeAdminAccess(connection.db, {
        token: issued.token,
        password: accessPassword,
        purpose: "RECOVERY",
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    const [active] = await connection.db
      .select({ state: user.state })
      .from(user)
      .where(eq(user.id, fixture.userId));
    expect(active?.state).toBe("ACTIVE");
  });
});
