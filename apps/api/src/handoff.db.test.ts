import { createHash, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { session, user, verification } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HANDOFF_CHALLENGE_IDENTIFIER,
  HANDOFF_RECOGNITION_IDENTIFIER,
  issueHandoff,
  type RedeemedHandoff,
  recognizeSite,
  redeemHandoff,
} from "./handoff";

const fixturePrefix = `t2-handoff-${process.pid}`;
const fixtureUserId = `${fixturePrefix}-user`;
const fixtureSessionId = `${fixturePrefix}-session`;
const fixtureSiteId = `${fixturePrefix}-site`;
const fixtureOrigin = "https://handoff.example.test";
const fixtureVerifier = "v".repeat(43);
const fixtureNow = new Date();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let connection: DatabaseConnection;
const issuedCodes: string[] = [];
const recognitionTokens: string[] = [];

describe("handoff PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);

    await connection.db.insert(user).values({
      id: fixtureUserId,
      name: "Handoff Fixture",
      email: `${fixturePrefix}@example.test`,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
    });
    await connection.db.insert(session).values({
      id: fixtureSessionId,
      userId: fixtureUserId,
      token: randomUUID(),
      expiresAt: new Date(fixtureNow.getTime() + 7 * 24 * 60 * 60_000),
      lastActiveAt: new Date(fixtureNow.getTime() - 60_000),
      createdAt: new Date(fixtureNow.getTime() - 60 * 60_000),
      updatedAt: fixtureNow,
    });
  });

  afterAll(async () => {
    for (const issuedCode of issuedCodes) {
      await connection.db
        .delete(verification)
        .where(
          and(
            eq(verification.id, sha256(issuedCode)),
            eq(verification.identifier, HANDOFF_CHALLENGE_IDENTIFIER),
          ),
        );
    }
    for (const recognitionToken of recognitionTokens) {
      await connection.db
        .delete(verification)
        .where(
          and(
            eq(verification.id, sha256(recognitionToken)),
            eq(verification.identifier, HANDOFF_RECOGNITION_IDENTIFIER),
          ),
        );
    }
    await connection.db.delete(session).where(eq(session.id, fixtureSessionId));
    await connection.db.delete(user).where(eq(user.id, fixtureUserId));
    await connection.close();
  });

  it("persists one-use handoff and site-bound recognition without activity refresh", async () => {
    const [beforeSession] = await connection.db
      .select({ lastActiveAt: session.lastActiveAt })
      .from(session)
      .where(eq(session.id, fixtureSessionId))
      .limit(1);
    const issued = await issueHandoff(connection.db, {
      siteId: fixtureSiteId,
      origin: fixtureOrigin,
      parentSessionId: fixtureSessionId,
      challenge: sha256(fixtureVerifier),
      now: fixtureNow,
    });
    issuedCodes.push(issued.code);

    const [storedChallenge] = await connection.db
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.id, sha256(issued.code)))
      .limit(1);
    expect(storedChallenge?.value).not.toContain(fixtureVerifier);

    await expect(
      redeemHandoff(connection.db, {
        code: issued.code,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        verifier: "x".repeat(43),
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    await expect(
      redeemHandoff(connection.db, {
        code: issued.code,
        siteId: `${fixtureSiteId}-other`,
        origin: fixtureOrigin,
        verifier: fixtureVerifier,
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    await expect(
      redeemHandoff(connection.db, {
        code: issued.code,
        siteId: fixtureSiteId,
        origin: "https://other.example.test",
        verifier: fixtureVerifier,
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    const redeemed = await redeemHandoff(connection.db, {
      code: issued.code,
      siteId: fixtureSiteId,
      origin: fixtureOrigin,
      verifier: fixtureVerifier,
      now: fixtureNow,
    });
    recognitionTokens.push(redeemed.recognitionToken);

    await expect(
      redeemHandoff(connection.db, {
        code: issued.code,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        verifier: fixtureVerifier,
        now: fixtureNow,
      }),
    ).rejects.toThrow();
    await expect(
      recognizeSite(connection.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        now: fixtureNow,
      }),
    ).resolves.toBe(true);

    const [afterSession] = await connection.db
      .select({ lastActiveAt: session.lastActiveAt })
      .from(session)
      .where(eq(session.id, fixtureSessionId))
      .limit(1);
    expect(afterSession?.lastActiveAt).toEqual(beforeSession?.lastActiveAt);

    const recognitionRowsForFixture = async () =>
      (
        await connection.db
          .select({ id: verification.id, value: verification.value })
          .from(verification)
          .where(eq(verification.identifier, HANDOFF_RECOGNITION_IDENTIFIER))
      ).filter((row) => {
        try {
          return (
            (JSON.parse(row.value) as { parentSessionId?: unknown })
              .parentSessionId === fixtureSessionId
          );
        } catch {
          return false;
        }
      });
    const beforeConcurrentRecognitions = await recognitionRowsForFixture();
    const concurrentIssued = await issueHandoff(connection.db, {
      siteId: fixtureSiteId,
      origin: fixtureOrigin,
      parentSessionId: fixtureSessionId,
      challenge: sha256(fixtureVerifier),
      now: fixtureNow,
    });
    issuedCodes.push(concurrentIssued.code);
    const concurrentAttempts = await Promise.allSettled([
      redeemHandoff(connection.db, {
        code: concurrentIssued.code,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        verifier: fixtureVerifier,
        now: fixtureNow,
      }),
      redeemHandoff(connection.db, {
        code: concurrentIssued.code,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        verifier: fixtureVerifier,
        now: fixtureNow,
      }),
    ]);
    const concurrentSuccesses = concurrentAttempts.filter(
      (attempt): attempt is PromiseFulfilledResult<RedeemedHandoff> =>
        attempt.status === "fulfilled",
    );
    expect(concurrentSuccesses).toHaveLength(1);
    recognitionTokens.push(concurrentSuccesses[0].value.recognitionToken);
    const concurrentRecognitions = await recognitionRowsForFixture();
    expect(concurrentRecognitions).toHaveLength(
      beforeConcurrentRecognitions.length + 1,
    );

    await connection.db.delete(session).where(eq(session.id, fixtureSessionId));
    await expect(
      recognizeSite(connection.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId: fixtureSiteId,
        origin: fixtureOrigin,
        now: fixtureNow,
      }),
    ).resolves.toBe(false);
  });
});
