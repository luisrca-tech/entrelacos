import { createHash } from "node:crypto";
import {
  accountState,
  session,
  user,
  verification,
} from "@entrelacos/database/schema";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ABSOLUTE_TTL_MS,
  ADMIN_IDLE_TTL_MS,
  HANDOFF_CHALLENGE_IDENTIFIER,
  HANDOFF_RECOGNITION_IDENTIFIER,
  HANDOFF_TTL_MS,
  isAdminSessionActive,
  issueHandoff,
  RECOGNITION_TTL_MS,
  recognizeSite,
  redeemHandoff,
} from "./handoff";

const siteId = "site-demo";
const origin = "https://demo.example.test";
const parentSessionId = "session-owner";
const now = new Date("2026-09-11T12:00:00.000Z");
const verifier = "v".repeat(43);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activeSession() {
  return {
    id: parentSessionId,
    userId: "owner-1",
    expiresAt: new Date("2026-09-18T12:00:00.000Z"),
    lastActiveAt: new Date("2026-09-11T11:00:00.000Z"),
    createdAt: new Date("2026-09-10T12:00:00.000Z"),
  };
}

function createFakeDatabase() {
  const verificationRows: Record<string, unknown>[] = [];
  const sessions = [activeSession()];
  const users: Array<{
    id: string;
    state: "PENDING" | "ACTIVE" | "DISABLED";
  }> = [{ id: "owner-1", state: "ACTIVE" }];
  let allowDelete = true;

  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
    ),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === verification) return verificationRows;
            if (table === session) return sessions;
            if (table === user) return users;
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        if (table === verification) verificationRows.push(value);
      }),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          if (table !== verification) return [];
          if (!allowDelete) return [];
          const [removed] = verificationRows.splice(0, 1);
          return removed ? [{ id: removed.id }] : [];
        }),
      })),
    })),
  };

  return {
    db: db as never,
    verificationRows,
    sessions,
    users,
    preventDelete: () => {
      allowDelete = false;
    },
  };
}

describe("handoff core", () => {
  it("enforces active, idle, and absolute administrative session boundaries", () => {
    const snapshot = {
      accountState: "ACTIVE" as const,
      expiresAt: new Date(now.getTime() + 60_000),
      lastActiveAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 60_000),
    };

    expect(isAdminSessionActive(snapshot, now)).toBe(true);
    expect(
      isAdminSessionActive(
        {
          ...snapshot,
          lastActiveAt: new Date(now.getTime() - ADMIN_IDLE_TTL_MS),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isAdminSessionActive(
        {
          ...snapshot,
          createdAt: new Date(now.getTime() - ADMIN_ABSOLUTE_TTL_MS),
        },
        now,
      ),
    ).toBe(false);
  });

  it("issues a short-lived hashed single-use handoff record", async () => {
    const fixture = createFakeDatabase();
    const result = await issueHandoff(fixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });

    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toEqual(new Date("2026-09-11T12:01:00.000Z"));
    expect(fixture.verificationRows).toHaveLength(1);
    expect(fixture.verificationRows[0]).toMatchObject({
      id: sha256(result.code),
      identifier: HANDOFF_CHALLENGE_IDENTIFIER,
    });
    expect(String(fixture.verificationRows[0].value)).not.toContain(verifier);
    expect(JSON.parse(String(fixture.verificationRows[0].value))).toEqual({
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
    });
  });

  it("rejects handoff and recognition at their expiration boundaries", async () => {
    const handoffFixture = createFakeDatabase();
    const issued = await issueHandoff(handoffFixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });

    await expect(
      redeemHandoff(handoffFixture.db, {
        code: issued.code,
        siteId,
        origin,
        verifier,
        now: new Date(now.getTime() + HANDOFF_TTL_MS),
      }),
    ).rejects.toThrow();

    const recognitionFixture = createFakeDatabase();
    const recognitionHandoff = await issueHandoff(recognitionFixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });
    const redeemed = await redeemHandoff(recognitionFixture.db, {
      code: recognitionHandoff.code,
      siteId,
      origin,
      verifier,
      now,
    });

    await expect(
      recognizeSite(recognitionFixture.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId,
        origin,
        now: new Date(now.getTime() + RECOGNITION_TTL_MS),
      }),
    ).resolves.toBe(false);
  });

  it("rejects malformed site, origin, challenge, and verifier input", async () => {
    const fixture = createFakeDatabase();

    await expect(
      issueHandoff(fixture.db, {
        siteId: "bad site",
        origin,
        parentSessionId,
        challenge: sha256(verifier),
        now,
      }),
    ).rejects.toThrow();
    await expect(
      issueHandoff(fixture.db, {
        siteId,
        origin: `${origin}/callback`,
        parentSessionId,
        challenge: sha256(verifier),
        now,
      }),
    ).rejects.toThrow();
    await expect(
      issueHandoff(fixture.db, {
        siteId,
        origin,
        parentSessionId,
        challenge: "short",
        now,
      }),
    ).rejects.toThrow();
  });

  it("redeems only after proof and binding checks, then stores recognition separately", async () => {
    const fixture = createFakeDatabase();
    const issued = await issueHandoff(fixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });
    const lastActiveAt = fixture.sessions[0].lastActiveAt;

    const redeemed = await redeemHandoff(fixture.db, {
      code: issued.code,
      siteId,
      origin,
      verifier,
      now,
    });

    expect(redeemed.recognitionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed.expiresAt).toEqual(new Date("2026-09-11T12:15:00.000Z"));
    expect(fixture.verificationRows).toHaveLength(1);
    expect(fixture.verificationRows[0]).toMatchObject({
      id: sha256(redeemed.recognitionToken),
      identifier: HANDOFF_RECOGNITION_IDENTIFIER,
    });
    expect(String(fixture.verificationRows[0].value)).not.toContain(
      redeemed.recognitionToken,
    );
    expect(fixture.sessions[0].lastActiveAt).toEqual(lastActiveAt);
  });

  it.each([
    ["wrong verifier", { verifier: "x".repeat(43) }],
    ["wrong site", { siteId: "site-other" }],
    ["wrong origin", { origin: "https://other.example.test" }],
  ])("does not consume a handoff after %s", async (_label, override) => {
    const fixture = createFakeDatabase();
    const issued = await issueHandoff(fixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });

    await expect(
      redeemHandoff(fixture.db, {
        code: issued.code,
        siteId,
        origin,
        verifier,
        now,
        ...override,
      }),
    ).rejects.toThrow();
    expect(fixture.verificationRows).toHaveLength(1);
  });

  it("prevents replay and returns only site recognition eligibility", async () => {
    const fixture = createFakeDatabase();
    const issued = await issueHandoff(fixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });
    const redeemed = await redeemHandoff(fixture.db, {
      code: issued.code,
      siteId,
      origin,
      verifier,
      now,
    });

    await expect(
      redeemHandoff(fixture.db, {
        code: issued.code,
        siteId,
        origin,
        verifier,
        now,
      }),
    ).rejects.toThrow();
    await expect(
      recognizeSite(fixture.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId,
        origin,
        now,
      }),
    ).resolves.toBe(true);
    await expect(
      recognizeSite(fixture.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId: "site-other",
        origin,
        now,
      }),
    ).resolves.toBe(false);

    fixture.users[0].state = accountState.enumValues[2];
    await expect(
      recognizeSite(fixture.db, {
        recognitionToken: redeemed.recognitionToken,
        siteId,
        origin,
        now,
      }),
    ).resolves.toBe(false);
  });

  it("fails closed when the conditional consume loses a race", async () => {
    const fixture = createFakeDatabase();
    const issued = await issueHandoff(fixture.db, {
      siteId,
      origin,
      parentSessionId,
      challenge: sha256(verifier),
      now,
    });
    fixture.preventDelete();

    await expect(
      redeemHandoff(fixture.db, {
        code: issued.code,
        siteId,
        origin,
        verifier,
        now,
      }),
    ).rejects.toThrow();
    expect(fixture.verificationRows).toHaveLength(1);
  });
});
