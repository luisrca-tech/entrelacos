import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type SiteTeamInvitation,
  type SiteTeamResponse,
  siteAccessSchema,
  siteTeamAcceptInputSchema,
  siteTeamAcceptResponseSchema,
  siteTeamInvitationSchema,
  siteTeamInviteInputSchema,
  siteTeamInviteResponseSchema,
  siteTeamResponseSchema,
} from "@entrelacos/contracts";
import {
  siteAssessorInvitation,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { setCredential } from "./adminAccess";
import {
  normalizeCredentialEmail,
  withCredentialAdvisoryLock,
} from "./credentialLock";
import {
  requireSiteCapability,
  type SiteAccessActor,
  SiteAccessDeniedError,
} from "./siteAccess";

export const SITE_ASSESSOR_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
export type SiteTeamDatabase = NodePgDatabase<Record<string, never>>;

export class SiteTeamServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "SiteTeamServiceError";
  }
}

function invalid(): never {
  throw new SiteTeamServiceError(
    400,
    "TEAM_INVITATION_INVALID",
    "Team invitation unavailable",
  );
}

function accountRequired(): never {
  throw new SiteTeamServiceError(
    409,
    "TEAM_INVITATION_ACCOUNT_REQUIRED",
    "Sign in to the invited account",
  );
}

function memberConflict(): never {
  throw new SiteTeamServiceError(
    409,
    "TEAM_MEMBER_CONFLICT",
    "Team membership conflicts with existing access",
  );
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  return now;
}

function validSiteId(siteId: string): void {
  if (!siteAccessSchema.shape.siteId.safeParse(siteId).success) invalid();
}

async function lockSite(db: SiteTeamDatabase, siteId: string): Promise<void> {
  const result = await db.execute(
    sql`SELECT id FROM site WHERE id = ${siteId} FOR UPDATE`,
  );
  if (result.rows.length !== 1) invalid();
}

async function withManagedSite<T>(
  db: SiteTeamDatabase,
  actor: SiteAccessActor,
  siteId: string,
  operation: (tx: SiteTeamDatabase) => Promise<T>,
): Promise<T> {
  validSiteId(siteId);
  await requireSiteCapability(db, actor, siteId, "manageTeam");
  return db.transaction(async (transaction) => {
    const tx = transaction as SiteTeamDatabase;
    await lockSite(tx, siteId);
    await requireSiteCapability(tx, actor, siteId, "manageTeam");
    return operation(tx);
  });
}

type InvitationRow = typeof siteAssessorInvitation.$inferSelect;
type AccountRow = Pick<
  typeof user.$inferSelect,
  "id" | "email" | "role" | "state"
>;
type MembershipRow = Pick<typeof siteMembership.$inferSelect, "id" | "role">;

const invitationColumns = sql`
  id, site_id AS "siteId", email, invitee_name AS "inviteeName", role,
  token_hash AS "tokenHash", expires_at AS "expiresAt",
  consumed_at AS "consumedAt", revoked_at AS "revokedAt",
  invited_by_user_id AS "invitedByUserId", created_at AS "createdAt"
`;

function publicInvitation(row: InvitationRow): SiteTeamInvitation {
  return siteTeamInvitationSchema.parse({
    id: row.id,
    siteId: row.siteId,
    email: row.email,
    inviteeName: row.inviteeName,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
}

async function revokePendingInvitations(
  tx: SiteTeamDatabase,
  siteId: string,
  email: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE site_assessor_invitation SET revoked_at = ${now}
    WHERE site_id = ${siteId} AND email = ${email}
      AND consumed_at IS NULL AND revoked_at IS NULL
  `);
}

export async function issueSiteAssessorInvitation(
  db: SiteTeamDatabase,
  actor: SiteAccessActor,
  siteId: string,
  input: typeof siteTeamInviteInputSchema._input,
  nowValue?: Date,
): Promise<typeof siteTeamInviteResponseSchema._output> {
  const parsed = siteTeamInviteInputSchema.safeParse(input);
  if (!parsed.success) invalid();
  const now = currentTime(nowValue);
  return withManagedSite(db, actor, siteId, async (tx) => {
    const existing = await tx.execute(sql`
      SELECT sm.id, sm.role
      FROM site_membership sm
      INNER JOIN "user" u ON u.id = sm.user_id
      WHERE sm.site_id = ${siteId} AND lower(trim(u.email)) = ${parsed.data.email}
    `);
    if (existing.rows.some((row) => row.role === "SITE_ADMIN"))
      memberConflict();
    await revokePendingInvitations(tx, siteId, parsed.data.email, now);

    const token = randomBytes(32).toString("base64url");
    const row: InvitationRow = {
      id: randomUUID(),
      siteId,
      email: parsed.data.email,
      inviteeName: parsed.data.name,
      role: "SITE_ASSISTANT",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(now.getTime() + SITE_ASSESSOR_INVITATION_TTL_MS),
      consumedAt: null,
      revokedAt: null,
      invitedByUserId: actor.userId,
      createdAt: now,
    };
    await tx.insert(siteAssessorInvitation).values(row);
    return siteTeamInviteResponseSchema.parse({
      invitation: publicInvitation(row),
      token,
    });
  });
}

export async function listSiteTeam(
  db: SiteTeamDatabase,
  actor: SiteAccessActor,
  siteId: string,
): Promise<SiteTeamResponse> {
  validSiteId(siteId);
  await requireSiteCapability(db, actor, siteId, "manageTeam");
  const members = await db.execute(sql`
    SELECT sm.user_id AS "userId", sm.site_id AS "siteId", u.name, u.email,
      sm.role AS "membershipRole", sm.revoked_at AS "revokedAt"
    FROM site_membership sm
    INNER JOIN "user" u ON u.id = sm.user_id
    WHERE sm.site_id = ${siteId} AND sm.role = 'SITE_ASSISTANT'
    ORDER BY u.name, sm.user_id
  `);
  const invitations = await db.execute(sql`
    SELECT ${invitationColumns} FROM site_assessor_invitation
    WHERE site_id = ${siteId} ORDER BY created_at DESC, id
  `);
  return siteTeamResponseSchema.parse({
    members: members.rows.map((row) => ({
      ...row,
      revokedAt: (row.revokedAt as Date | null)?.toISOString() ?? null,
    })),
    invitations: (invitations.rows as InvitationRow[]).map(publicInvitation),
  });
}

export async function revokeSiteAssessorInvitation(
  db: SiteTeamDatabase,
  actor: SiteAccessActor,
  siteId: string,
  invitationId: string,
  nowValue?: Date,
): Promise<{ ok: true }> {
  if (!siteTeamInvitationSchema.shape.id.safeParse(invitationId).success)
    invalid();
  const now = currentTime(nowValue);
  return withManagedSite(db, actor, siteId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT ${invitationColumns} FROM site_assessor_invitation
      WHERE id = ${invitationId} AND site_id = ${siteId} FOR UPDATE
    `);
    const invitation = result.rows[0] as InvitationRow | undefined;
    if (invitation?.role !== "SITE_ASSISTANT" || invitation.consumedAt)
      invalid();
    if (!invitation.revokedAt) {
      const revoked = await tx.execute(sql`
        UPDATE site_assessor_invitation SET revoked_at = ${now}
        WHERE id = ${invitationId} AND site_id = ${siteId}
          AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id
      `);
      if (revoked.rows.length !== 1) invalid();
    }
    return { ok: true };
  });
}

export async function revokeSiteAssessorMembership(
  db: SiteTeamDatabase,
  actor: SiteAccessActor,
  siteId: string,
  userId: string,
  nowValue?: Date,
): Promise<{ ok: true }> {
  if (!siteAccessSchema.shape.userId.safeParse(userId).success) invalid();
  const now = currentTime(nowValue);
  return withManagedSite(db, actor, siteId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT sm.id, sm.role, u.email
      FROM site_membership sm
      INNER JOIN "user" u ON u.id = sm.user_id
      WHERE sm.site_id = ${siteId} AND sm.user_id = ${userId}
      FOR UPDATE OF sm
    `);
    const membership = result.rows[0] as
      | (MembershipRow & { email: string })
      | undefined;
    if (membership?.role !== "SITE_ASSISTANT") memberConflict();
    const revoked = await tx.execute(sql`
      UPDATE site_membership
      SET revoked_at = COALESCE(revoked_at, ${now}), updated_at = ${now}
      WHERE site_id = ${siteId} AND user_id = ${userId} AND role = 'SITE_ASSISTANT'
      RETURNING id
    `);
    if (revoked.rows.length !== 1) memberConflict();
    await revokePendingInvitations(
      tx,
      siteId,
      normalizeCredentialEmail(membership.email),
      now,
    );
    return { ok: true };
  });
}

async function invitationForToken(
  db: SiteTeamDatabase,
  tokenHash: string,
  lock = false,
): Promise<InvitationRow | undefined> {
  const result = await db.execute(sql`
    SELECT ${invitationColumns} FROM site_assessor_invitation
    WHERE token_hash = ${tokenHash} ${lock ? sql`FOR UPDATE` : sql``}
  `);
  return result.rows[0] as InvitationRow | undefined;
}

export async function acceptSiteAssessorInvitation(
  db: SiteTeamDatabase,
  input: typeof siteTeamAcceptInputSchema._input,
  authenticatedActor: SiteAccessActor | null,
  nowValue?: Date,
): Promise<typeof siteTeamAcceptResponseSchema._output> {
  const parsed = siteTeamAcceptInputSchema.safeParse(input);
  if (!parsed.success) invalid();
  const now = currentTime(nowValue);
  const tokenHash = createHash("sha256")
    .update(parsed.data.token)
    .digest("hex");
  const initial = await invitationForToken(db, tokenHash);
  if (!initial) invalid();

  return withCredentialAdvisoryLock(db, initial.email, async (transaction) => {
    const tx = transaction as SiteTeamDatabase;
    await lockSite(tx, initial.siteId);
    const invitation = await invitationForToken(tx, tokenHash, true);
    if (
      !invitation ||
      invitation.tokenHash !== tokenHash ||
      invitation.siteId !== initial.siteId ||
      invitation.email !== initial.email ||
      invitation.email !== normalizeCredentialEmail(invitation.email) ||
      invitation.role !== "SITE_ASSISTANT" ||
      invitation.consumedAt ||
      invitation.revokedAt ||
      !Number.isFinite(invitation.expiresAt.getTime()) ||
      invitation.expiresAt.getTime() <= now.getTime()
    )
      invalid();

    const issuerResult = await tx.execute(sql`
      SELECT id, email, role, state FROM "user" WHERE id = ${invitation.invitedByUserId}
    `);
    const issuer = issuerResult.rows[0] as AccountRow | undefined;
    if (issuer?.state !== "ACTIVE") invalid();
    try {
      await requireSiteCapability(
        tx,
        { userId: issuer.id, role: issuer.role },
        invitation.siteId,
        "manageTeam",
      );
    } catch (error) {
      if (error instanceof SiteAccessDeniedError) invalid();
      throw error;
    }

    const accountResult = await tx.execute(sql`
      SELECT id, email, role, state FROM "user" WHERE lower(trim(email)) = ${invitation.email}
    `);
    const existing = accountResult.rows[0] as AccountRow | undefined;
    if (existing) {
      if (parsed.data.password !== undefined) invalid();
      if (
        existing.state !== "ACTIVE" ||
        !authenticatedActor ||
        authenticatedActor.userId !== existing.id ||
        authenticatedActor.role !== existing.role ||
        normalizeCredentialEmail(existing.email) !== invitation.email
      )
        accountRequired();
    } else {
      if (authenticatedActor) accountRequired();
      if (!parsed.data.password) invalid();
    }
    const userId = existing?.id ?? randomUUID();
    const membershipResult = await tx.execute(sql`
      SELECT id, role FROM site_membership
      WHERE site_id = ${invitation.siteId} AND user_id = ${userId} FOR UPDATE
    `);
    const membership = membershipResult.rows[0] as MembershipRow | undefined;
    if (membership && membership.role !== "SITE_ASSISTANT") memberConflict();

    if (!existing) {
      await tx.insert(user).values({
        id: userId,
        name: invitation.inviteeName,
        email: invitation.email,
        emailVerified: true,
        role: "SITE_ASSISTANT",
        state: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      });
      await setCredential(tx, userId, parsed.data.password as string, now);
    }
    if (membership) {
      const reactivated = await tx.execute(sql`
        UPDATE site_membership SET revoked_at = NULL,
          invited_by_user_id = ${invitation.invitedByUserId}, updated_at = ${now}
        WHERE id = ${membership.id} AND site_id = ${invitation.siteId}
          AND user_id = ${userId} AND role = 'SITE_ASSISTANT'
        RETURNING id
      `);
      if (reactivated.rows.length !== 1) memberConflict();
    } else {
      await tx.insert(siteMembership).values({
        id: randomUUID(),
        siteId: invitation.siteId,
        userId,
        role: "SITE_ASSISTANT",
        revokedAt: null,
        invitedByUserId: invitation.invitedByUserId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const consumed = await tx.execute(sql`
      UPDATE site_assessor_invitation SET consumed_at = ${now}
      WHERE id = ${invitation.id} AND site_id = ${invitation.siteId}
        AND role = 'SITE_ASSISTANT' AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING id
    `);
    if (consumed.rows.length !== 1) invalid();
    return siteTeamAcceptResponseSchema.parse({ siteId: invitation.siteId });
  });
}
