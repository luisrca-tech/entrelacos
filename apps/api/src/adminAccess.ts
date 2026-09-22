import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  account,
  adminAccessToken,
  session,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  withCredentialAdvisoryLock,
  withUserCredentialAdvisoryLock,
} from "./credentialLock";

export const ADMIN_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AdminAccessDatabase = NodePgDatabase<Record<string, never>>;
export type AdminAccessPurpose = "ACTIVATION" | "RECOVERY";

export interface IssueAdminAccessInput {
  userId: string;
  purpose: AdminAccessPurpose;
  now?: Date;
}

export interface IssuedAdminAccess {
  userId: string;
  siteId: string;
  purpose: AdminAccessPurpose;
  token: string;
  expiresAt: Date;
}

export interface ConsumeAdminAccessInput {
  token: string;
  password: string;
  purpose: AdminAccessPurpose;
  now?: Date;
}

export interface ConsumedAdminAccess {
  userId: string;
  siteId: string;
  email: string;
  purpose: AdminAccessPurpose;
}

export interface RevokeAdminAccessInput {
  userId: string;
  purpose: AdminAccessPurpose;
  now?: Date;
}

export interface DisableAdminInput {
  userId: string;
  now?: Date;
}

export interface CreateSiteAdminInput {
  siteId: string;
  name: string;
  email: string;
  now?: Date;
}

export interface SiteAdminSummary {
  userId: string;
  siteId: string;
  name: string;
  email: string;
  role: "SITE_ADMIN";
  state: "PENDING" | "ACTIVE" | "DISABLED";
}

export class AdminAccessRejectedError extends Error {
  readonly code = "ADMIN_ACCESS_REJECTED";

  constructor() {
    super("Administrative access request rejected");
    this.name = "AdminAccessRejectedError";
  }
}

function reject(): never {
  throw new AdminAccessRejectedError();
}

function currentTime(value: Date | undefined): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) reject();
  return now;
}

function validateUserId(value: string): string {
  if (!USER_ID_PATTERN.test(value)) reject();
  return value;
}

function validatePurpose(value: string): AdminAccessPurpose {
  if (value !== "ACTIVATION" && value !== "RECOVERY") reject();
  return value;
}

function validateToken(value: string): string {
  if (!OPAQUE_TOKEN_PATTERN.test(value)) reject();
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

async function lockUser(
  tx: AdminAccessDatabase,
  userId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`,
  );
  return result.rows.length === 1;
}

async function lockSite(
  tx: AdminAccessDatabase,
  siteId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT id FROM site WHERE id = ${siteId} FOR UPDATE`,
  );
  return result.rows.length === 1;
}

export async function revokeUserSessionsAndDerivedRecognition(
  tx: AdminAccessDatabase,
  userId: string,
): Promise<void> {
  await tx.delete(session).where(eq(session.userId, userId));
}

async function revokeUserTokens(
  tx: AdminAccessDatabase,
  userId: string,
  now: Date,
  purpose?: AdminAccessPurpose,
): Promise<void> {
  const conditions = [
    eq(adminAccessToken.userId, userId),
    isNull(adminAccessToken.revokedAt),
  ];
  if (purpose) conditions.push(eq(adminAccessToken.purpose, purpose));
  await tx
    .update(adminAccessToken)
    .set({ revokedAt: now })
    .where(and(...conditions));
}

async function findAdminMembership(
  tx: AdminAccessDatabase,
  userId: string,
): Promise<
  | {
      email: string;
      role: "OWNER" | "SITE_ADMIN";
      state: "PENDING" | "ACTIVE" | "DISABLED";
      siteId: string;
    }
  | undefined
> {
  const [record] = await tx
    .select({
      email: user.email,
      role: user.role,
      state: user.state,
      siteId: siteMembership.siteId,
    })
    .from(user)
    .innerJoin(siteMembership, eq(siteMembership.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  return record;
}

function normalizedAdminDetails(input: CreateSiteAdminInput): {
  siteId: string;
  name: string;
  email: string;
  now: Date;
} {
  const siteId = validateUserId(input.siteId);
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 160 || !/^\S+@\S+\.\S+$/.test(email)) reject();
  return { siteId, name, email, now: currentTime(input.now) };
}

export async function createSiteAdmin(
  db: AdminAccessDatabase,
  input: CreateSiteAdminInput,
): Promise<SiteAdminSummary> {
  const { siteId, name, email, now } = normalizedAdminDetails(input);
  return db.transaction(async (tx) => {
    if (!(await lockSite(tx, siteId))) reject();
    const [existing] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (existing) reject();

    const userId = randomUUID();
    await tx.insert(user).values({
      id: userId,
      name,
      email,
      emailVerified: false,
      role: "SITE_ADMIN",
      state: "PENDING",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(siteMembership).values({
      id: randomUUID(),
      siteId,
      userId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      userId,
      siteId,
      name,
      email,
      role: "SITE_ADMIN",
      state: "PENDING",
    };
  });
}

export async function listSiteAdmins(
  db: AdminAccessDatabase,
  siteId: string,
): Promise<SiteAdminSummary[]> {
  const validSiteId = validateUserId(siteId);
  const rows = await db
    .select({
      userId: user.id,
      siteId: siteMembership.siteId,
      name: user.name,
      email: user.email,
      role: user.role,
      state: user.state,
    })
    .from(siteMembership)
    .innerJoin(user, eq(siteMembership.userId, user.id))
    .where(
      and(eq(siteMembership.siteId, validSiteId), eq(user.role, "SITE_ADMIN")),
    );
  return rows.map((row) => ({ ...row, role: "SITE_ADMIN" as const }));
}

export async function issueAdminAccess(
  db: AdminAccessDatabase,
  input: IssueAdminAccessInput,
): Promise<IssuedAdminAccess> {
  const userId = validateUserId(input.userId);
  const purpose = validatePurpose(input.purpose);
  const now = currentTime(input.now);

  return withUserCredentialAdvisoryLock(db, userId, async (tx) => {
    if (!(await lockUser(tx, userId))) reject();
    const member = await findAdminMembership(tx, userId);
    if (member?.role !== "SITE_ADMIN") reject();
    if (
      (purpose === "ACTIVATION" && member.state !== "PENDING") ||
      (purpose === "RECOVERY" && member.state !== "ACTIVE")
    ) {
      reject();
    }

    await revokeUserTokens(tx, userId, now, purpose);
    const token = opaqueToken();
    const expiresAt = new Date(now.getTime() + ADMIN_ACCESS_TTL_MS);
    await tx.insert(adminAccessToken).values({
      id: randomUUID(),
      userId,
      siteId: member.siteId,
      purpose,
      tokenHash: sha256(token),
      expiresAt,
      createdAt: now,
    });

    return { userId, siteId: member.siteId, purpose, token, expiresAt };
  });
}

interface AccessTokenRecord {
  id: string;
  userId: string;
  siteId: string;
  email: string;
  role: "OWNER" | "SITE_ADMIN";
  state: "PENDING" | "ACTIVE" | "DISABLED";
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

async function findAndLockToken(
  tx: AdminAccessDatabase,
  tokenHash: string,
  purpose: AdminAccessPurpose,
): Promise<AccessTokenRecord | undefined> {
  const result = await tx.execute(sql`
    SELECT
      access_token.id AS id,
      access_token.user_id AS user_id,
      access_token.site_id AS site_id,
      access_token.expires_at AS expires_at,
      access_token.consumed_at AS consumed_at,
      access_token.revoked_at AS revoked_at,
      account_user.email AS email,
      account_user.role AS role,
      account_user.state AS state
    FROM admin_access_token AS access_token
    INNER JOIN "user" AS account_user ON account_user.id = access_token.user_id
    INNER JOIN site_membership AS membership
      ON membership.site_id = access_token.site_id
      AND membership.user_id = access_token.user_id
    WHERE access_token.token_hash = ${tokenHash}
      AND access_token.purpose = ${purpose}
    FOR UPDATE
  `);
  const row = result.rows[0] as
    | {
        id: string;
        user_id: string;
        site_id: string;
        email: string;
        role: AccessTokenRecord["role"];
        state: AccessTokenRecord["state"];
        expires_at: Date;
        consumed_at: Date | null;
        revoked_at: Date | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    siteId: row.site_id,
    email: row.email,
    role: row.role,
    state: row.state,
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

async function findAccessTokenEmail(
  db: AdminAccessDatabase,
  tokenHash: string,
  purpose: AdminAccessPurpose,
): Promise<string | undefined> {
  const [record] = await db
    .select({ email: user.email })
    .from(adminAccessToken)
    .innerJoin(user, eq(adminAccessToken.userId, user.id))
    .where(
      and(
        eq(adminAccessToken.tokenHash, tokenHash),
        eq(adminAccessToken.purpose, purpose),
      ),
    )
    .limit(1);
  return record?.email;
}

export async function setCredential(
  tx: AdminAccessDatabase,
  userId: string,
  password: string,
  now: Date,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  const [existing] = await tx
    .select({ id: account.id })
    .from(account)
    .where(
      and(eq(account.userId, userId), eq(account.providerId, "credential")),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(account.id, existing.id));
    return;
  }
  await tx.insert(account).values({
    id: randomUUID(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  });
}

export async function consumeAdminAccess(
  db: AdminAccessDatabase,
  input: ConsumeAdminAccessInput,
): Promise<ConsumedAdminAccess> {
  const token = validateToken(input.token);
  const purpose = validatePurpose(input.purpose);
  if (input.password.length < 6 || input.password.length > 10) reject();
  const now = currentTime(input.now);

  const email = await findAccessTokenEmail(db, sha256(token), purpose);
  if (!email) reject();

  return withCredentialAdvisoryLock(db, email, async (tx) => {
    const record = await findAndLockToken(tx, sha256(token), purpose);
    if (
      record?.role !== "SITE_ADMIN" ||
      record.consumedAt ||
      record.revokedAt ||
      record.expiresAt.getTime() <= now.getTime() ||
      (purpose === "ACTIVATION" && record.state !== "PENDING") ||
      (purpose === "RECOVERY" && record.state !== "ACTIVE")
    ) {
      reject();
    }

    await setCredential(tx, record.userId, input.password, now);
    const [consumed] = await tx
      .update(adminAccessToken)
      .set({ consumedAt: now })
      .where(
        and(
          eq(adminAccessToken.id, record.id),
          isNull(adminAccessToken.consumedAt),
          isNull(adminAccessToken.revokedAt),
        ),
      )
      .returning({ id: adminAccessToken.id });
    if (!consumed) reject();

    if (purpose === "ACTIVATION") {
      await tx
        .update(user)
        .set({ state: "ACTIVE", emailVerified: true, updatedAt: now })
        .where(eq(user.id, record.userId));
      await revokeUserSessionsAndDerivedRecognition(tx, record.userId);
    } else {
      await tx
        .update(user)
        .set({ updatedAt: now })
        .where(eq(user.id, record.userId));
      await revokeUserSessionsAndDerivedRecognition(tx, record.userId);
    }

    return {
      userId: record.userId,
      siteId: record.siteId,
      email: record.email,
      purpose,
    };
  });
}

export async function revokeAdminAccess(
  db: AdminAccessDatabase,
  input: RevokeAdminAccessInput,
): Promise<void> {
  const userId = validateUserId(input.userId);
  const purpose = validatePurpose(input.purpose);
  const now = currentTime(input.now);
  await withUserCredentialAdvisoryLock(db, userId, async (tx) => {
    if (!(await lockUser(tx, userId))) reject();
    const member = await findAdminMembership(tx, userId);
    if (member?.role !== "SITE_ADMIN") reject();
    await revokeUserTokens(tx, userId, now, purpose);
  });
}

export async function disableAdmin(
  db: AdminAccessDatabase,
  input: DisableAdminInput,
): Promise<void> {
  const userId = validateUserId(input.userId);
  const now = currentTime(input.now);
  await withUserCredentialAdvisoryLock(db, userId, async (tx) => {
    if (!(await lockUser(tx, userId))) reject();
    const member = await findAdminMembership(tx, userId);
    if (member?.role !== "SITE_ADMIN") reject();
    await tx
      .update(user)
      .set({ state: "DISABLED", updatedAt: now })
      .where(eq(user.id, userId));
    await revokeUserTokens(tx, userId, now);
    await revokeUserSessionsAndDerivedRecognition(tx, userId);
  });
}
