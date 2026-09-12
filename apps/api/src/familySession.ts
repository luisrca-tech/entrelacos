import { createHash, randomUUID } from "node:crypto";
import {
  type FamilySessionReadResponse,
  type FamilySessionResponse,
  familySessionReadResponseSchema,
  familySessionResponseSchema,
} from "@entrelacos/contracts";
import {
  familySession,
  guestGroup,
  guestMember,
} from "@entrelacos/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type FamilySessionDatabase = NodePgDatabase<Record<string, never>>;

export const FAMILY_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FamilySessionServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = "FamilySessionServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new FamilySessionServiceError(status, code, title);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid session time");
  }
  return now;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function createFamilySessionInTransaction(
  tx: FamilySessionDatabase,
  input: {
    siteId: string;
    groupId: string;
    token: string;
    now: Date;
  },
): Promise<FamilySessionResponse> {
  if (!validToken(input.token)) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Guest verification is not configured",
    );
  }
  const now = currentTime(input.now);
  const expiresAt = new Date(now.getTime() + FAMILY_SESSION_TTL_MS);
  const sessionId = randomUUID();
  await tx.insert(familySession).values({
    id: sessionId,
    siteId: input.siteId,
    groupId: input.groupId,
    tokenHash: hashToken(input.token),
    expiresAt,
    createdAt: now,
  });
  const members = await tx
    .select({
      id: guestMember.id,
      fullName: guestMember.fullName,
      isRepresentative: sql<boolean>`${guestMember.id} = ${guestGroup.representativeMemberId}`,
    })
    .from(guestMember)
    .innerJoin(
      guestGroup,
      and(
        eq(guestGroup.siteId, guestMember.siteId),
        eq(guestGroup.id, guestMember.groupId),
      ),
    )
    .where(
      and(
        eq(guestMember.siteId, input.siteId),
        eq(guestMember.groupId, input.groupId),
      ),
    )
    .orderBy(asc(guestMember.id));
  if (members.length === 0) {
    reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  }
  return familySessionResponseSchema.parse({
    sessionToken: input.token,
    siteId: input.siteId,
    groupId: input.groupId,
    members,
    expiresAt: expiresAt.toISOString(),
  });
}

type SessionRecord = {
  id: string;
  siteId: string;
  groupId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lifecycle: string;
};

async function findSession(
  db: FamilySessionDatabase,
  token: string,
  lock = false,
): Promise<SessionRecord | undefined> {
  if (!validToken(token)) return undefined;
  const tokenHash = hashToken(token);
  const result = await db.execute(sql`
    SELECT family_session.id, family_session.site_id, family_session.group_id,
      family_session.expires_at, family_session.revoked_at, site.lifecycle
    FROM family_session
    INNER JOIN site ON site.id = family_session.site_id
    WHERE family_session.token_hash = ${tokenHash}
    ${lock ? sql`FOR UPDATE` : sql``}
  `);
  const row = result.rows[0] as
    | {
        id: string;
        site_id: string;
        group_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        lifecycle: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    siteId: row.site_id,
    groupId: row.group_id,
    expiresAt: asDate(row.expires_at),
    revokedAt: row.revoked_at ? asDate(row.revoked_at) : null,
    lifecycle: row.lifecycle,
  };
}

async function familyMembers(
  db: FamilySessionDatabase,
  siteId: string,
  groupId: string,
) {
  return db
    .select({
      id: guestMember.id,
      fullName: guestMember.fullName,
      isRepresentative: sql<boolean>`${guestMember.id} = ${guestGroup.representativeMemberId}`,
    })
    .from(guestMember)
    .innerJoin(
      guestGroup,
      and(
        eq(guestGroup.siteId, guestMember.siteId),
        eq(guestGroup.id, guestMember.groupId),
      ),
    )
    .where(
      and(eq(guestMember.siteId, siteId), eq(guestMember.groupId, groupId)),
    )
    .orderBy(asc(guestMember.id));
}

export async function readFamilySession(
  db: FamilySessionDatabase,
  token: string,
  now?: Date,
): Promise<FamilySessionReadResponse> {
  const current = currentTime(now);
  const record = await findSession(db, token);
  if (
    !record ||
    record.revokedAt ||
    record.expiresAt <= current ||
    record.lifecycle === "INACTIVE"
  ) {
    reject(401, "SESSION_INVALID", "Family session is invalid");
  }
  const members = await familyMembers(db, record.siteId, record.groupId);
  if (members.length === 0)
    reject(401, "SESSION_INVALID", "Family session is invalid");
  return familySessionReadResponseSchema.parse({
    siteId: record.siteId,
    groupId: record.groupId,
    members,
    expiresAt: record.expiresAt.toISOString(),
  });
}

export async function leaveFamilySession(
  db: FamilySessionDatabase,
  token: string,
  now?: Date,
): Promise<{ ok: true }> {
  const current = currentTime(now);
  return db.transaction(async (tx) => {
    const record = await findSession(tx, token, true);
    if (!record || record.revokedAt || record.expiresAt <= current) {
      reject(401, "SESSION_INVALID", "Family session is invalid");
    }
    await tx
      .update(familySession)
      .set({ revokedAt: current, revocationReason: "EXPLICIT_LEAVE" })
      .where(
        and(eq(familySession.id, record.id), isNull(familySession.revokedAt)),
      );
    return { ok: true } as const;
  });
}

export function hashFamilySessionToken(value: string): string {
  return hashToken(value);
}
