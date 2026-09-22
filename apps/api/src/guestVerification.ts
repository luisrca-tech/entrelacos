import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type GuestLookupInput,
  guestChallengeVerifyInputSchema,
  guestLookupInputSchema,
} from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createFamilySessionInTransaction,
  type FamilySessionDatabase,
} from "./familySession";
import { deriveGuestGroupAccessPin } from "./guestGroups";
import { lookupGuestGroup } from "./guestLookup";

export type GuestVerificationDatabase = NodePgDatabase<Record<string, never>>;

export const GUEST_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const GUEST_COOLDOWN_MS = 15 * 60 * 1000;
export const GUEST_VERIFY_LIMIT = 10;
export const GUEST_VERIFY_WINDOW_MS = 15 * 60 * 1000;

export type GuestChallengeIdGenerator = () => string;
export type GuestSessionTokenGenerator = () => string;

export type GuestVerificationResult = {
  challengeId: string;
  expiresAt: string;
};

export interface GuestVerificationOptions {
  ipAddress: string;
  fingerprintSecret: string;
  now?: Date;
  challengeIdGenerator?: GuestChallengeIdGenerator;
  sessionTokenGenerator?: GuestSessionTokenGenerator;
}

export class GuestVerificationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = "GuestVerificationServiceError";
  }
}

function reject(
  status: number,
  code: string,
  title: string,
  retryAfterSeconds?: number,
): never {
  throw new GuestVerificationServiceError(
    status,
    code,
    title,
    retryAfterSeconds,
  );
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid verification time");
  }
  return now;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  }
  return date;
}

function fingerprint(value: string, secret: string, purpose: string): string {
  if (!value.trim() || !secret.trim()) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Guest verification is not configured",
    );
  }
  return createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateGeneratedValue(
  value: string,
  kind: "token" | "challenge",
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      `Invalid generated ${kind}`,
    );
  }
  return value;
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

type Transaction = GuestVerificationDatabase;

async function lockSite(
  tx: Transaction,
  siteId: string,
): Promise<{ id: string; lifecycle: string }> {
  const result = await tx.execute(
    sql`SELECT id, lifecycle FROM "site" WHERE id = ${siteId} FOR UPDATE`,
  );
  const row = result.rows[0] as { id: string; lifecycle: string } | undefined;
  if (!row) reject(404, "NOT_FOUND", "Not Found");
  if (row.lifecycle === "INACTIVE") {
    reject(409, "SITE_INACTIVE", "Site is inactive");
  }
  return row;
}

async function lockGroup(
  tx: Transaction,
  siteId: string,
  groupId: string,
): Promise<{
  id: string;
  siteId: string;
  phoneE164: string | null;
  isForeign: boolean;
  manualPinSeed: string;
}> {
  const result = await tx.execute(sql`
    SELECT id, site_id, phone_e164, is_foreign, manual_pin_seed
    FROM guest_group
    WHERE site_id = ${siteId} AND id = ${groupId}
    FOR UPDATE
  `);
  const row = result.rows[0] as
    | {
        id: string;
        site_id: string;
        phone_e164: string | null;
        is_foreign: boolean;
        manual_pin_seed: string;
      }
    | undefined;
  if (!row) reject(404, "GUEST_NOT_FOUND", "Guest not found");
  return {
    id: row.id,
    siteId: row.site_id,
    phoneE164: row.phone_e164,
    isForeign: row.is_foreign,
    manualPinSeed: row.manual_pin_seed,
  };
}

type Challenge = {
  id: string;
  siteId: string;
  groupId: string;
  phoneE164: string;
  status: "PENDING" | "VERIFIED" | "EXPIRED" | "LOCKED" | "REVOKED";
  expiresAt: Date;
  wrongAttempts: number;
  cooldownUntil: Date | null;
};

async function lockChallenge(
  tx: Transaction,
  challengeId: string,
): Promise<Challenge> {
  const result = await tx.execute(sql`
    SELECT id, site_id, group_id, phone_e164, status, expires_at,
      wrong_attempts, cooldown_until
    FROM guest_verification_challenge
    WHERE id = ${challengeId}
    FOR UPDATE
  `);
  const row = result.rows[0] as
    | {
        id: string;
        site_id: string;
        group_id: string;
        phone_e164: string;
        status: Challenge["status"];
        expires_at: Date | string;
        wrong_attempts: number;
        cooldown_until: Date | string | null;
      }
    | undefined;
  if (!row) reject(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
  return {
    id: row.id,
    siteId: row.site_id,
    groupId: row.group_id,
    phoneE164: row.phone_e164,
    status: row.status,
    expiresAt: asDate(row.expires_at),
    wrongAttempts: row.wrong_attempts,
    cooldownUntil: row.cooldown_until ? asDate(row.cooldown_until) : null,
  };
}

async function reservePinVerification(
  tx: Transaction,
  input: { ipAddress: string; fingerprintSecret: string; now: Date },
): Promise<void> {
  const ipFingerprint = fingerprint(
    input.ipAddress,
    input.fingerprintSecret,
    "guest-ip",
  );
  const scopeKey = `verify:ip:${ipFingerprint}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`,
  );
  const cutoff = new Date(input.now.getTime() - GUEST_VERIFY_WINDOW_MS);
  const result = await tx.execute(sql`
    SELECT occurred_at
    FROM guest_rate_limit_event
    WHERE action = 'PIN_VERIFY'::guest_rate_limit_action
      AND scope_key = ${scopeKey}
      AND occurred_at > ${cutoff}
      AND occurred_at <= ${input.now}
    ORDER BY occurred_at ASC
    LIMIT ${GUEST_VERIFY_LIMIT}
  `);
  if (result.rows.length >= GUEST_VERIFY_LIMIT) {
    const oldest = asDate(
      (result.rows[0] as { occurred_at: Date | string }).occurred_at,
    );
    reject(
      429,
      "PIN_VERIFY_RATE_LIMITED",
      "Too many verification attempts",
      secondsUntil(
        new Date(oldest.getTime() + GUEST_VERIFY_WINDOW_MS),
        input.now,
      ),
    );
  }
  await tx.execute(sql`
    INSERT INTO guest_rate_limit_event
      (id, site_id, group_id, action, scope_key, ip_fingerprint,
       phone_fingerprint, occurred_at)
    VALUES
      (${randomUUID()}, NULL, NULL,
       'PIN_VERIFY'::guest_rate_limit_action, ${scopeKey},
       ${ipFingerprint}, NULL, ${input.now})
  `);
}

async function revokeActiveChallenges(
  tx: Transaction,
  siteId: string,
  groupId: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE guest_verification_challenge
    SET status = 'REVOKED'::guest_verification_challenge_status,
        revoked_at = ${now},
        revocation_reason = 'SUPERSEDED',
        updated_at = ${now}
    WHERE site_id = ${siteId}
      AND group_id = ${groupId}
      AND status = 'PENDING'::guest_verification_challenge_status
  `);
}

function challengeResult(challengeId: string, expiresAt: Date) {
  return { challengeId, expiresAt: expiresAt.toISOString() };
}

export async function startGuestChallenge(
  db: GuestVerificationDatabase,
  siteId: string,
  input: unknown,
  options: GuestVerificationOptions,
): Promise<GuestVerificationResult> {
  const value: GuestLookupInput = guestLookupInputSchema.parse(input);
  const now = currentTime(options.now);
  const challengeId = validateGeneratedValue(
    options.challengeIdGenerator?.() ?? opaqueToken(),
    "challenge",
  );
  const lookup = await lookupGuestGroup(db, siteId, value, {
    ipAddress: options.ipAddress,
    fingerprintSecret: options.fingerprintSecret,
    now,
  });
  if (lookup.kind === "FOREIGN_ADMIN_ONLY") {
    reject(
      422,
      "FOREIGN_GUEST_CONTACT_ADMIN",
      "Please contact the wedding administrator",
    );
  }
  if (lookup.kind !== "MATCH") {
    reject(404, "GUEST_NOT_FOUND", "Guest not found");
  }

  return db.transaction(async (tx) => {
    await lockSite(tx, siteId);
    const group = await lockGroup(tx, siteId, lookup.groupId);
    if (group.isForeign || group.phoneE164 !== lookup.phoneE164) {
      reject(404, "GUEST_NOT_FOUND", "Guest not found");
    }
    const cooldown = await tx.execute(sql`
      SELECT cooldown_until
      FROM guest_verification_challenge
      WHERE site_id = ${siteId} AND group_id = ${group.id}
        AND cooldown_until IS NOT NULL AND cooldown_until > ${now}
      ORDER BY cooldown_until DESC
      LIMIT 1
    `);
    const cooldownUntil = (
      cooldown.rows[0] as { cooldown_until: Date | string } | undefined
    )?.cooldown_until;
    if (cooldownUntil) {
      const until = asDate(cooldownUntil);
      reject(
        429,
        "CHALLENGE_COOLDOWN",
        "Verification temporarily locked",
        secondsUntil(until, now),
      );
    }

    await revokeActiveChallenges(tx, siteId, group.id, now);
    const expiresAt = new Date(now.getTime() + GUEST_CHALLENGE_TTL_MS);
    await tx.execute(sql`
      INSERT INTO guest_verification_challenge
        (id, site_id, group_id, status, phone_e164, expires_at,
         wrong_attempts, created_at, updated_at)
      VALUES
        (${challengeId}, ${siteId}, ${group.id},
         'PENDING'::guest_verification_challenge_status,
         ${lookup.phoneE164}, ${expiresAt}, 0, ${now}, ${now})
    `);
    return challengeResult(challengeId, expiresAt);
  });
}

type VerificationError = {
  kind: "ERROR";
  status: number;
  code: string;
  title: string;
  retryAfterSeconds?: number;
};

type VerificationOutcome =
  | VerificationError
  | {
      kind: "SUCCESS";
      session: Awaited<ReturnType<typeof createFamilySessionInTransaction>>;
    };

function verificationError(
  status: number,
  code: string,
  title: string,
  retryAfterSeconds?: number,
): VerificationError {
  return { kind: "ERROR", status, code, title, retryAfterSeconds };
}

async function verifyPinInTransaction(
  tx: Transaction,
  challengeId: string,
  code: string,
  options: GuestVerificationOptions,
  now: Date,
): Promise<VerificationOutcome> {
  const challenge = await lockChallenge(tx, challengeId);
  await lockSite(tx, challenge.siteId);
  const group = await lockGroup(tx, challenge.siteId, challenge.groupId);
  if (
    group.isForeign ||
    group.phoneE164 !== challenge.phoneE164 ||
    group.siteId !== challenge.siteId
  ) {
    return verificationError(
      409,
      "CHALLENGE_NOT_ACTIVE",
      "Challenge is not active",
    );
  }
  if (challenge.status === "PENDING" && challenge.expiresAt <= now) {
    await tx.execute(sql`
      UPDATE guest_verification_challenge
      SET status = 'EXPIRED'::guest_verification_challenge_status,
          updated_at = ${now}
      WHERE id = ${challengeId}
    `);
    return verificationError(410, "CHALLENGE_EXPIRED", "Challenge expired");
  }
  if (challenge.cooldownUntil && challenge.cooldownUntil > now) {
    return verificationError(
      429,
      "CHALLENGE_COOLDOWN",
      "Verification temporarily locked",
      secondsUntil(challenge.cooldownUntil, now),
    );
  }
  if (challenge.status !== "PENDING") {
    return verificationError(
      409,
      "CHALLENGE_NOT_ACTIVE",
      "Challenge is not active",
    );
  }

  const expected = Buffer.from(
    deriveGuestGroupAccessPin(
      challenge.siteId,
      challenge.groupId,
      group.manualPinSeed,
      options.fingerprintSecret,
    ),
  );
  const actual = Buffer.from(code);
  const correct =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!correct) {
    const wrongAttempts = challenge.wrongAttempts + 1;
    if (wrongAttempts >= 5) {
      const cooldownUntil = new Date(now.getTime() + GUEST_COOLDOWN_MS);
      await tx.execute(sql`
        UPDATE guest_verification_challenge
        SET status = 'LOCKED'::guest_verification_challenge_status,
            wrong_attempts = 5,
            cooldown_until = ${cooldownUntil},
            updated_at = ${now}
        WHERE id = ${challengeId}
      `);
      return verificationError(
        429,
        "CHALLENGE_COOLDOWN",
        "Verification temporarily locked",
        Math.ceil(GUEST_COOLDOWN_MS / 1000),
      );
    }
    await tx.execute(sql`
      UPDATE guest_verification_challenge
      SET wrong_attempts = ${wrongAttempts}, updated_at = ${now}
      WHERE id = ${challengeId}
    `);
    return verificationError(401, "INVALID_CODE", "Invalid verification code");
  }

  const token = validateGeneratedValue(
    options.sessionTokenGenerator?.() ?? opaqueToken(),
    "token",
  );
  await tx.execute(sql`
    UPDATE guest_verification_challenge
    SET status = 'VERIFIED'::guest_verification_challenge_status,
        verified_at = ${now},
        updated_at = ${now}
    WHERE id = ${challengeId}
  `);
  const session = await createFamilySessionInTransaction(
    tx as FamilySessionDatabase,
    { siteId: challenge.siteId, groupId: challenge.groupId, token, now },
  );
  return { kind: "SUCCESS", session };
}

export async function verifyGuestChallenge(
  db: GuestVerificationDatabase,
  challengeId: string,
  input: unknown,
  options: GuestVerificationOptions,
) {
  const value = guestChallengeVerifyInputSchema.parse(input);
  if (value.challengeId !== challengeId) {
    reject(400, "VALIDATION_ERROR", "Invalid verification request");
  }
  const now = currentTime(options.now);
  await db.transaction((tx) =>
    reservePinVerification(tx, {
      ipAddress: options.ipAddress,
      fingerprintSecret: options.fingerprintSecret,
      now,
    }),
  );
  const result = await db.transaction((tx) =>
    verifyPinInTransaction(tx, challengeId, value.code, options, now),
  );
  if (result.kind === "ERROR") {
    reject(result.status, result.code, result.title, result.retryAfterSeconds);
  }
  return result.session;
}
