import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type GuestChallengeStartResponse,
  type GuestLookupInput,
  guestChallengeResendInputSchema,
  guestChallengeStartResponseSchema,
  guestChallengeVerifyInputSchema,
  guestLookupInputSchema,
} from "@entrelacos/contracts";
import {
  guestRateLimitEvent,
  guestVerificationChallenge,
  guestVerificationSend,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createFamilySessionInTransaction,
  type FamilySessionDatabase,
} from "./familySession";
import { deriveGuestGroupAccessPin } from "./guestGroups";
import { lookupGuestGroup } from "./guestLookup";

export type GuestVerificationDatabase = NodePgDatabase<Record<string, never>>;

export const GUEST_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const GUEST_RESEND_WAIT_MS = 60 * 1000;
export const GUEST_COOLDOWN_MS = 15 * 60 * 1000;
export const GUEST_SEND_SHORT_LIMIT = 3;
export const GUEST_SEND_SHORT_WINDOW_MS = 15 * 60 * 1000;
export const GUEST_SEND_LONG_LIMIT = 10;
export const GUEST_SEND_LONG_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GUEST_VERIFY_LIMIT = 10;
export const GUEST_VERIFY_WINDOW_MS = 15 * 60 * 1000;
export const GUEST_IP_SEND_SHORT_LIMIT = 10;
export const GUEST_IP_SEND_SHORT_WINDOW_MS = 15 * 60 * 1000;
export const GUEST_IP_SEND_LONG_LIMIT = 30;
export const GUEST_IP_SEND_LONG_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GUEST_PHONE_SEND_SHORT_LIMIT = 3;
export const GUEST_PHONE_SEND_SHORT_WINDOW_MS = 15 * 60 * 1000;
export const GUEST_PHONE_SEND_LONG_LIMIT = 10;
export const GUEST_PHONE_SEND_LONG_WINDOW_MS = 24 * 60 * 60 * 1000;

export type GuestDeliveryMode = "MANUAL_PIN" | "SIMULATED" | "REAL_SMS";

export type GuestProviderResult =
  | { status: "PROVIDER_ACCEPTED"; providerReference?: string }
  | { status: "FAILED_FINAL"; failureCode?: string }
  | { status: "UNKNOWN"; failureCode?: string };

export type GuestProviderCheckResult =
  | { status: "APPROVED" }
  | { status: "DECLINED" }
  | { status: "UNKNOWN"; failureCode?: string };

export interface GuestVerificationProvider {
  mode: "MOCK" | "TWILIO";
  send(input: {
    phoneE164: string;
    code: string;
    challengeId: string;
  }): Promise<GuestProviderResult>;
  check?(input: {
    phoneE164: string;
    code: string;
    challengeId: string;
  }): Promise<GuestProviderCheckResult>;
}

export type GuestCodeGenerator = () => string;
export type GuestChallengeIdGenerator = () => string;
export type GuestSessionTokenGenerator = () => string;

export interface GuestVerificationOptions {
  ipAddress: string;
  fingerprintSecret: string;
  smsMode?: "manual" | "simulated" | "real";
  now?: Date;
  provider?: GuestVerificationProvider;
  codeGenerator?: GuestCodeGenerator;
  challengeIdGenerator?: GuestChallengeIdGenerator;
  sessionTokenGenerator?: GuestSessionTokenGenerator;
  exposeSimulationCode?: boolean;
}

export type GuestVerificationResult = GuestChallengeStartResponse;

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
  return value instanceof Date ? value : new Date(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  kind: "code" | "token" | "challenge",
): string {
  const valid =
    kind === "code" ? /^\d{6}$/.test(value) : /^[A-Za-z0-9_-]{43}$/.test(value);
  if (!valid) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Guest verification is not configured",
    );
  }
  return value;
}

function defaultCode(): string {
  return "123456";
}

function defaultProvider(): GuestVerificationProvider {
  return {
    mode: "MOCK",
    async send() {
      return { status: "PROVIDER_ACCEPTED", providerReference: "mock" };
    },
  };
}

function configuredProvider(
  options: GuestVerificationOptions,
): GuestVerificationProvider {
  if (options.smsMode === "real" && !options.provider) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Real SMS provider is not configured",
    );
  }
  const provider = options.provider ?? defaultProvider();
  if (options.smsMode === "real" && provider.mode !== "TWILIO") {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Real SMS provider is not configured",
    );
  }
  return provider;
}

function deliveryMode(provider: GuestVerificationProvider): GuestDeliveryMode {
  return provider.mode === "MOCK" ? "SIMULATED" : "REAL_SMS";
}

function output(
  record: {
    id: string;
    expiresAt: Date;
    resendAvailableAt: Date;
    sendStatus:
      | "MANUAL"
      | "RESERVED"
      | "PROVIDER_ACCEPTED"
      | "FAILED_FINAL"
      | "UNKNOWN";
  },
  provider: GuestVerificationProvider,
  code: string,
  exposeSimulationCode: boolean,
): GuestVerificationResult {
  const result: Record<string, unknown> = {
    challengeId: record.id,
    expiresAt: record.expiresAt.toISOString(),
    resendAvailableAt: record.resendAvailableAt.toISOString(),
    sendStatus: record.sendStatus,
    deliveryMode: deliveryMode(provider),
  };
  if (
    provider.mode === "MOCK" &&
    exposeSimulationCode &&
    record.sendStatus !== "FAILED_FINAL"
  ) {
    result.simulationCode = code;
  }
  return guestChallengeStartResponseSchema.parse(result);
}

function providerResult(value: unknown): GuestProviderResult {
  if (!value || typeof value !== "object") return { status: "UNKNOWN" };
  const status = (value as { status?: unknown }).status;
  if (
    status === "PROVIDER_ACCEPTED" ||
    status === "FAILED_FINAL" ||
    status === "UNKNOWN"
  ) {
    const reference = (value as { providerReference?: unknown })
      .providerReference;
    const failureCode = (value as { failureCode?: unknown }).failureCode;
    return {
      status,
      ...(typeof reference === "string"
        ? { providerReference: reference }
        : {}),
      ...(typeof failureCode === "string" ? { failureCode } : {}),
    } as GuestProviderResult;
  }
  return { status: "UNKNOWN" };
}

function providerCheckResult(value: unknown): GuestProviderCheckResult {
  if (!value || typeof value !== "object") return { status: "UNKNOWN" };
  const status = (value as { status?: unknown }).status;
  if (status === "APPROVED" || status === "DECLINED") return { status };
  if (status === "UNKNOWN") {
    const failureCode = (value as { failureCode?: unknown }).failureCode;
    return {
      status,
      ...(typeof failureCode === "string" ? { failureCode } : {}),
    };
  }
  return { status: "UNKNOWN" };
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
  representativeMemberId: string;
  manualPinSeed: string;
}> {
  const result = await tx.execute(sql`
    SELECT id, site_id, phone_e164, is_foreign, representative_member_id,
      manual_pin_seed
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
        representative_member_id: string;
        manual_pin_seed: string;
      }
    | undefined;
  if (!row) reject(404, "GUEST_NOT_FOUND", "Guest not found");
  return {
    id: row.id,
    siteId: row.site_id,
    phoneE164: row.phone_e164,
    isForeign: row.is_foreign,
    representativeMemberId: row.representative_member_id,
    manualPinSeed: row.manual_pin_seed,
  };
}

async function lockChallenge(
  tx: Transaction,
  challengeId: string,
): Promise<{
  id: string;
  siteId: string;
  groupId: string;
  phoneE164: string;
  mode: "MANUAL" | "MOCK" | "TWILIO";
  status: "PENDING" | "VERIFIED" | "EXPIRED" | "LOCKED" | "REVOKED";
  codeHash: string | null;
  expiresAt: Date;
  resendAvailableAt: Date;
  wrongAttempts: number;
  cooldownUntil: Date | null;
  sendStatus:
    | "MANUAL"
    | "RESERVED"
    | "PROVIDER_ACCEPTED"
    | "FAILED_FINAL"
    | "UNKNOWN";
  createdAt: Date;
}> {
  const result = await tx.execute(sql`
    SELECT id, site_id, group_id, phone_e164, mode, status, code_hash,
      expires_at, resend_available_at, wrong_attempts, cooldown_until,
      COALESCE((SELECT status FROM guest_verification_send
       WHERE site_id = guest_verification_challenge.site_id
         AND challenge_id = guest_verification_challenge.id
       ORDER BY created_at DESC LIMIT 1),
       CASE WHEN mode = 'MANUAL' THEN 'MANUAL'::guest_verification_send_status END
      ) AS send_status,
      created_at
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
        mode: "MANUAL" | "MOCK" | "TWILIO";
        status: "PENDING" | "VERIFIED" | "EXPIRED" | "LOCKED" | "REVOKED";
        code_hash: string | null;
        expires_at: Date | string;
        resend_available_at: Date | string;
        wrong_attempts: number;
        cooldown_until: Date | string | null;
        send_status:
          | "MANUAL"
          | "RESERVED"
          | "PROVIDER_ACCEPTED"
          | "FAILED_FINAL"
          | "UNKNOWN";
        created_at: Date | string;
      }
    | undefined;
  if (!row) reject(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
  return {
    id: row.id,
    siteId: row.site_id,
    groupId: row.group_id,
    phoneE164: row.phone_e164,
    mode: row.mode,
    status: row.status,
    codeHash: row.code_hash,
    expiresAt: asDate(row.expires_at),
    resendAvailableAt: asDate(row.resend_available_at),
    wrongAttempts: row.wrong_attempts,
    cooldownUntil: row.cooldown_until ? asDate(row.cooldown_until) : null,
    sendStatus: row.send_status,
    createdAt: asDate(row.created_at),
  };
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

async function reserveScope(
  tx: Transaction,
  input: {
    action: "OTP_SEND" | "OTP_VERIFY";
    scopeKey: string;
    limit: number;
    windowMs: number;
    now: Date;
    siteId: string | null;
    groupId: string | null;
    ipFingerprint: string;
    phoneFingerprint: string | null;
  },
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.scopeKey}, 0))`,
  );
  const cutoff = new Date(input.now.getTime() - input.windowMs);
  const result = await tx.execute(sql`
    SELECT occurred_at
    FROM guest_rate_limit_event
    WHERE action = ${input.action}::guest_rate_limit_action
      AND scope_key = ${input.scopeKey}
      AND occurred_at > ${cutoff}
      AND occurred_at <= ${input.now}
    ORDER BY occurred_at ASC
    LIMIT ${input.limit}
  `);
  if (result.rows.length >= input.limit) {
    const oldest = asDate(
      (result.rows[0] as { occurred_at: Date | string }).occurred_at,
    );
    reject(
      429,
      input.action === "OTP_SEND"
        ? "OTP_SEND_RATE_LIMITED"
        : "OTP_VERIFY_RATE_LIMITED",
      "Too many verification attempts",
      secondsUntil(new Date(oldest.getTime() + input.windowMs), input.now),
    );
  }
  await tx.insert(guestRateLimitEvent).values({
    id: randomUUID(),
    siteId: input.siteId,
    groupId: input.groupId,
    action: input.action,
    scopeKey: input.scopeKey,
    ipFingerprint: input.ipFingerprint,
    phoneFingerprint: input.phoneFingerprint,
    occurredAt: input.now,
  });
}

async function reserveOtpSend(
  tx: Transaction,
  input: {
    siteId: string;
    groupId: string;
    phoneE164: string;
    ipAddress: string;
    fingerprintSecret: string;
    now: Date;
  },
): Promise<void> {
  const ipFingerprint = fingerprint(
    input.ipAddress,
    input.fingerprintSecret,
    "guest-ip",
  );
  const phoneFingerprint = fingerprint(
    input.phoneE164,
    input.fingerprintSecret,
    "guest-phone",
  );
  const groupScope = `send:group:${input.siteId}:${input.groupId}:${phoneFingerprint}`;
  const phoneShortScope = `send:phone:short:${phoneFingerprint}`;
  const phoneLongScope = `send:phone:long:${phoneFingerprint}`;
  const ipShortScope = `send:ip:short:${ipFingerprint}`;
  const ipLongScope = `send:ip:long:${ipFingerprint}`;
  for (const key of [
    groupScope,
    phoneShortScope,
    phoneLongScope,
    ipShortScope,
    ipLongScope,
  ].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: groupScope,
    limit: GUEST_SEND_SHORT_LIMIT,
    windowMs: GUEST_SEND_SHORT_WINDOW_MS,
    now: input.now,
    siteId: input.siteId,
    groupId: input.groupId,
    ipFingerprint,
    phoneFingerprint,
  });
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: phoneShortScope,
    limit: GUEST_PHONE_SEND_SHORT_LIMIT,
    windowMs: GUEST_PHONE_SEND_SHORT_WINDOW_MS,
    now: input.now,
    siteId: null,
    groupId: null,
    ipFingerprint,
    phoneFingerprint,
  });
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: phoneLongScope,
    limit: GUEST_PHONE_SEND_LONG_LIMIT,
    windowMs: GUEST_PHONE_SEND_LONG_WINDOW_MS,
    now: input.now,
    siteId: null,
    groupId: null,
    ipFingerprint,
    phoneFingerprint,
  });
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: `${groupScope}:long`,
    limit: GUEST_SEND_LONG_LIMIT,
    windowMs: GUEST_SEND_LONG_WINDOW_MS,
    now: input.now,
    siteId: input.siteId,
    groupId: input.groupId,
    ipFingerprint,
    phoneFingerprint,
  });
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: ipShortScope,
    limit: GUEST_IP_SEND_SHORT_LIMIT,
    windowMs: GUEST_IP_SEND_SHORT_WINDOW_MS,
    now: input.now,
    siteId: null,
    groupId: null,
    ipFingerprint,
    phoneFingerprint: null,
  });
  await reserveScope(tx, {
    action: "OTP_SEND",
    scopeKey: ipLongScope,
    limit: GUEST_IP_SEND_LONG_LIMIT,
    windowMs: GUEST_IP_SEND_LONG_WINDOW_MS,
    now: input.now,
    siteId: null,
    groupId: null,
    ipFingerprint,
    phoneFingerprint: null,
  });
}

async function reserveOtpVerify(
  tx: Transaction,
  input: { ipAddress: string; fingerprintSecret: string; now: Date },
): Promise<void> {
  const ipFingerprint = fingerprint(
    input.ipAddress,
    input.fingerprintSecret,
    "guest-ip",
  );
  await reserveScope(tx, {
    action: "OTP_VERIFY",
    scopeKey: `verify:ip:${ipFingerprint}`,
    limit: GUEST_VERIFY_LIMIT,
    windowMs: GUEST_VERIFY_WINDOW_MS,
    now: input.now,
    siteId: null,
    groupId: null,
    ipFingerprint,
    phoneFingerprint: null,
  });
}

async function sendReserved(
  db: GuestVerificationDatabase,
  reservation: {
    sendId: string;
    challengeId: string;
    siteId: string;
    phoneE164: string;
    code: string;
    provider: GuestVerificationProvider;
    now: Date;
  },
): Promise<GuestProviderResult> {
  let result: GuestProviderResult;
  try {
    result = providerResult(
      await reservation.provider.send({
        phoneE164: reservation.phoneE164,
        code: reservation.code,
        challengeId: reservation.challengeId,
      }),
    );
  } catch {
    result = { status: "UNKNOWN" };
  }
  const completedAt = new Date(reservation.now.getTime());
  await db
    .update(guestVerificationSend)
    .set({
      status: result.status,
      providerReference:
        "providerReference" in result
          ? (result.providerReference ?? null)
          : null,
      failureCode:
        "failureCode" in result ? (result.failureCode ?? null) : null,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(guestVerificationSend.siteId, reservation.siteId),
        eq(guestVerificationSend.id, reservation.sendId),
      ),
    );
  if (result.status === "FAILED_FINAL") {
    await db
      .update(guestVerificationChallenge)
      .set({ codeHash: null, updatedAt: completedAt })
      .where(
        and(
          eq(guestVerificationChallenge.id, reservation.challengeId),
          sql`NOT EXISTS (
            SELECT 1
            FROM guest_verification_send AS newer_send
            WHERE newer_send.challenge_id = ${reservation.challengeId}
              AND newer_send.reserved_at > ${reservation.now}
          )`,
        ),
      );
  }
  return result;
}

async function challengeOutput(
  db: GuestVerificationDatabase,
  challengeId: string,
  sendId: string,
  provider: GuestVerificationProvider,
  code: string,
  exposeSimulationCode: boolean,
): Promise<GuestVerificationResult> {
  const [row] = await db
    .select({
      id: guestVerificationChallenge.id,
      expiresAt: guestVerificationChallenge.expiresAt,
      resendAvailableAt: guestVerificationChallenge.resendAvailableAt,
      sendStatus: guestVerificationSend.status,
    })
    .from(guestVerificationChallenge)
    .innerJoin(
      guestVerificationSend,
      and(
        eq(guestVerificationSend.siteId, guestVerificationChallenge.siteId),
        eq(guestVerificationSend.challengeId, guestVerificationChallenge.id),
      ),
    )
    .where(
      and(
        eq(guestVerificationChallenge.id, challengeId),
        eq(guestVerificationSend.id, sendId),
      ),
    )
    .limit(1);
  if (!row) reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  return output(row, provider, code, exposeSimulationCode);
}

async function reserveChallenge(
  db: GuestVerificationDatabase,
  input: GuestLookupInput,
  siteId: string,
  options: Required<
    Pick<GuestVerificationOptions, "ipAddress" | "fingerprintSecret">
  > &
    GuestVerificationOptions,
  existingChallengeId?: string,
): Promise<{
  challengeId: string;
  siteId: string;
  sendId: string;
  phoneE164: string;
  code: string;
  provider: GuestVerificationProvider;
  expiresAt: Date;
  resendAvailableAt: Date;
}> {
  const now = currentTime(options.now);
  const provider = configuredProvider(options);
  const code = validateGeneratedValue(
    options.codeGenerator?.() ?? defaultCode(),
    "code",
  );
  const challengeId = existingChallengeId
    ? validateGeneratedValue(existingChallengeId, "challenge")
    : validateGeneratedValue(
        options.challengeIdGenerator?.() ?? opaqueToken(),
        "challenge",
      );
  const lookup = existingChallengeId
    ? undefined
    : await lookupGuestGroup(db, siteId, input, {
        ipAddress: options.ipAddress,
        fingerprintSecret: options.fingerprintSecret,
        now,
      });
  if (lookup?.kind === "FOREIGN_ADMIN_ONLY") {
    reject(
      422,
      "FOREIGN_GUEST_CONTACT_ADMIN",
      "Please contact the wedding administrator",
    );
  }
  if (lookup?.kind === "NO_MATCH") {
    reject(404, "GUEST_NOT_FOUND", "Guest not found");
  }
  return db.transaction(async (tx) => {
    await lockSite(tx, siteId);
    let groupId: string;
    let phoneE164: string;
    let createdAt: Date;
    let expiresAt: Date;
    let resendAvailableAt: Date;
    if (existingChallengeId) {
      const challenge = await lockChallenge(tx, existingChallengeId);
      if (challenge.siteId !== siteId)
        reject(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
      if (challenge.status === "PENDING" && challenge.expiresAt <= now) {
        await tx
          .update(guestVerificationChallenge)
          .set({ status: "EXPIRED", updatedAt: now })
          .where(eq(guestVerificationChallenge.id, challenge.id));
        reject(410, "CHALLENGE_EXPIRED", "Challenge expired");
      }
      if (challenge.status !== "PENDING") {
        if (
          challenge.status === "LOCKED" &&
          challenge.cooldownUntil &&
          challenge.cooldownUntil > now
        ) {
          reject(
            429,
            "CHALLENGE_COOLDOWN",
            "Verification temporarily locked",
            secondsUntil(challenge.cooldownUntil, now),
          );
        }
        reject(409, "CHALLENGE_NOT_ACTIVE", "Challenge is not active");
      }
      if (provider.mode !== challenge.mode) {
        reject(
          503,
          "VERIFICATION_CONFIGURATION_ERROR",
          "Guest verification provider does not match challenge",
        );
      }
      if (challenge.cooldownUntil && challenge.cooldownUntil > now) {
        reject(
          429,
          "CHALLENGE_COOLDOWN",
          "Verification temporarily locked",
          secondsUntil(challenge.cooldownUntil, now),
        );
      }
      if (challenge.resendAvailableAt > now) {
        reject(
          429,
          "RESEND_TOO_SOON",
          "Resend is not available yet",
          secondsUntil(challenge.resendAvailableAt, now),
        );
      }
      groupId = challenge.groupId;
      phoneE164 = challenge.phoneE164;
      createdAt = challenge.createdAt;
      expiresAt = challenge.expiresAt;
      resendAvailableAt = new Date(now.getTime() + GUEST_RESEND_WAIT_MS);
      await lockGroup(tx, siteId, groupId);
      await reserveOtpSend(tx, {
        siteId,
        groupId,
        phoneE164,
        ipAddress: options.ipAddress,
        fingerprintSecret: options.fingerprintSecret,
        now,
      });
      const sendId = randomUUID();
      await tx
        .update(guestVerificationChallenge)
        .set({
          codeHash: provider.mode === "MOCK" ? hash(code) : null,
          resendAvailableAt,
          updatedAt: now,
        })
        .where(eq(guestVerificationChallenge.id, challenge.id));
      await tx.insert(guestVerificationSend).values({
        id: sendId,
        siteId,
        groupId,
        challengeId,
        phoneE164,
        status: "RESERVED",
        reservedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return {
        challengeId,
        siteId,
        sendId,
        phoneE164,
        code,
        provider,
        expiresAt,
        resendAvailableAt,
      };
    }

    if (lookup?.kind !== "MATCH") {
      reject(404, "GUEST_NOT_FOUND", "Guest not found");
    }
    groupId = lookup.groupId;
    phoneE164 = lookup.phoneE164;
    const group = await lockGroup(tx, siteId, groupId);
    if (group.isForeign || group.phoneE164 !== phoneE164) {
      reject(404, "GUEST_NOT_FOUND", "Guest not found");
    }
    const cooldown = await tx.execute(sql`
      SELECT cooldown_until
      FROM guest_verification_challenge
      WHERE site_id = ${siteId} AND group_id = ${groupId}
        AND phone_e164 = ${phoneE164}
        AND cooldown_until IS NOT NULL AND cooldown_until > ${now}
      ORDER BY cooldown_until DESC
      LIMIT 1
    `);
    const cooldownUntilRaw = (
      cooldown.rows[0] as { cooldown_until: Date | string } | undefined
    )?.cooldown_until;
    const cooldownUntil = cooldownUntilRaw
      ? asDate(cooldownUntilRaw)
      : undefined;
    if (cooldownUntil) {
      reject(
        429,
        "CHALLENGE_COOLDOWN",
        "Verification temporarily locked",
        secondsUntil(cooldownUntil, now),
      );
    }
    const active = await tx.execute(sql`
      SELECT id
      FROM guest_verification_challenge
      WHERE site_id = ${siteId} AND group_id = ${groupId}
        AND status = 'PENDING' AND expires_at > ${now}
      FOR UPDATE
    `);
    if (active.rows.length > 0) {
      await tx
        .update(guestVerificationChallenge)
        .set({
          status: "REVOKED",
          revokedAt: now,
          revocationReason: "SUPERSEDED",
          updatedAt: now,
        })
        .where(
          and(
            eq(guestVerificationChallenge.siteId, siteId),
            eq(guestVerificationChallenge.groupId, groupId),
            eq(guestVerificationChallenge.status, "PENDING"),
          ),
        );
    }
    await reserveOtpSend(tx, {
      siteId,
      groupId,
      phoneE164,
      ipAddress: options.ipAddress,
      fingerprintSecret: options.fingerprintSecret,
      now,
    });
    createdAt = now;
    expiresAt = new Date(now.getTime() + GUEST_CHALLENGE_TTL_MS);
    resendAvailableAt = new Date(now.getTime() + GUEST_RESEND_WAIT_MS);
    const sendId = randomUUID();
    await tx.insert(guestVerificationChallenge).values({
      id: challengeId,
      siteId,
      groupId,
      mode: provider.mode,
      status: "PENDING",
      phoneE164,
      codeHash: provider.mode === "MOCK" ? hash(code) : null,
      expiresAt,
      resendAvailableAt,
      wrongAttempts: 0,
      createdAt,
      updatedAt: now,
    });
    await tx.insert(guestVerificationSend).values({
      id: sendId,
      siteId,
      groupId,
      challengeId,
      phoneE164,
      status: "RESERVED",
      reservedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return {
      challengeId,
      siteId,
      sendId,
      phoneE164,
      code,
      provider,
      expiresAt,
      resendAvailableAt,
    };
  });
}

async function dispatchChallenge(
  db: GuestVerificationDatabase,
  reservation: Awaited<ReturnType<typeof reserveChallenge>>,
  options: GuestVerificationOptions,
): Promise<GuestVerificationResult> {
  const provider = reservation.provider;
  await sendReserved(db, {
    ...reservation,
    provider,
    now: currentTime(options.now),
  });
  return challengeOutput(
    db,
    reservation.challengeId,
    reservation.sendId,
    provider,
    reservation.code,
    options.exposeSimulationCode === true,
  );
}

async function startManualChallenge(
  db: GuestVerificationDatabase,
  siteId: string,
  input: GuestLookupInput,
  options: GuestVerificationOptions,
): Promise<GuestVerificationResult> {
  const now = currentTime(options.now);
  const challengeId = validateGeneratedValue(
    options.challengeIdGenerator?.() ?? opaqueToken(),
    "challenge",
  );
  const lookup = await lookupGuestGroup(db, siteId, input, {
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
        AND phone_e164 = ${lookup.phoneE164}
        AND cooldown_until IS NOT NULL AND cooldown_until > ${now}
      ORDER BY cooldown_until DESC
      LIMIT 1
    `);
    const cooldownUntilRaw = (
      cooldown.rows[0] as { cooldown_until: Date | string } | undefined
    )?.cooldown_until;
    if (cooldownUntilRaw) {
      const cooldownUntil = asDate(cooldownUntilRaw);
      reject(
        429,
        "CHALLENGE_COOLDOWN",
        "Verification temporarily locked",
        secondsUntil(cooldownUntil, now),
      );
    }
    const active = await tx.execute(sql`
      SELECT id
      FROM guest_verification_challenge
      WHERE site_id = ${siteId} AND group_id = ${group.id}
        AND status = 'PENDING' AND expires_at > ${now}
      FOR UPDATE
    `);
    if (active.rows.length > 0) {
      await tx
        .update(guestVerificationChallenge)
        .set({
          status: "REVOKED",
          revokedAt: now,
          revocationReason: "SUPERSEDED",
          updatedAt: now,
        })
        .where(
          and(
            eq(guestVerificationChallenge.siteId, siteId),
            eq(guestVerificationChallenge.groupId, group.id),
            eq(guestVerificationChallenge.status, "PENDING"),
          ),
        );
    }
    const expiresAt = new Date(now.getTime() + GUEST_CHALLENGE_TTL_MS);
    await tx.insert(guestVerificationChallenge).values({
      id: challengeId,
      siteId,
      groupId: group.id,
      mode: "MANUAL",
      status: "PENDING",
      phoneE164: lookup.phoneE164,
      codeHash: null,
      expiresAt,
      resendAvailableAt: expiresAt,
      wrongAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return guestChallengeStartResponseSchema.parse({
      challengeId,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: expiresAt.toISOString(),
      sendStatus: "MANUAL",
      deliveryMode: "MANUAL_PIN",
    });
  });
}

export async function startGuestChallenge(
  db: GuestVerificationDatabase,
  siteId: string,
  input: unknown,
  options: GuestVerificationOptions,
): Promise<GuestVerificationResult> {
  const value = guestLookupInputSchema.parse(input);
  if (options.smsMode === "manual") {
    return startManualChallenge(db, siteId, value, options);
  }
  const reservation = await reserveChallenge(
    db,
    value,
    siteId,
    options as Required<
      Pick<GuestVerificationOptions, "ipAddress" | "fingerprintSecret">
    > &
      GuestVerificationOptions,
  );
  return dispatchChallenge(db, reservation, options);
}

export async function resendGuestChallenge(
  db: GuestVerificationDatabase,
  challengeId: string,
  input: unknown,
  options: GuestVerificationOptions,
): Promise<GuestVerificationResult> {
  const value = guestChallengeResendInputSchema.parse(input);
  if (value.challengeId !== challengeId) {
    reject(400, "VALIDATION_ERROR", "Invalid verification request");
  }
  const challenge = await db
    .select({
      siteId: guestVerificationChallenge.siteId,
      mode: guestVerificationChallenge.mode,
    })
    .from(guestVerificationChallenge)
    .where(eq(guestVerificationChallenge.id, challengeId))
    .limit(1);
  if (!challenge[0]) reject(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
  if (challenge[0].mode === "MANUAL") {
    reject(
      409,
      "MANUAL_PIN_NO_RESEND",
      "Manual PIN challenges cannot be resent",
    );
  }
  const reservation = await reserveChallenge(
    db,
    { fullName: "placeholder", phone: "+5511999999999" },
    challenge[0].siteId,
    options as Required<
      Pick<GuestVerificationOptions, "ipAddress" | "fingerprintSecret">
    > &
      GuestVerificationOptions,
    challengeId,
  );
  return dispatchChallenge(db, reservation, options);
}

type VerificationOutcome =
  | {
      kind: "ERROR";
      status: number;
      code: string;
      title: string;
      retryAfterSeconds?: number;
    }
  | {
      kind: "SUCCESS";
      session: Awaited<ReturnType<typeof createFamilySessionInTransaction>>;
    };
type VerificationError = Extract<VerificationOutcome, { kind: "ERROR" }>;

function verificationError(
  status: number,
  code: string,
  title: string,
  retryAfterSeconds?: number,
): VerificationError {
  return { kind: "ERROR", status, code, title, retryAfterSeconds };
}

async function finishProviderVerification(
  tx: Transaction,
  challengeId: string,
  now: Date,
  result: "APPROVED" | "DECLINED" | "UNKNOWN",
  sessionTokenGenerator: GuestSessionTokenGenerator,
): Promise<VerificationOutcome> {
  const challenge = await lockChallenge(tx, challengeId);
  await lockSite(tx, challenge.siteId);
  if (challenge.status === "PENDING" && challenge.expiresAt <= now) {
    await tx
      .update(guestVerificationChallenge)
      .set({ status: "EXPIRED", updatedAt: now })
      .where(eq(guestVerificationChallenge.id, challengeId));
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
  if (
    challenge.status !== "PENDING" ||
    challenge.sendStatus === "FAILED_FINAL" ||
    result === "UNKNOWN"
  ) {
    return result === "UNKNOWN"
      ? verificationError(
          503,
          "PROVIDER_VERIFICATION_UNKNOWN",
          "Verification provider status is unknown",
        )
      : verificationError(
          409,
          "CHALLENGE_NOT_ACTIVE",
          "Challenge is not active",
        );
  }
  if (result === "DECLINED") {
    const wrongAttempts = challenge.wrongAttempts + 1;
    if (wrongAttempts >= 5) {
      const cooldownUntil = new Date(now.getTime() + GUEST_COOLDOWN_MS);
      await tx
        .update(guestVerificationChallenge)
        .set({
          status: "LOCKED",
          wrongAttempts: 5,
          cooldownUntil,
          updatedAt: now,
        })
        .where(eq(guestVerificationChallenge.id, challengeId));
      return verificationError(
        429,
        "CHALLENGE_COOLDOWN",
        "Verification temporarily locked",
        15 * 60,
      );
    }
    await tx
      .update(guestVerificationChallenge)
      .set({ wrongAttempts, updatedAt: now })
      .where(eq(guestVerificationChallenge.id, challengeId));
    return verificationError(401, "INVALID_CODE", "Invalid verification code");
  }
  const token = validateGeneratedValue(sessionTokenGenerator(), "token");
  await tx
    .update(guestVerificationChallenge)
    .set({ status: "VERIFIED", verifiedAt: now, updatedAt: now })
    .where(eq(guestVerificationChallenge.id, challengeId));
  const session = await createFamilySessionInTransaction(
    tx as FamilySessionDatabase,
    {
      siteId: challenge.siteId,
      groupId: challenge.groupId,
      token,
      now,
    },
  );
  return { kind: "SUCCESS", session };
}

async function verifyWithTwilio(
  db: GuestVerificationDatabase,
  challengeId: string,
  code: string,
  options: GuestVerificationOptions,
  provider: GuestVerificationProvider,
  now: Date,
): Promise<Awaited<ReturnType<typeof createFamilySessionInTransaction>>> {
  if (!provider.check) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Real SMS provider is not configured",
    );
  }
  const sessionTokenGenerator = options.sessionTokenGenerator ?? opaqueToken;
  const preflight = await db.transaction(async (tx) => {
    await reserveOtpVerify(tx, {
      ipAddress: options.ipAddress,
      fingerprintSecret: options.fingerprintSecret,
      now,
    });
    const challenge = await lockChallenge(tx, challengeId);
    await lockSite(tx, challenge.siteId);
    if (challenge.mode !== provider.mode) {
      return verificationError(
        503,
        "VERIFICATION_CONFIGURATION_ERROR",
        "Guest verification provider does not match challenge",
      );
    }
    if (challenge.status === "PENDING" && challenge.expiresAt <= now) {
      await tx
        .update(guestVerificationChallenge)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(guestVerificationChallenge.id, challengeId));
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
    if (
      challenge.status !== "PENDING" ||
      challenge.sendStatus === "FAILED_FINAL"
    ) {
      return verificationError(
        409,
        "CHALLENGE_NOT_ACTIVE",
        "Challenge is not active",
      );
    }
    return { kind: "READY" as const, phoneE164: challenge.phoneE164 };
  });
  if (preflight.kind === "ERROR") {
    reject(
      preflight.status,
      preflight.code,
      preflight.title,
      preflight.retryAfterSeconds,
    );
  }
  let providerCheck: GuestProviderCheckResult;
  try {
    providerCheck = providerCheckResult(
      await provider.check({
        phoneE164: preflight.phoneE164,
        code,
        challengeId,
      }),
    );
  } catch {
    providerCheck = { status: "UNKNOWN", failureCode: "TWILIO_NETWORK" };
  }
  const result = await db.transaction((tx) =>
    finishProviderVerification(
      tx,
      challengeId,
      now,
      providerCheck.status,
      sessionTokenGenerator,
    ),
  );
  if (result.kind === "ERROR") {
    reject(result.status, result.code, result.title, result.retryAfterSeconds);
  }
  return result.session;
}

async function verifyWithManualPin(
  db: GuestVerificationDatabase,
  challengeId: string,
  code: string,
  options: GuestVerificationOptions,
  now: Date,
): Promise<Awaited<ReturnType<typeof createFamilySessionInTransaction>>> {
  const [identity] = await db
    .select({
      siteId: guestVerificationChallenge.siteId,
      groupId: guestVerificationChallenge.groupId,
      mode: guestVerificationChallenge.mode,
    })
    .from(guestVerificationChallenge)
    .where(eq(guestVerificationChallenge.id, challengeId))
    .limit(1);
  if (!identity) reject(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
  if (identity.mode !== "MANUAL") {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Guest verification provider does not match challenge",
    );
  }
  const sessionTokenGenerator = options.sessionTokenGenerator ?? opaqueToken;
  const result = await db.transaction(async (tx) => {
    await reserveOtpVerify(tx, {
      ipAddress: options.ipAddress,
      fingerprintSecret: options.fingerprintSecret,
      now,
    });
    await lockSite(tx, identity.siteId);
    const group = await lockGroup(tx, identity.siteId, identity.groupId);
    const challenge = await lockChallenge(tx, challengeId);
    if (
      challenge.siteId !== identity.siteId ||
      challenge.groupId !== group.id ||
      challenge.mode !== "MANUAL"
    ) {
      return verificationError(
        409,
        "CHALLENGE_NOT_ACTIVE",
        "Challenge is not active",
      );
    }
    const expected = Buffer.from(
      deriveGuestGroupAccessPin(
        identity.siteId,
        group.id,
        group.manualPinSeed,
        options.fingerprintSecret,
      ),
    );
    const actual = Buffer.from(code);
    const correct =
      expected.length === actual.length && timingSafeEqual(expected, actual);
    return finishProviderVerification(
      tx,
      challengeId,
      now,
      correct ? "APPROVED" : "DECLINED",
      sessionTokenGenerator,
    );
  });
  if (result.kind === "ERROR") {
    reject(result.status, result.code, result.title, result.retryAfterSeconds);
  }
  return result.session;
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
  const [challengeIdentity] = await db
    .select({ mode: guestVerificationChallenge.mode })
    .from(guestVerificationChallenge)
    .where(eq(guestVerificationChallenge.id, challengeId))
    .limit(1);
  if (challengeIdentity?.mode === "MANUAL") {
    return verifyWithManualPin(db, challengeId, value.code, options, now);
  }
  const provider = configuredProvider(options);
  if (provider.mode === "TWILIO") {
    return verifyWithTwilio(
      db,
      challengeId,
      value.code,
      options,
      provider,
      now,
    );
  }
  const sessionTokenGenerator = options.sessionTokenGenerator ?? opaqueToken;
  const result = await db.transaction(async (tx) => {
    await reserveOtpVerify(tx, {
      ipAddress: options.ipAddress,
      fingerprintSecret: options.fingerprintSecret,
      now,
    });
    const challenge = await lockChallenge(tx, challengeId);
    await lockSite(tx, challenge.siteId);
    if (challenge.status === "PENDING" && challenge.expiresAt <= now) {
      await tx
        .update(guestVerificationChallenge)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(guestVerificationChallenge.id, challengeId));
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
    if (challenge.status !== "PENDING" || !challenge.codeHash) {
      return verificationError(
        409,
        "CHALLENGE_NOT_ACTIVE",
        "Challenge is not active",
      );
    }
    const expected = Buffer.from(challenge.codeHash, "hex");
    const actual = Buffer.from(hash(value.code), "hex");
    const correct =
      expected.length === actual.length && timingSafeEqual(expected, actual);
    return finishProviderVerification(
      tx,
      challengeId,
      now,
      correct ? "APPROVED" : "DECLINED",
      sessionTokenGenerator,
    );
  });
  if (result.kind === "ERROR") {
    reject(result.status, result.code, result.title, result.retryAfterSeconds);
  }
  return result.session;
}

export function hashGuestVerificationValue(value: string): string {
  return hash(value);
}
