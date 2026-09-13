import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  type GuestGroupCreateInput,
  type GuestGroupRecord,
  type GuestGroupUpdateInput,
  groupDeleteConfirmationSchema,
  guestGroupCreateInputSchema,
  guestGroupRecordSchema,
  guestGroupUpdateInputSchema,
} from "@entrelacos/contracts";
import {
  familySession,
  guestGroup,
  guestMember,
  guestVerificationChallenge,
  messageRequestReceipt,
  rsvpRequestReceipt,
  rsvpRequestReceiptGroup,
  site,
  siteMembership,
} from "@entrelacos/database/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type GuestGroupDatabase = NodePgDatabase<Record<string, never>>;
export type GuestGroupRole = "OWNER" | "SITE_ADMIN";

export interface GuestGroupActor {
  userId: string;
  role: GuestGroupRole;
}

export class GuestGroupServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "GuestGroupServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new GuestGroupServiceError(status, code, title);
}

function validationError(): never {
  return reject(400, "VALIDATION_ERROR", "Invalid guest group request");
}

function notFound(code = "NOT_FOUND"): never {
  return reject(404, code, "Not Found");
}

function inactiveSite(): never {
  return reject(409, "SITE_INACTIVE", "Site is inactive");
}

function conflict(
  code: string,
  title = "Guest group conflicts with existing data",
): never {
  return reject(409, code, title);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) validationError();
  return now;
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** Normalize identity names for exact comparisons while preserving display text separately. */
export function normalizeGuestName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function displayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

type SiteAccess = {
  id: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

async function siteForActor(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
): Promise<SiteAccess> {
  const rows =
    actor.role === "OWNER"
      ? await db
          .select({ id: site.id, lifecycle: site.lifecycle })
          .from(site)
          .where(eq(site.id, siteId))
          .limit(1)
      : await db
          .select({ id: site.id, lifecycle: site.lifecycle })
          .from(site)
          .innerJoin(
            siteMembership,
            and(
              eq(siteMembership.siteId, site.id),
              eq(siteMembership.userId, actor.userId),
            ),
          )
          .where(eq(site.id, siteId))
          .limit(1);
  const record = rows[0];
  if (!record) notFound();
  return record;
}

async function lockSiteForActor(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  mutation: boolean,
): Promise<SiteAccess> {
  await siteForActor(db, actor, siteId);
  await db.execute(sql`SELECT id FROM "site" WHERE id = ${siteId} FOR UPDATE`);
  const [current] = await db
    .select({ id: site.id, lifecycle: site.lifecycle })
    .from(site)
    .where(eq(site.id, siteId))
    .limit(1);
  if (!current) notFound();
  if (mutation && current.lifecycle === "INACTIVE") inactiveSite();
  return current;
}

type GroupRow = typeof guestGroup.$inferSelect;
type MemberRow = typeof guestMember.$inferSelect;

async function readGroup(
  db: GuestGroupDatabase,
  siteId: string,
  groupId: string,
): Promise<GuestGroupRecord> {
  const [group] = await db
    .select()
    .from(guestGroup)
    .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)))
    .limit(1);
  if (!group) notFound("GROUP_NOT_FOUND");
  const members = await db
    .select()
    .from(guestMember)
    .where(
      and(eq(guestMember.siteId, siteId), eq(guestMember.groupId, groupId)),
    )
    .orderBy(asc(guestMember.id));
  return recordFor(group, members);
}

function recordFor(group: GroupRow, members: MemberRow[]): GuestGroupRecord {
  return guestGroupRecordSchema.parse({
    id: group.id,
    siteId: group.siteId,
    name: group.name,
    isForeign: group.isForeign,
    phone: group.phoneE164,
    members: members.map((member) => ({
      id: member.id,
      fullName: member.fullName,
      isRepresentative: member.id === group.representativeMemberId,
    })),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  });
}

function memberValues(
  siteId: string,
  groupId: string,
  members: Array<{ id: string; fullName: string; isRepresentative: boolean }>,
  createdAt: Date,
) {
  return members.map((member) => ({
    id: member.id,
    siteId,
    groupId,
    fullName: displayName(member.fullName),
    normalizedName: normalizeGuestName(member.fullName),
    createdAt,
    updatedAt: createdAt,
  }));
}

function preparedMemberInput(
  members: GuestGroupCreateInput["members"] | GuestGroupUpdateInput["members"],
  current: MemberRow[] = [],
  preserveIds = false,
) {
  if (!members) validationError();
  const currentIds = new Set(current.map((member) => member.id));
  const seen = new Set<string>();
  return members.map((member) => {
    const id = preserveIds && member.id ? member.id : randomUUID();
    if (seen.has(id)) validationError();
    seen.add(id);
    if (preserveIds && member.id && !currentIds.has(member.id)) {
      notFound("MEMBER_NOT_FOUND");
    }
    return { ...member, id };
  });
}

async function readCurrentMembers(
  db: GuestGroupDatabase,
  siteId: string,
  groupId: string,
): Promise<MemberRow[]> {
  return db
    .select()
    .from(guestMember)
    .where(
      and(eq(guestMember.siteId, siteId), eq(guestMember.groupId, groupId)),
    )
    .orderBy(asc(guestMember.id));
}

async function revokeIdentity(
  db: GuestGroupDatabase,
  siteId: string,
  groupId: string,
  now: Date,
  reason = "GROUP_IDENTITY_CHANGED",
): Promise<void> {
  await db
    .update(familySession)
    .set({ revokedAt: now, revocationReason: reason })
    .where(
      and(
        eq(familySession.siteId, siteId),
        eq(familySession.groupId, groupId),
        isNull(familySession.revokedAt),
      ),
    );
  await db
    .update(guestVerificationChallenge)
    .set({
      status: "REVOKED",
      revokedAt: now,
      revocationReason: reason,
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

function manualPinSeed(): string {
  return randomBytes(32).toString("hex");
}

export function deriveGuestGroupAccessPin(
  siteId: string,
  groupId: string,
  seed: string,
  secret: string,
): string {
  if (secret.trim().length < 32 || !/^[a-f0-9]{64}$/.test(seed)) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Guest verification is not configured",
    );
  }
  const digest = createHmac("sha256", secret)
    .update(`entrelacos:guest-access-pin:v1:${siteId}:${groupId}:${seed}`)
    .digest();
  return String(Number(digest.readBigUInt64BE(0) % 1_000_000n)).padStart(
    6,
    "0",
  );
}

async function accessPinGroup(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  groupId: string,
): Promise<{ id: string; manualPinSeed: string; isForeign: boolean }> {
  await siteForActor(db, actor, siteId);
  const [group] = await db
    .select({
      id: guestGroup.id,
      manualPinSeed: guestGroup.manualPinSeed,
      isForeign: guestGroup.isForeign,
    })
    .from(guestGroup)
    .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)))
    .limit(1);
  if (!group) notFound("GROUP_NOT_FOUND");
  if (group.isForeign) {
    reject(
      422,
      "FOREIGN_GUEST_CONTACT_ADMIN",
      "Foreign groups use administrative access",
    );
  }
  return group;
}

export async function getGuestGroupAccessPin(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  groupId: string,
  secret: string,
): Promise<{ accessPin: string }> {
  const group = await accessPinGroup(db, actor, siteId, groupId);
  return {
    accessPin: deriveGuestGroupAccessPin(
      siteId,
      group.id,
      group.manualPinSeed,
      secret,
    ),
  };
}

export async function rotateGuestGroupAccessPin(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  groupId: string,
  secret: string,
  now?: Date,
): Promise<{ accessPin: string }> {
  const rotatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    await lockSiteForActor(tx, actor, siteId, true);
    const result = await tx.execute(sql`
      SELECT id, is_foreign, manual_pin_seed
      FROM guest_group
      WHERE site_id = ${siteId} AND id = ${groupId}
      FOR UPDATE
    `);
    const group = result.rows[0] as
      | { id: string; is_foreign: boolean; manual_pin_seed: string }
      | undefined;
    if (!group) notFound("GROUP_NOT_FOUND");
    if (group.is_foreign) {
      reject(
        422,
        "FOREIGN_GUEST_CONTACT_ADMIN",
        "Foreign groups use administrative access",
      );
    }
    const previousPin = deriveGuestGroupAccessPin(
      siteId,
      groupId,
      group.manual_pin_seed,
      secret,
    );
    let seed = manualPinSeed();
    let accessPin = deriveGuestGroupAccessPin(siteId, groupId, seed, secret);
    while (accessPin === previousPin) {
      seed = manualPinSeed();
      accessPin = deriveGuestGroupAccessPin(siteId, groupId, seed, secret);
    }
    await tx
      .update(guestGroup)
      .set({ manualPinSeed: seed, updatedAt: rotatedAt })
      .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)));
    await revokeIdentity(tx, siteId, groupId, rotatedAt, "MANUAL_PIN_ROTATED");
    return { accessPin };
  });
}

export async function listGuestGroups(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
): Promise<GuestGroupRecord[]> {
  await siteForActor(db, actor, siteId);
  const groups = await db
    .select()
    .from(guestGroup)
    .where(eq(guestGroup.siteId, siteId))
    .orderBy(asc(guestGroup.id));
  if (groups.length === 0) return [];
  const members = await db
    .select()
    .from(guestMember)
    .where(eq(guestMember.siteId, siteId))
    .orderBy(asc(guestMember.id));
  const membersByGroup = new Map<string, MemberRow[]>();
  for (const member of members) {
    const groupMembers = membersByGroup.get(member.groupId) ?? [];
    groupMembers.push(member);
    membersByGroup.set(member.groupId, groupMembers);
  }
  return groups.map((group) =>
    recordFor(group, membersByGroup.get(group.id) ?? []),
  );
}

export async function createGuestGroup(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<GuestGroupRecord> {
  const value = guestGroupCreateInputSchema.parse(input);
  const createdAt = currentTime(now);
  const members = preparedMemberInput(value.members);
  const representative = members.find((member) => member.isRepresentative);
  if (!representative) validationError();
  try {
    return await db.transaction(async (tx) => {
      await lockSiteForActor(tx, actor, siteId, true);
      const groupId = randomUUID();
      await tx.insert(guestGroup).values({
        id: groupId,
        siteId,
        name: displayName(value.name),
        normalizedName: normalizeGuestName(value.name),
        isForeign: value.isForeign,
        phoneE164: value.phone,
        representativeMemberId: representative.id,
        manualPinSeed: manualPinSeed(),
        createdAt,
        updatedAt: createdAt,
      });
      await tx
        .insert(guestMember)
        .values(memberValues(siteId, groupId, members, createdAt));
      return readGroup(tx, siteId, groupId);
    });
  } catch (error) {
    if (error instanceof GuestGroupServiceError) throw error;
    if (isUniqueViolation(error))
      conflict("PHONE_CONFLICT", "Phone is already assigned to a group");
    throw error;
  }
}

export async function updateGuestGroup(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  groupId: string,
  input: unknown,
  now?: Date,
): Promise<GuestGroupRecord> {
  const value = guestGroupUpdateInputSchema.parse(input);
  const updatedAt = currentTime(now);
  try {
    return await db.transaction(async (tx) => {
      await lockSiteForActor(tx, actor, siteId, true);
      const [current] = await tx
        .select()
        .from(guestGroup)
        .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)))
        .limit(1);
      if (!current) notFound("GROUP_NOT_FOUND");
      const currentMembers = await readCurrentMembers(tx, siteId, groupId);
      const nextPhone = Object.hasOwn(value, "phone")
        ? (value.phone ?? null)
        : current.phoneE164;
      const nextForeign = Object.hasOwn(value, "isForeign")
        ? (value.isForeign ?? current.isForeign)
        : current.isForeign;
      if (nextForeign !== (nextPhone === null)) validationError();

      let nextMembers = currentMembers.map((member) => ({
        id: member.id,
        fullName: member.fullName,
        isRepresentative: member.id === current.representativeMemberId,
      }));
      if (value.members)
        nextMembers = preparedMemberInput(value.members, currentMembers, true);
      const nextRepresentative = nextMembers.find(
        (member) => member.isRepresentative,
      );
      if (!nextRepresentative) validationError();
      const identityChanged =
        nextRepresentative.id !== current.representativeMemberId ||
        nextPhone !== current.phoneE164;

      await tx
        .update(guestGroup)
        .set({
          ...(value.name !== undefined
            ? {
                name: displayName(value.name),
                normalizedName: normalizeGuestName(value.name),
              }
            : {}),
          isForeign: nextForeign,
          phoneE164: nextPhone,
          representativeMemberId: nextRepresentative.id,
          updatedAt,
        })
        .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)));

      if (value.members) {
        const currentIds = new Set(currentMembers.map((member) => member.id));
        const nextIds = new Set(nextMembers.map((member) => member.id));
        const staleIds = currentMembers
          .filter((member) => !nextIds.has(member.id))
          .map((member) => member.id);
        if (staleIds.length > 0) {
          await tx
            .delete(guestMember)
            .where(
              and(
                eq(guestMember.siteId, siteId),
                eq(guestMember.groupId, groupId),
                inArray(guestMember.id, staleIds),
              ),
            );
        }
        for (const member of nextMembers) {
          if (currentIds.has(member.id)) {
            await tx
              .update(guestMember)
              .set({
                fullName: displayName(member.fullName),
                normalizedName: normalizeGuestName(member.fullName),
                updatedAt,
              })
              .where(
                and(
                  eq(guestMember.siteId, siteId),
                  eq(guestMember.groupId, groupId),
                  eq(guestMember.id, member.id),
                ),
              );
          } else {
            await tx.insert(guestMember).values({
              ...memberValues(siteId, groupId, [member], updatedAt)[0],
            });
          }
        }
      }
      if (identityChanged) await revokeIdentity(tx, siteId, groupId, updatedAt);
      return readGroup(tx, siteId, groupId);
    });
  } catch (error) {
    if (error instanceof GuestGroupServiceError) throw error;
    if (isUniqueViolation(error))
      conflict("PHONE_CONFLICT", "Phone is already assigned to a group");
    throw error;
  }
}

export async function deleteGuestGroup(
  db: GuestGroupDatabase,
  actor: GuestGroupActor,
  siteId: string,
  groupId: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<{ ok: true }> {
  const confirmation = groupDeleteConfirmationSchema.parse(inputValue);
  const deletedAt = currentTime(nowValue);
  try {
    return await db.transaction(async (tx) => {
      await lockSiteForActor(tx, actor, siteId, true);
      const groupResult = await tx.execute(sql`
        SELECT id, name
        FROM guest_group
        WHERE site_id = ${siteId} AND id = ${groupId}
        FOR UPDATE
      `);
      const group = groupResult.rows[0] as
        | { id: string; name: string }
        | undefined;
      if (!group) notFound("GROUP_NOT_FOUND");
      if (
        confirmation.confirmGroupId !== group.id ||
        confirmation.confirmGroupName !== group.name
      ) {
        conflict(
          "GROUP_CONFIRMATION_MISMATCH",
          "Group confirmation does not match",
        );
      }

      const affectedReceipts = await tx
        .select({ receiptId: rsvpRequestReceiptGroup.receiptId })
        .from(rsvpRequestReceiptGroup)
        .innerJoin(
          rsvpRequestReceipt,
          and(
            eq(rsvpRequestReceipt.siteId, rsvpRequestReceiptGroup.siteId),
            eq(rsvpRequestReceipt.id, rsvpRequestReceiptGroup.receiptId),
            eq(rsvpRequestReceipt.scope, "ADMIN"),
          ),
        )
        .where(
          and(
            eq(rsvpRequestReceiptGroup.siteId, siteId),
            eq(rsvpRequestReceiptGroup.groupId, groupId),
          ),
        );
      const receiptIds = affectedReceipts.map((receipt) => receipt.receiptId);
      if (receiptIds.length > 0) {
        await tx
          .update(rsvpRequestReceipt)
          .set({
            responseStatus: "REMOVED",
            responseBody: null,
            removedAt: deletedAt,
          })
          .where(
            and(
              eq(rsvpRequestReceipt.siteId, siteId),
              inArray(rsvpRequestReceipt.id, receiptIds),
            ),
          );
      }
      await tx
        .delete(messageRequestReceipt)
        .where(
          and(
            eq(messageRequestReceipt.siteId, siteId),
            eq(messageRequestReceipt.groupId, groupId),
          ),
        );
      const result = await tx
        .delete(guestGroup)
        .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)))
        .returning({ id: guestGroup.id });
      if (result.length === 0) notFound("GROUP_NOT_FOUND");
      return { ok: true } as const;
    });
  } catch (error) {
    if (error instanceof GuestGroupServiceError) throw error;
    throw error;
  }
}
