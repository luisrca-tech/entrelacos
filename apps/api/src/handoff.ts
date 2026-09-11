import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { accountState } from "@entrelacos/database/schema";
import { session, user, verification } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export const HANDOFF_CHALLENGE_IDENTIFIER = "entrelacos:handoff:challenge";
export const HANDOFF_RECOGNITION_IDENTIFIER = "entrelacos:handoff:recognition";

export const HANDOFF_TTL_MS = 60_000;
export const RECOGNITION_TTL_MS = 15 * 60_000;
export const ADMIN_IDLE_TTL_MS = 24 * 60 * 60_000;
export const ADMIN_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60_000;

const SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type HandoffDatabase = NodePgDatabase<Record<string, never>>;

export interface IssueHandoffInput {
  siteId: string;
  origin: string;
  parentSessionId: string;
  challenge: string;
  now?: Date;
}

export interface IssuedHandoff {
  code: string;
  expiresAt: Date;
}

export interface RedeemHandoffInput {
  code: string;
  siteId: string;
  origin: string;
  verifier: string;
  now?: Date;
}

export interface RedeemedHandoff {
  recognitionToken: string;
  expiresAt: Date;
}

export interface RecognizeSiteInput {
  recognitionToken: string;
  siteId: string;
  origin: string;
  now?: Date;
}

export interface AdminSessionSnapshot {
  accountState: (typeof accountState.enumValues)[number];
  expiresAt: Date;
  lastActiveAt: Date;
  createdAt: Date;
}

interface ActiveAdminSession {
  parentSessionId: string;
  expiresAt: Date;
}

interface HandoffRecordValue {
  siteId: string;
  origin: string;
  parentSessionId: string;
  challenge: string;
}

interface RecognitionRecordValue {
  siteId: string;
  origin: string;
  parentSessionId: string;
}

type HandoffStore = Pick<HandoffDatabase, "select" | "insert" | "delete">;

function rejectHandoff(): never {
  throw new Error("Handoff request rejected");
}

function validatedNow(value: Date | undefined): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) rejectHandoff();
  return now;
}

function validateSiteId(value: string): string {
  if (!SITE_ID_PATTERN.test(value)) rejectHandoff();
  return value;
}

function validateSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) rejectHandoff();
  return value;
}

function validateOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    rejectHandoff();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.origin !== value
  ) {
    rejectHandoff();
  }
  return value;
}

function isValidOrigin(value: string): boolean {
  try {
    validateOrigin(value);
    return true;
  } catch {
    return false;
  }
}

function validateOpaqueToken(value: string): string {
  if (!OPAQUE_TOKEN_PATTERN.test(value)) rejectHandoff();
  return value;
}

function validateChallenge(value: string): string {
  if (!SHA256_HEX_PATTERN.test(value)) rejectHandoff();
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function expiresBefore(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function isHandoffRecordValue(value: unknown): value is HandoffRecordValue {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<HandoffRecordValue>;
  return (
    typeof record.siteId === "string" &&
    SITE_ID_PATTERN.test(record.siteId) &&
    typeof record.origin === "string" &&
    isValidOrigin(record.origin) &&
    typeof record.parentSessionId === "string" &&
    SESSION_ID_PATTERN.test(record.parentSessionId) &&
    typeof record.challenge === "string" &&
    SHA256_HEX_PATTERN.test(record.challenge)
  );
}

function isRecognitionRecordValue(
  value: unknown,
): value is RecognitionRecordValue {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RecognitionRecordValue>;
  return (
    typeof record.siteId === "string" &&
    SITE_ID_PATTERN.test(record.siteId) &&
    typeof record.origin === "string" &&
    isValidOrigin(record.origin) &&
    typeof record.parentSessionId === "string" &&
    SESSION_ID_PATTERN.test(record.parentSessionId)
  );
}

export function isAdminSessionActive(
  snapshot: AdminSessionSnapshot,
  now: Date = new Date(),
): boolean {
  const nowMs = now.getTime();
  const expiresAtMs = snapshot.expiresAt.getTime();
  const lastActiveAtMs = snapshot.lastActiveAt.getTime();
  const createdAtMs = snapshot.createdAt.getTime();
  if (
    ![nowMs, expiresAtMs, lastActiveAtMs, createdAtMs].every(Number.isFinite) ||
    snapshot.accountState !== "ACTIVE" ||
    createdAtMs > nowMs ||
    lastActiveAtMs > nowMs
  ) {
    return false;
  }
  return (
    nowMs < expiresAtMs &&
    nowMs < lastActiveAtMs + ADMIN_IDLE_TTL_MS &&
    nowMs < createdAtMs + ADMIN_ABSOLUTE_TTL_MS
  );
}

async function activeAdminSession(
  db: HandoffStore,
  parentSessionId: string,
  now: Date,
): Promise<ActiveAdminSession | undefined> {
  const [sessionRow] = await db
    .select({
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      lastActiveAt: session.lastActiveAt,
      createdAt: session.createdAt,
    })
    .from(session)
    .where(eq(session.id, parentSessionId))
    .limit(1);
  if (!sessionRow) return undefined;

  const [userRow] = await db
    .select({ state: user.state })
    .from(user)
    .where(eq(user.id, sessionRow.userId))
    .limit(1);
  if (!userRow) return undefined;

  const snapshot: AdminSessionSnapshot = {
    accountState: userRow.state,
    expiresAt: sessionRow.expiresAt,
    lastActiveAt: sessionRow.lastActiveAt,
    createdAt: sessionRow.createdAt,
  };
  if (!isAdminSessionActive(snapshot, now)) return undefined;

  const absoluteExpiresAt = new Date(
    Math.min(
      snapshot.expiresAt.getTime(),
      snapshot.createdAt.getTime() + ADMIN_ABSOLUTE_TTL_MS,
    ),
  );
  const idleExpiresAt = new Date(
    snapshot.lastActiveAt.getTime() + ADMIN_IDLE_TTL_MS,
  );
  return {
    parentSessionId: sessionRow.id,
    expiresAt: expiresBefore(absoluteExpiresAt, idleExpiresAt),
  };
}

export async function issueHandoff(
  db: HandoffDatabase,
  input: IssueHandoffInput,
): Promise<IssuedHandoff> {
  const requestedSiteId = validateSiteId(input.siteId);
  const requestedOrigin = validateOrigin(input.origin);
  const requestedSessionId = validateSessionId(input.parentSessionId);
  const challenge = validateChallenge(input.challenge);
  const now = validatedNow(input.now);

  return db.transaction(async (tx) => {
    const parent = await activeAdminSession(tx, requestedSessionId, now);
    if (!parent) rejectHandoff();

    const code = opaqueToken();
    const expiresAt = expiresBefore(
      new Date(now.getTime() + HANDOFF_TTL_MS),
      parent.expiresAt,
    );
    if (expiresAt.getTime() <= now.getTime()) rejectHandoff();

    await tx.insert(verification).values({
      id: hash(code),
      identifier: HANDOFF_CHALLENGE_IDENTIFIER,
      value: JSON.stringify({
        siteId: requestedSiteId,
        origin: requestedOrigin,
        parentSessionId: parent.parentSessionId,
        challenge,
      } satisfies HandoffRecordValue),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return { code, expiresAt };
  });
}

export async function redeemHandoff(
  db: HandoffDatabase,
  input: RedeemHandoffInput,
): Promise<RedeemedHandoff> {
  const code = validateOpaqueToken(input.code);
  const requestedSiteId = validateSiteId(input.siteId);
  const requestedOrigin = validateOrigin(input.origin);
  const verifier = validateOpaqueToken(input.verifier);
  const now = validatedNow(input.now);
  const codeHash = hash(code);

  return db.transaction(async (tx) => {
    const [record] = await tx
      .select({
        id: verification.id,
        value: verification.value,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(
        and(
          eq(verification.id, codeHash),
          eq(verification.identifier, HANDOFF_CHALLENGE_IDENTIFIER),
        ),
      )
      .limit(1);
    if (!record || record.expiresAt.getTime() <= now.getTime()) {
      rejectHandoff();
    }

    const value = parseJson<unknown>(record.value);
    if (!isHandoffRecordValue(value)) rejectHandoff();
    if (value.siteId !== requestedSiteId || value.origin !== requestedOrigin) {
      rejectHandoff();
    }
    if (!sameSecret(value.challenge, hash(verifier))) rejectHandoff();

    const parent = await activeAdminSession(tx, value.parentSessionId, now);
    if (!parent) rejectHandoff();

    const consumed = await tx
      .delete(verification)
      .where(
        and(
          eq(verification.id, codeHash),
          eq(verification.identifier, HANDOFF_CHALLENGE_IDENTIFIER),
        ),
      )
      .returning({ id: verification.id });
    if (consumed.length !== 1) rejectHandoff();

    const recognitionToken = opaqueToken();
    const expiresAt = expiresBefore(
      new Date(now.getTime() + RECOGNITION_TTL_MS),
      parent.expiresAt,
    );
    await tx.insert(verification).values({
      id: hash(recognitionToken),
      identifier: HANDOFF_RECOGNITION_IDENTIFIER,
      value: JSON.stringify({
        siteId: requestedSiteId,
        origin: requestedOrigin,
        parentSessionId: parent.parentSessionId,
      } satisfies RecognitionRecordValue),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return { recognitionToken, expiresAt };
  });
}

export async function recognizeSite(
  db: HandoffDatabase,
  input: RecognizeSiteInput,
): Promise<boolean> {
  let token: string;
  let requestedSiteId: string;
  let requestedOrigin: string;
  let now: Date;
  try {
    token = validateOpaqueToken(input.recognitionToken);
    requestedSiteId = validateSiteId(input.siteId);
    requestedOrigin = validateOrigin(input.origin);
    now = validatedNow(input.now);
  } catch {
    return false;
  }

  const tokenHash = hash(token);
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select({
        value: verification.value,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(
        and(
          eq(verification.id, tokenHash),
          eq(verification.identifier, HANDOFF_RECOGNITION_IDENTIFIER),
        ),
      )
      .limit(1);
    if (!record || record.expiresAt.getTime() <= now.getTime()) return false;

    const value = parseJson<unknown>(record.value);
    if (!isRecognitionRecordValue(value)) return false;
    if (value.siteId !== requestedSiteId || value.origin !== requestedOrigin) {
      return false;
    }

    return Boolean(await activeAdminSession(tx, value.parentSessionId, now));
  });
}
