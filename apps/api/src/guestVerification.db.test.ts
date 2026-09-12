import { createHmac, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familySession,
  guestGroup,
  guestRateLimitEvent,
  guestVerificationChallenge,
  guestVerificationSend,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FAMILY_SESSION_TTL_MS,
  hashFamilySessionToken,
  leaveFamilySession,
  readFamilySession,
} from "./familySession";
import { createGuestGroup, getGuestGroupAccessPin } from "./guestGroups";
import {
  hashGuestVerificationValue,
  resendGuestChallenge,
  startGuestChallenge,
  verifyGuestChallenge,
} from "./guestVerification";
import { approveReview, createSite, startReview } from "./sites";

const fixturePrefix = `t3-verification-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
const fingerprintSecret =
  "block3-test-fingerprint-secret-with-at-least-32-characters";
const testIpSeed = randomUUID().replaceAll("-", "").slice(0, 12);
const fixturePhoneSeed = String(
  Number.parseInt(randomUUID().slice(0, 8), 16) % 10_000,
).padStart(4, "0");
let connection: DatabaseConnection;
const siteIds: string[] = [];
const fixturePhones = new Map<string, string>();
const fixtureIps = new Set<string>();
let fixturePhoneCounter = 0;

function time(minutes: number): Date {
  return new Date(fixedNow.getTime() + minutes * 60 * 1000);
}

function testIp(suffix: string): string {
  const value = `2001:db8:${testIpSeed}::${suffix}`;
  fixtureIps.add(value);
  return value;
}

function phoneForSite(siteId: string): string {
  const existing = fixturePhones.get(siteId);
  if (existing) return existing;
  fixturePhoneCounter += 1;
  const phone = `+55119${fixturePhoneSeed}${String(fixturePhoneCounter).padStart(4, "0")}`;
  fixturePhones.set(siteId, phone);
  return phone;
}

function phoneInputForSite(siteId: string): string {
  const phone = phoneForSite(siteId);
  return `(${phone.slice(3, 5)}) ${phone.slice(5, 10)}-${phone.slice(10)}`;
}

function testSessionToken(label: string): string {
  return `${label}-${testIpSeed}`.padEnd(43, label[0] ?? "x").slice(0, 43);
}

function options(
  ipAddress: string,
  codeGenerator: () => string,
  provider: Parameters<typeof startGuestChallenge>[3]["provider"],
  sessionTokenGenerator?: () => string,
) {
  return {
    ipAddress,
    fingerprintSecret,
    now: fixedNow,
    provider,
    codeGenerator,
    sessionTokenGenerator,
    exposeSimulationCode: true,
  };
}

async function createFixture(suffix: string) {
  const created = await createSite(
    connection.db,
    {
      repositorySlug: `${fixturePrefix}-${suffix}`,
      provisioningKey: `${fixturePrefix}:key-${suffix}`,
      displayName: `Wedding ${suffix}`,
      coupleNames: ["Ana", "João"],
      eventDate: "2029-06-10",
    },
    fixedNow,
  );
  siteIds.push(created.id);
  const phone = phoneForSite(created.id);
  await createGuestGroup(
    connection.db,
    { userId: "owner", role: "OWNER" },
    created.id,
    {
      name: "Família Silva",
      isForeign: false,
      phone,
      members: [{ fullName: "Ana Silva", isRepresentative: true }],
    },
    fixedNow,
  );
  await startReview(connection.db, created.id, {}, fixedNow);
  await approveReview(connection.db, created.id, {}, fixedNow);
  await connection.db.insert(siteOrigin).values({
    id: `${created.id}-origin`,
    siteId: created.id,
    origin: `https://${created.id}.example.test`,
  });
  return created;
}

function provider(
  result: Awaited<
    ReturnType<
      NonNullable<Parameters<typeof startGuestChallenge>[3]["provider"]>["send"]
    >
  >,
  mode: "MOCK" | "TWILIO" = "MOCK",
) {
  return {
    mode,
    send: vi.fn().mockResolvedValue(result),
  };
}

describe("guest verification and family sessions PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
  });

  afterAll(async () => {
    const phoneFingerprints = [...fixturePhones.values()].map((phone) =>
      createHmac("sha256", fingerprintSecret)
        .update(`guest-phone:${phone}`)
        .digest("hex"),
    );
    const ipFingerprints = [...fixtureIps].map((ip) =>
      createHmac("sha256", fingerprintSecret)
        .update(`guest-ip:${ip}`)
        .digest("hex"),
    );
    if (phoneFingerprints.length > 0) {
      await connection.db
        .delete(guestRateLimitEvent)
        .where(
          inArray(guestRateLimitEvent.phoneFingerprint, phoneFingerprints),
        );
    }
    if (ipFingerprints.length > 0) {
      await connection.db
        .delete(guestRateLimitEvent)
        .where(inArray(guestRateLimitEvent.ipFingerprint, ipFingerprints));
    }
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    await connection.close();
  });

  it("reserves before provider, hashes code/token, verifies once, and leaves immediately", async () => {
    const wedding = await createFixture("happy");
    const sms = provider({
      status: "PROVIDER_ACCEPTED",
      providerReference: "mock-accepted",
    });
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "áNA   SILVA", phone: phoneInputForSite(wedding.id) },
      options(
        testIp("10"),
        () => "111111",
        sms,
        () => testSessionToken("happy"),
      ),
    );
    expect(challenge).toMatchObject({
      deliveryMode: "SIMULATED",
      simulationCode: "111111",
      sendStatus: "PROVIDER_ACCEPTED",
    });
    expect(sms.send).toHaveBeenCalledOnce();
    const [storedChallenge] = await connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(storedChallenge?.codeHash).toBe(
      hashGuestVerificationValue("111111"),
    );
    expect(storedChallenge?.codeHash).not.toContain("111111");
    const sends = await connection.db
      .select({ status: guestVerificationSend.status })
      .from(guestVerificationSend)
      .where(eq(guestVerificationSend.challengeId, challenge.challengeId));
    expect(sends).toEqual([{ status: "PROVIDER_ACCEPTED" }]);

    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "000000" },
        options(testIp("10"), () => "111111", sms),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CODE", status: 401 });
    const [afterWrong] = await connection.db
      .select({ wrongAttempts: guestVerificationChallenge.wrongAttempts })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(afterWrong?.wrongAttempts).toBe(1);

    const session = await verifyGuestChallenge(
      connection.db,
      challenge.challengeId,
      { challengeId: challenge.challengeId, code: "111111" },
      options(
        testIp("10"),
        () => "111111",
        sms,
        () => testSessionToken("happy"),
      ),
    );
    expect(session.sessionToken).toBe(testSessionToken("happy"));
    const [storedSession] = await connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.id, session.groupId));
    expect(storedSession).toBeUndefined();
    const sessionRows = await connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.groupId, session.groupId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.tokenHash).toBe(
      hashFamilySessionToken(session.sessionToken),
    );
    expect(sessionRows[0]?.tokenHash).not.toContain(session.sessionToken);
    expect(new Date(session.expiresAt).getTime()).toBe(
      fixedNow.getTime() + FAMILY_SESSION_TTL_MS,
    );
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "111111" },
        options(testIp("11"), () => "111111", sms),
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_ACTIVE" });
    await expect(
      readFamilySession(connection.db, session.sessionToken, fixedNow),
    ).resolves.toMatchObject({
      siteId: wedding.id,
      groupId: session.groupId,
    });
    await expect(
      leaveFamilySession(connection.db, session.sessionToken, fixedNow),
    ).resolves.toEqual({ ok: true });
    await expect(
      readFamilySession(connection.db, session.sessionToken, fixedNow),
    ).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
  });

  it("uses the persistent group PIN without calling an SMS provider", async () => {
    const wedding = await createFixture("manual-pin");
    const [createdGroup] = await connection.db
      .select({ id: guestGroup.id })
      .from(guestGroup)
      .where(eq(guestGroup.siteId, wedding.id));
    const groupId = createdGroup?.id as string;
    const { accessPin } = await getGuestGroupAccessPin(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupId,
      fingerprintSecret,
    );
    const manualOptions = {
      ipAddress: testIp("manual"),
      fingerprintSecret,
      now: fixedNow,
      smsMode: "manual" as const,
      sessionTokenGenerator: () => testSessionToken("manual"),
    };
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneInputForSite(wedding.id) },
      manualOptions,
    );
    expect(challenge).toMatchObject({
      deliveryMode: "MANUAL_PIN",
      sendStatus: "MANUAL",
    });
    expect(challenge).not.toHaveProperty("simulationCode");
    expect(
      await connection.db
        .select()
        .from(guestVerificationSend)
        .where(eq(guestVerificationSend.challengeId, challenge.challengeId)),
    ).toHaveLength(0);
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "999999" },
        manualOptions,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CODE", status: 401 });
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: accessPin },
        manualOptions,
      ),
    ).resolves.toMatchObject({ siteId: wedding.id, groupId });
  });

  it("allows an existing session to leave after the site becomes inactive", async () => {
    const wedding = await createFixture("inactive-leave");
    const sms = provider({ status: "PROVIDER_ACCEPTED" });
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("31"), () => "313131", sms),
    );
    const sessionToken = `inactive-${testIpSeed}`.padEnd(43, "i").slice(0, 43);
    const session = await verifyGuestChallenge(
      connection.db,
      challenge.challengeId,
      { challengeId: challenge.challengeId, code: "313131" },
      options(
        testIp("31"),
        () => "313131",
        sms,
        () => sessionToken,
      ),
    );
    await connection.db
      .update(site)
      .set({ lifecycle: "INACTIVE", previousLifecycle: "ACTIVE" })
      .where(eq(site.id, wedding.id));

    await expect(
      leaveFamilySession(connection.db, session.sessionToken, fixedNow),
    ).resolves.toEqual({ ok: true });
    await expect(
      readFamilySession(connection.db, session.sessionToken, fixedNow),
    ).rejects.toMatchObject({ code: "SESSION_INVALID", status: 401 });
  });

  it("preserves expiry and wrong attempts on resend, while enforcing sixty seconds", async () => {
    const wedding = await createFixture("resend");
    const sms = provider({ status: "UNKNOWN", failureCode: "timeout" });
    const first = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("11"), () => "222222", sms),
    );
    await expect(
      resendGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId },
        options(testIp("11"), () => "333333", sms),
      ),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON", retryAfterSeconds: 60 });
    await expect(
      resendGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId },
        { ...options(testIp("11"), () => "333333", sms), now: time(1) },
      ),
    ).resolves.toMatchObject({
      challengeId: first.challengeId,
      expiresAt: first.expiresAt,
      simulationCode: "333333",
      sendStatus: "UNKNOWN",
    });
    const [challenge] = await connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, first.challengeId));
    expect(challenge?.wrongAttempts).toBe(0);
    expect(challenge?.codeHash).toBe(hashGuestVerificationValue("333333"));
    expect(sms.send).toHaveBeenCalledTimes(2);

    await expect(
      resendGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId },
        { ...options(testIp("11"), () => "333333", sms), now: time(2) },
      ),
    ).resolves.toMatchObject({ sendStatus: "UNKNOWN" });
    await expect(
      resendGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId },
        { ...options(testIp("11"), () => "333333", sms), now: time(3) },
      ),
    ).rejects.toMatchObject({ code: "OTP_SEND_RATE_LIMITED", status: 429 });

    const [sendRecord] = await connection.db
      .select({ groupId: guestVerificationSend.groupId })
      .from(guestVerificationSend)
      .where(eq(guestVerificationSend.challengeId, first.challengeId))
      .limit(1);
    const phoneFingerprint = createHmac("sha256", fingerprintSecret)
      .update(`guest-phone:${phoneForSite(wedding.id)}`)
      .digest("hex");
    await connection.db.insert(guestRateLimitEvent).values(
      Array.from({ length: 7 }, (_, index) => ({
        id: `${fixturePrefix}-long-${index}-${randomUUID()}`,
        siteId: wedding.id,
        groupId: sendRecord?.groupId ?? null,
        action: "OTP_SEND" as const,
        scopeKey: `send:group:${wedding.id}:${sendRecord?.groupId}:${phoneFingerprint}:long`,
        ipFingerprint: "f".repeat(64),
        phoneFingerprint,
        occurredAt: new Date(fixedNow.getTime() + (index + 4) * 60 * 1000),
      })),
    );
    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
        { ...options(testIp("11"), () => "444444", sms), now: time(16) },
      ),
    ).rejects.toMatchObject({ code: "OTP_SEND_RATE_LIMITED", status: 429 });
  });

  it("keeps a newer resend usable when an older provider call fails late", async () => {
    const wedding = await createFixture("late-send-failure");
    const accepted = provider({ status: "PROVIDER_ACCEPTED" });
    const first = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("late-send"), () => "111111", accepted),
    );
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishDelayed:
      | ((result: { status: "FAILED_FINAL"; failureCode: string }) => void)
      | undefined;
    const delayedFailure = {
      mode: "MOCK" as const,
      send: vi.fn(
        () =>
          new Promise<{ status: "FAILED_FINAL"; failureCode: string }>(
            (resolve) => {
              finishDelayed = resolve;
              signalStarted?.();
            },
          ),
      ),
    };
    const olderResend = resendGuestChallenge(
      connection.db,
      first.challengeId,
      { challengeId: first.challengeId },
      {
        ...options(testIp("late-send"), () => "222222", delayedFailure),
        now: time(1),
      },
    );
    await started;

    const newerResend = await resendGuestChallenge(
      connection.db,
      first.challengeId,
      { challengeId: first.challengeId },
      {
        ...options(testIp("late-send"), () => "333333", accepted),
        now: time(2),
      },
    );
    expect(newerResend).toMatchObject({
      sendStatus: "PROVIDER_ACCEPTED",
      simulationCode: "333333",
    });

    finishDelayed?.({ status: "FAILED_FINAL", failureCode: "late-failure" });
    const olderResult = await olderResend;
    expect(olderResult).toMatchObject({ sendStatus: "FAILED_FINAL" });
    expect(olderResult.simulationCode).toBeUndefined();
    const [stored] = await connection.db
      .select({ codeHash: guestVerificationChallenge.codeHash })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, first.challengeId));
    expect(stored?.codeHash).toBe(hashGuestVerificationValue("333333"));
    await expect(
      verifyGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId, code: "333333" },
        options(testIp("late-send"), () => "333333", accepted),
      ),
    ).resolves.toMatchObject({ groupId: expect.any(String) });
  });

  it("supersedes an active challenge when the guest starts again", async () => {
    const wedding = await createFixture("superseded");
    const sms = provider({ status: "PROVIDER_ACCEPTED" });
    const first = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("16"), () => "121212", sms),
    );
    const second = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("17"), () => "343434", sms),
    );
    expect(second.challengeId).not.toBe(first.challengeId);
    await expect(
      verifyGuestChallenge(
        connection.db,
        first.challengeId,
        { challengeId: first.challengeId, code: "121212" },
        options(testIp("16"), () => "121212", sms),
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_ACTIVE" });
    await expect(
      verifyGuestChallenge(
        connection.db,
        second.challengeId,
        { challengeId: second.challengeId, code: "343434" },
        options(
          testIp("17"),
          () => "343434",
          sms,
          () => testSessionToken("superseded"),
        ),
      ),
    ).resolves.toMatchObject({ sessionToken: testSessionToken("superseded") });
  });

  it("persists final provider failure without permitting local-code verification", async () => {
    const wedding = await createFixture("failed");
    const sms = provider({ status: "FAILED_FINAL", failureCode: "blocked" });
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("12"), () => "444444", sms),
    );
    expect(challenge.sendStatus).toBe("FAILED_FINAL");
    expect(challenge.simulationCode).toBeUndefined();
    const [stored] = await connection.db
      .select({ codeHash: guestVerificationChallenge.codeHash })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(stored?.codeHash).toBeNull();
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "444444" },
        options(testIp("12"), () => "444444", sms),
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_ACTIVE" });
  });

  it("keeps real-provider delivery labeled and prevents provider-mode switching on resend", async () => {
    const wedding = await createFixture("real-mode");
    const twilio = provider({ status: "PROVIDER_ACCEPTED" }, "TWILIO");
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("18"), () => "888888", twilio),
    );
    expect(challenge.deliveryMode).toBe("REAL_SMS");
    expect(challenge.simulationCode).toBeUndefined();
    await expect(
      resendGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId },
        {
          ...options(
            testIp("18"),
            () => "999999",
            provider({ status: "PROVIDER_ACCEPTED" }),
          ),
          now: time(1),
        },
      ),
    ).rejects.toMatchObject({
      code: "VERIFICATION_CONFIGURATION_ERROR",
      status: 503,
    });
    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
        {
          ...options(
            testIp("18b"),
            () => "777777",
            provider({ status: "PROVIDER_ACCEPTED" }),
          ),
          provider: undefined,
          smsMode: "real",
        },
      ),
    ).rejects.toMatchObject({
      code: "VERIFICATION_CONFIGURATION_ERROR",
      status: 503,
    });
  });

  it("checks real verification outside the transaction and re-locks before creating a session", async () => {
    const wedding = await createFixture("twilio-check");
    const twilio = {
      mode: "TWILIO" as const,
      send: vi.fn().mockResolvedValue({
        status: "PROVIDER_ACCEPTED" as const,
        providerReference: "verify-service",
      }),
      check: vi.fn().mockResolvedValue({
        status: "UNKNOWN" as const,
        failureCode: "timeout",
      }),
    };
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("twilio-check"), () => "121212", twilio),
    );
    expect(challenge.deliveryMode).toBe("REAL_SMS");
    expect(challenge.simulationCode).toBeUndefined();
    const [stored] = await connection.db
      .select({ codeHash: guestVerificationChallenge.codeHash })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(stored?.codeHash).toBeNull();

    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "121212" },
        options(testIp("twilio-check"), () => "121212", twilio),
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_VERIFICATION_UNKNOWN",
      status: 503,
    });
    const [afterUnknown] = await connection.db
      .select({ wrongAttempts: guestVerificationChallenge.wrongAttempts })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(afterUnknown?.wrongAttempts).toBe(0);

    twilio.check.mockResolvedValue({ status: "BOGUS" } as never);
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "121212" },
        options(testIp("twilio-check"), () => "121212", twilio),
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_VERIFICATION_UNKNOWN",
      status: 503,
    });
    const [afterMalformed] = await connection.db
      .select({ wrongAttempts: guestVerificationChallenge.wrongAttempts })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(afterMalformed?.wrongAttempts).toBe(0);

    twilio.check.mockResolvedValue({ status: "DECLINED" as const });
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "121212" },
        options(testIp("twilio-check"), () => "121212", twilio),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CODE", status: 401 });
    twilio.check.mockResolvedValue({ status: "APPROVED" as const });
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "121212" },
        options(
          testIp("twilio-check"),
          () => "121212",
          twilio,
          () => testSessionToken("twilio"),
        ),
      ),
    ).resolves.toMatchObject({ sessionToken: testSessionToken("twilio") });
    expect(twilio.check).toHaveBeenCalledTimes(4);
  });

  it("enforces the global short-window send limit per IP", async () => {
    const wedding = await createFixture("ip-limit");
    const ipAddress = testIp("19");
    const ipFingerprint = createHmac("sha256", fingerprintSecret)
      .update(`guest-ip:${ipAddress}`)
      .digest("hex");
    await connection.db.insert(guestRateLimitEvent).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: `${fixturePrefix}-ip-${index}-${randomUUID()}`,
        siteId: null,
        groupId: null,
        action: "OTP_SEND" as const,
        scopeKey: `send:ip:short:${ipFingerprint}`,
        ipFingerprint,
        phoneFingerprint: null,
        occurredAt: new Date(fixedNow.getTime() - index * 1000),
      })),
    );
    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
        options(ipAddress, () => "989898", provider({ status: "UNKNOWN" })),
      ),
    ).rejects.toMatchObject({
      code: "OTP_SEND_RATE_LIMITED",
      status: 429,
    });
  });

  it("enforces the independent short-window send limit per phone across sites", async () => {
    const first = await createFixture("phone-limit-first");
    const phone = phoneForSite(first.id);
    const second = await createSite(
      connection.db,
      {
        repositorySlug: `${fixturePrefix}-phone-limit-second`,
        provisioningKey: `${fixturePrefix}:phone-limit-second`,
        displayName: "Phone Limit Second",
        coupleNames: ["Bia", "Caio"],
        eventDate: "2029-06-10",
      },
      fixedNow,
    );
    siteIds.push(second.id);
    await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      second.id,
      {
        name: "Família Silva Second",
        isForeign: false,
        phone,
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      fixedNow,
    );
    await startReview(connection.db, second.id, {}, fixedNow);
    await approveReview(connection.db, second.id, {}, fixedNow);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await startGuestChallenge(
        connection.db,
        first.id,
        { fullName: "Ana Silva", phone },
        options(
          testIp(`phone-${attempt}`),
          () => "123123",
          provider({ status: "UNKNOWN" }),
        ),
      );
    }
    await expect(
      startGuestChallenge(
        connection.db,
        second.id,
        { fullName: "Ana Silva", phone },
        options(
          testIp("phone-fourth"),
          () => "123123",
          provider({ status: "UNKNOWN" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "OTP_SEND_RATE_LIMITED", status: 429 });
  });

  it("marks expired challenges and rejects sessions at the absolute expiry", async () => {
    const wedding = await createFixture("expiry");
    const sms = provider({ status: "PROVIDER_ACCEPTED" });
    const expiredChallenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("20"), () => "101010", sms),
    );
    await expect(
      verifyGuestChallenge(
        connection.db,
        expiredChallenge.challengeId,
        { challengeId: expiredChallenge.challengeId, code: "101010" },
        { ...options(testIp("20"), () => "101010", sms), now: time(10) },
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED", status: 410 });
    const [expiredRecord] = await connection.db
      .select({ status: guestVerificationChallenge.status })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, expiredChallenge.challengeId));
    expect(expiredRecord?.status).toBe("EXPIRED");

    const validChallenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      {
        ...options(
          testIp("21"),
          () => "202020",
          sms,
          () => testSessionToken("expiry"),
        ),
        now: time(11),
      },
    );
    const session = await verifyGuestChallenge(
      connection.db,
      validChallenge.challengeId,
      { challengeId: validChallenge.challengeId, code: "202020" },
      {
        ...options(
          testIp("21"),
          () => "202020",
          sms,
          () => testSessionToken("expiry"),
        ),
        now: time(11),
      },
    );
    await expect(
      readFamilySession(
        connection.db,
        session.sessionToken,
        new Date(time(11).getTime() + FAMILY_SESSION_TTL_MS),
      ),
    ).rejects.toMatchObject({ code: "SESSION_INVALID", status: 401 });
  });

  it("locks after five wrong codes and blocks a new challenge during cooldown", async () => {
    const wedding = await createFixture("cooldown");
    const sms = provider({ status: "UNKNOWN" });
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(testIp("13"), () => "555555", sms),
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        verifyGuestChallenge(
          connection.db,
          challenge.challengeId,
          { challengeId: challenge.challengeId, code: "000000" },
          options(testIp("13"), () => "555555", sms),
        ),
      ).rejects.toMatchObject({ code: "INVALID_CODE" });
    }
    await expect(
      verifyGuestChallenge(
        connection.db,
        challenge.challengeId,
        { challengeId: challenge.challengeId, code: "000000" },
        options(testIp("13"), () => "555555", sms),
      ),
    ).rejects.toMatchObject({
      code: "CHALLENGE_COOLDOWN",
      retryAfterSeconds: 900,
    });
    await expect(
      startGuestChallenge(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
        options(testIp("14"), () => "666666", sms),
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_COOLDOWN", status: 429 });
    const [stored] = await connection.db
      .select({
        wrongAttempts: guestVerificationChallenge.wrongAttempts,
        status: guestVerificationChallenge.status,
      })
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, challenge.challengeId));
    expect(stored).toEqual({ wrongAttempts: 5, status: "LOCKED" });
  });

  it("allows only one concurrent verification to create a family session", async () => {
    const wedding = await createFixture("concurrent");
    const sms = provider({ status: "PROVIDER_ACCEPTED" });
    const challenge = await startGuestChallenge(
      connection.db,
      wedding.id,
      { fullName: "Ana Silva", phone: phoneForSite(wedding.id) },
      options(
        testIp("15"),
        () => "777777",
        sms,
        () => testSessionToken("concurrent"),
      ),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        verifyGuestChallenge(
          connection.db,
          challenge.challengeId,
          { challengeId: challenge.challengeId, code: "777777" },
          options(
            testIp("15"),
            () => "777777",
            sms,
            () => testSessionToken("concurrent"),
          ),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const sessions = await connection.db
      .select()
      .from(familySession)
      .where(
        eq(
          familySession.groupId,
          (
            results.find(
              (result) => result.status === "fulfilled",
            ) as PromiseFulfilledResult<{ groupId: string }>
          ).value.groupId,
        ),
      );
    expect(sessions).toHaveLength(1);
  });
});
