import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type InvitationAccessInput,
  type InvitationSessionReadResponse,
  type InvitationSessionResponse,
  invitationAccessInputSchema,
  invitationSessionReadResponseSchema,
  invitationSessionResponseSchema,
} from "@entrelacos/contracts";
import {
  invitationAccessChallenge,
  invitationGuest,
  invitationRateLimitEvent,
  invitationSession,
} from "@entrelacos/database/schema";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deriveInvitationAccessPin } from "./invitations";

export type GuestVerificationDatabase = NodePgDatabase<Record<string, never>>;
export type GuestSessionTokenGenerator = () => string;
export type GuestChallengeIdGenerator = () => string;

export const INVITATION_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITATION_ACCESS_COOLDOWN_MS = 15 * 60 * 1000;
export const INVITATION_ACCESS_ATTEMPT_LIMIT = 10;
export const INVITATION_ACCESS_WINDOW_MS = 15 * 60 * 1000;
const INVITATION_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const INVITATION_CHALLENGE_WRONG_ATTEMPT_LIMIT = 5;
const DUMMY_PIN_SEED = "0".repeat(64);
const DUMMY_INVITATION_ID = "missing-invitation";

export interface GuestVerificationOptions {
  ipAddress: string;
  fingerprintSecret: string;
  now?: Date;
  sessionTokenGenerator?: GuestSessionTokenGenerator;
  attemptIdGenerator?: () => string;
  challengeIdGenerator?: GuestChallengeIdGenerator;
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
    reject(400, "VALIDATION_ERROR", "Invalid invitation access request");
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
  if (value.trim().length === 0 || secret.trim().length < 32) {
    reject(
      503,
      "INVITATION_ACCESS_CONFIGURATION_ERROR",
      "Invitation access is not configured",
    );
  }
  return createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateSessionToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    reject(
      503,
      "INVITATION_ACCESS_CONFIGURATION_ERROR",
      "Invitation access is not configured",
    );
  }
  return value;
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

export function invitationPinMatches(
  expected: string,
  supplied: string,
): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export function hashInvitationSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type AccessFailure = {
  kind: "ERROR";
  status: number;
  code: string;
  title: string;
  retryAfterSeconds?: number;
};

type InvitationIdentity = {
  id: string;
  siteId: string;
  name: string;
  phone: string;
  manualPinSeed: string;
};

type InvitationGuestRecord = {
  id: string;
  fullName: string;
  guestType: "ADULT" | "CHILD";
  rsvpState: "PENDING" | "CONFIRMED" | "DECLINED";
};

async function listInvitationGuests(
  db: GuestVerificationDatabase,
  siteId: string,
  invitationId: string,
): Promise<InvitationGuestRecord[]> {
  return db
    .select({
      id: invitationGuest.id,
      fullName: invitationGuest.fullName,
      guestType: invitationGuest.guestType,
      rsvpState: invitationGuest.rsvpState,
    })
    .from(invitationGuest)
    .where(
      and(
        eq(invitationGuest.siteId, siteId),
        eq(invitationGuest.invitationId, invitationId),
      ),
    )
    .orderBy(invitationGuest.id);
}

export async function createInvitationSessionInTransaction(
  tx: GuestVerificationDatabase,
  input: {
    siteId: string;
    invitationId: string;
    invitationName: string;
    token: string;
    now: Date;
  },
): Promise<InvitationSessionResponse> {
  const token = validateSessionToken(input.token);
  const expiresAt = new Date(input.now.getTime() + INVITATION_SESSION_TTL_MS);
  await tx.insert(invitationSession).values({
    id: randomUUID(),
    siteId: input.siteId,
    invitationId: input.invitationId,
    tokenHash: hashInvitationSessionToken(token),
    expiresAt,
    createdAt: input.now,
  });
  const guests = await listInvitationGuests(
    tx,
    input.siteId,
    input.invitationId,
  );
  if (guests.length === 0) {
    reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  }
  return invitationSessionResponseSchema.parse({
    sessionToken: token,
    siteId: input.siteId,
    invitationId: input.invitationId,
    invitationName: input.invitationName,
    guests,
    expiresAt: expiresAt.toISOString(),
  });
}

export function invitationRateLimitScope(
  siteId: string,
  ipAddress: string,
  fingerprintSecret: string,
): string {
  return `verify:site:${siteId}:ip:${fingerprint(ipAddress, fingerprintSecret, "invitation-ip")}`;
}

async function reservePinVerification(
  tx: GuestVerificationDatabase,
  input: {
    siteId: string;
    phone: string;
    ipAddress: string;
    fingerprintSecret: string;
    now: Date;
  },
): Promise<AccessFailure | undefined> {
  const ipFingerprint = fingerprint(
    input.ipAddress,
    input.fingerprintSecret,
    "invitation-ip",
  );
  const phoneFingerprint = fingerprint(
    `${input.siteId}:${input.phone}`,
    input.fingerprintSecret,
    "invitation-phone",
  );
  const scopeKey = invitationRateLimitScope(
    input.siteId,
    input.ipAddress,
    input.fingerprintSecret,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`,
  );
  const cutoff = new Date(input.now.getTime() - INVITATION_ACCESS_WINDOW_MS);
  await tx
    .delete(invitationRateLimitEvent)
    .where(
      and(
        eq(invitationRateLimitEvent.action, "PIN_VERIFY"),
        lte(invitationRateLimitEvent.occurredAt, cutoff),
      ),
    );
  const result = await tx.execute(sql`
    SELECT occurred_at
    FROM invitation_rate_limit_event
    WHERE action = 'PIN_VERIFY'::invitation_rate_limit_action
      AND scope_key = ${scopeKey}
      AND occurred_at > ${cutoff}
      AND occurred_at <= ${input.now}
    ORDER BY occurred_at ASC
    LIMIT ${INVITATION_ACCESS_ATTEMPT_LIMIT}
  `);
  if (result.rows.length >= INVITATION_ACCESS_ATTEMPT_LIMIT) {
    const oldest = asDate(
      (result.rows[0] as { occurred_at: Date | string }).occurred_at,
    );
    return {
      kind: "ERROR",
      status: 429,
      code: "INVITATION_ACCESS_RATE_LIMITED",
      title: "Too many invitation access attempts",
      retryAfterSeconds: secondsUntil(
        new Date(oldest.getTime() + INVITATION_ACCESS_WINDOW_MS),
        input.now,
      ),
    };
  }
  await tx.insert(invitationRateLimitEvent).values({
    id: randomUUID(),
    siteId: input.siteId,
    invitationId: null,
    action: "PIN_VERIFY",
    scopeKey,
    ipFingerprint,
    phoneFingerprint,
    occurredAt: input.now,
  });
  return undefined;
}

async function findInvitationForAccess(
  tx: GuestVerificationDatabase,
  siteId: string,
  phone: string,
): Promise<InvitationIdentity | undefined> {
  const result = await tx.execute(sql`
    SELECT invitation.id, invitation.site_id, invitation.name,
      invitation.phone_e164, invitation.manual_pin_seed
    FROM invitation
    INNER JOIN site ON site.id = invitation.site_id
    WHERE invitation.site_id = ${siteId}
      AND invitation.phone_e164 = ${phone}
      AND site.lifecycle <> 'INACTIVE'
    FOR UPDATE OF invitation
  `);
  const row = result.rows[0] as
    | {
        id: string;
        site_id: string;
        name: string;
        phone_e164: string;
        manual_pin_seed: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    phone: row.phone_e164,
    manualPinSeed: row.manual_pin_seed,
  };
}

type Attempt = {
  id: string;
  status: "PENDING" | "LOCKED";
  expiresAt: Date;
  wrongAttempts: number;
  cooldownUntil: Date | null;
};

async function activeAttempt(
  tx: GuestVerificationDatabase,
  siteId: string,
  invitationId: string,
  now: Date,
): Promise<Attempt | undefined> {
  const result = await tx.execute(sql`
    SELECT id, status, expires_at, wrong_attempts, cooldown_until
    FROM invitation_access_challenge
    WHERE site_id = ${siteId}
      AND invitation_id = ${invitationId}
      AND status IN (
        'PENDING'::invitation_access_challenge_status,
        'LOCKED'::invitation_access_challenge_status
      )
      AND (expires_at > ${now} OR cooldown_until > ${now})
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `);
  const row = result.rows[0] as
    | {
        id: string;
        status: Attempt["status"];
        expires_at: Date | string;
        wrong_attempts: number;
        cooldown_until: Date | string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status,
    expiresAt: asDate(row.expires_at),
    wrongAttempts: row.wrong_attempts,
    cooldownUntil: row.cooldown_until ? asDate(row.cooldown_until) : null,
  };
}

async function recordInvalidPin(
  tx: GuestVerificationDatabase,
  invitation: InvitationIdentity,
  attempt: Attempt | undefined,
  now: Date,
  attemptIdGenerator?: () => string,
): Promise<void> {
  const wrongAttempts = (attempt?.wrongAttempts ?? 0) + 1;
  const locked = wrongAttempts >= INVITATION_CHALLENGE_WRONG_ATTEMPT_LIMIT;
  const cooldownUntil = locked
    ? new Date(now.getTime() + INVITATION_ACCESS_COOLDOWN_MS)
    : null;
  const expiresAt =
    attempt?.expiresAt ?? new Date(now.getTime() + INVITATION_CHALLENGE_TTL_MS);
  if (attempt) {
    await tx
      .update(invitationAccessChallenge)
      .set({
        status: locked ? "LOCKED" : "PENDING",
        wrongAttempts,
        cooldownUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(invitationAccessChallenge.siteId, invitation.siteId),
          eq(invitationAccessChallenge.id, attempt.id),
        ),
      );
    return;
  }
  await tx.insert(invitationAccessChallenge).values({
    id: attemptIdGenerator?.() ?? randomUUID(),
    siteId: invitation.siteId,
    invitationId: invitation.id,
    status: locked ? "LOCKED" : "PENDING",
    phoneE164: invitation.phone,
    expiresAt,
    wrongAttempts,
    cooldownUntil,
    createdAt: now,
    updatedAt: now,
  });
}

async function markAttemptVerified(
  tx: GuestVerificationDatabase,
  attempt: Attempt | undefined,
  siteId: string,
  now: Date,
): Promise<void> {
  if (!attempt) return;
  await tx
    .update(invitationAccessChallenge)
    .set({ status: "VERIFIED", verifiedAt: now, updatedAt: now })
    .where(
      and(
        eq(invitationAccessChallenge.siteId, siteId),
        eq(invitationAccessChallenge.id, attempt.id),
        eq(invitationAccessChallenge.status, "PENDING"),
      ),
    );
}

type AccessOutcome =
  | AccessFailure
  | { kind: "SUCCESS"; session: InvitationSessionResponse };

async function verifyInvitationAccessInTransaction(
  tx: GuestVerificationDatabase,
  siteId: string,
  input: InvitationAccessInput,
  options: GuestVerificationOptions,
  now: Date,
): Promise<AccessOutcome> {
  const siteResult = await tx.execute(
    sql`SELECT id FROM site WHERE id = ${siteId} AND lifecycle <> 'INACTIVE' FOR UPDATE`,
  );
  if (siteResult.rows.length === 0) {
    return {
      kind: "ERROR",
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    };
  }

  const limited = await reservePinVerification(tx, {
    siteId,
    phone: input.phone,
    ipAddress: options.ipAddress,
    fingerprintSecret: options.fingerprintSecret,
    now,
  });
  if (limited) return limited;

  const invitation = await findInvitationForAccess(tx, siteId, input.phone);
  if (!invitation) {
    const dummyPin = deriveInvitationAccessPin(
      siteId,
      DUMMY_INVITATION_ID,
      DUMMY_PIN_SEED,
      options.fingerprintSecret,
    );
    invitationPinMatches(dummyPin, input.accessPin);
    return {
      kind: "ERROR",
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    };
  }

  const attempt = await activeAttempt(tx, siteId, invitation.id, now);
  if (
    attempt?.status === "LOCKED" &&
    attempt.cooldownUntil &&
    attempt.cooldownUntil > now
  ) {
    return {
      kind: "ERROR",
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    };
  }

  const expectedPin = deriveInvitationAccessPin(
    siteId,
    invitation.id,
    invitation.manualPinSeed,
    options.fingerprintSecret,
  );
  if (!invitationPinMatches(expectedPin, input.accessPin)) {
    await recordInvalidPin(
      tx,
      invitation,
      attempt,
      now,
      options.attemptIdGenerator,
    );
    return {
      kind: "ERROR",
      status: 401,
      code: "INVITATION_ACCESS_INVALID",
      title: "Phone or access PIN is invalid",
    };
  }

  await markAttemptVerified(tx, attempt, siteId, now);
  const token = validateSessionToken(
    options.sessionTokenGenerator?.() ?? opaqueToken(),
  );
  return {
    kind: "SUCCESS",
    session: await createInvitationSessionInTransaction(tx, {
      siteId,
      invitationId: invitation.id,
      invitationName: invitation.name,
      token,
      now,
    }),
  };
}

export async function startInvitationSession(
  db: GuestVerificationDatabase,
  siteId: string,
  inputValue: unknown,
  options: GuestVerificationOptions,
): Promise<InvitationSessionResponse> {
  const input = invitationAccessInputSchema.parse(inputValue);
  const now = currentTime(options.now);
  const result = await db.transaction((tx) =>
    verifyInvitationAccessInTransaction(tx, siteId, input, options, now),
  );
  if (result.kind === "ERROR") {
    reject(result.status, result.code, result.title, result.retryAfterSeconds);
  }
  return result.session;
}

type SessionRecord = {
  id: string;
  siteId: string;
  invitationId: string;
  invitationName: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lifecycle: string;
};

async function findSession(
  db: GuestVerificationDatabase,
  token: string,
  lock = false,
): Promise<SessionRecord | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const tokenHash = hashInvitationSessionToken(token);
  const result = await db.execute(sql`
    SELECT invitation_session.id, invitation_session.site_id,
      invitation_session.invitation_id, invitation_session.expires_at,
      invitation_session.revoked_at, invitation.name AS invitation_name,
      site.lifecycle
    FROM invitation_session
    INNER JOIN site ON site.id = invitation_session.site_id
    INNER JOIN invitation ON invitation.site_id = invitation_session.site_id
      AND invitation.id = invitation_session.invitation_id
    WHERE invitation_session.token_hash = ${tokenHash}
    ${lock ? sql`FOR UPDATE OF invitation_session` : sql``}
  `);
  const row = result.rows[0] as
    | {
        id: string;
        site_id: string;
        invitation_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        invitation_name: string;
        lifecycle: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    siteId: row.site_id,
    invitationId: row.invitation_id,
    invitationName: row.invitation_name,
    expiresAt: asDate(row.expires_at),
    revokedAt: row.revoked_at ? asDate(row.revoked_at) : null,
    lifecycle: row.lifecycle,
  };
}

function invalidSession(): never {
  reject(401, "SESSION_INVALID", "Invitation session is invalid");
}

export async function readInvitationSession(
  db: GuestVerificationDatabase,
  token: string,
  nowValue?: Date,
): Promise<InvitationSessionReadResponse> {
  const now = currentTime(nowValue);
  const record = await findSession(db, token);
  if (
    !record ||
    record.revokedAt ||
    record.expiresAt <= now ||
    record.lifecycle === "INACTIVE"
  ) {
    invalidSession();
  }
  const guests = await listInvitationGuests(
    db,
    record.siteId,
    record.invitationId,
  );
  if (guests.length === 0) invalidSession();
  return invitationSessionReadResponseSchema.parse({
    siteId: record.siteId,
    invitationId: record.invitationId,
    invitationName: record.invitationName,
    guests,
    expiresAt: record.expiresAt.toISOString(),
  });
}

export async function leaveInvitationSession(
  db: GuestVerificationDatabase,
  token: string,
  nowValue?: Date,
): Promise<{ ok: true }> {
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const record = await findSession(tx, token, true);
    if (!record || record.revokedAt || record.expiresAt <= now) {
      invalidSession();
    }
    await tx
      .update(invitationSession)
      .set({ revokedAt: now, revocationReason: "EXPLICIT_LEAVE" })
      .where(
        and(
          eq(invitationSession.id, record.id),
          isNull(invitationSession.revokedAt),
        ),
      );
    return { ok: true } as const;
  });
}

export async function invitationSessionSiteId(
  db: GuestVerificationDatabase,
  token: string | undefined,
): Promise<string | undefined> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const rows = await db
    .select({ siteId: invitationSession.siteId })
    .from(invitationSession)
    .where(eq(invitationSession.tokenHash, hashInvitationSessionToken(token)))
    .limit(1);
  return rows[0]?.siteId;
}
