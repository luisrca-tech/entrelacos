import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  type InvitationCreateInput,
  type InvitationRecord,
  type InvitationUpdateInput,
  invitationAccessPinResponseSchema,
  invitationCreateInputSchema,
  invitationDeleteConfirmationSchema,
  invitationGuestRecordSchema,
  invitationRecordSchema,
  invitationUpdateInputSchema,
} from "@entrelacos/contracts";
import {
  invitation,
  invitationAccessChallenge,
  invitationGuest,
  invitationRateLimitEvent,
  invitationSession,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptInvitation,
  site,
  siteMembership,
} from "@entrelacos/database/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type InvitationDatabase = NodePgDatabase<Record<string, never>>;
export type InvitationRole = "OWNER" | "SITE_ADMIN";

export interface InvitationActor {
  userId: string;
  role: InvitationRole;
}

export class InvitationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "InvitationServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new InvitationServiceError(status, code, title);
}

function notFound(code = "NOT_FOUND"): never {
  return reject(404, code, "Not Found");
}

function inactiveSite(): never {
  return reject(409, "SITE_INACTIVE", "Site is inactive");
}

function conflict(
  code: string,
  title = "Invitation conflicts with existing data",
): never {
  return reject(409, code, title);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid invitation request");
  }
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

/** Normalize invitation names for stable identity comparisons. */
export function normalizeInvitationName(value: string): string {
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
  db: InvitationDatabase,
  actor: InvitationActor,
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
  db: InvitationDatabase,
  actor: InvitationActor,
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

type InvitationRow = typeof invitation.$inferSelect;
type InvitationGuestRow = typeof invitationGuest.$inferSelect;

async function readInvitation(
  db: InvitationDatabase,
  siteId: string,
  invitationId: string,
): Promise<InvitationRecord> {
  const [record] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)))
    .limit(1);
  if (!record) notFound("INVITATION_NOT_FOUND");
  const guests = await db
    .select()
    .from(invitationGuest)
    .where(
      and(
        eq(invitationGuest.siteId, siteId),
        eq(invitationGuest.invitationId, invitationId),
      ),
    )
    .orderBy(asc(invitationGuest.id));
  return invitationRecordSchema.parse({
    id: record.id,
    siteId: record.siteId,
    name: record.name,
    phone: record.phoneE164,
    email: record.email,
    guests: guests.map((guest) =>
      invitationGuestRecordSchema.parse({
        id: guest.id,
        fullName: guest.fullName,
        guestType: guest.guestType,
        rsvpState: guest.rsvpState,
        rsvpRevision: guest.rsvpRevision,
      }),
    ),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function guestValues(
  siteId: string,
  invitationId: string,
  guests: Array<{
    id: string;
    fullName: string;
    guestType: "ADULT" | "CHILD";
  }>,
  now: Date,
) {
  return guests.map((guest) => ({
    id: guest.id,
    siteId,
    invitationId,
    fullName: displayName(guest.fullName),
    normalizedName: normalizeInvitationName(guest.fullName),
    guestType: guest.guestType,
    createdAt: now,
    updatedAt: now,
  }));
}

function manualPinSeed(): string {
  return randomBytes(32).toString("hex");
}

export function deriveInvitationAccessPin(
  siteId: string,
  invitationId: string,
  seed: string,
  secret: string,
): string {
  if (secret.trim().length < 32 || !/^[a-f0-9]{64}$/.test(seed)) {
    reject(
      503,
      "VERIFICATION_CONFIGURATION_ERROR",
      "Invitation verification is not configured",
    );
  }
  const digest = createHmac("sha256", secret)
    .update(`entrelacos:guest-access-pin:v1:${siteId}:${invitationId}:${seed}`)
    .digest();
  return String(Number(digest.readBigUInt64BE(0) % 1_000_000n)).padStart(
    6,
    "0",
  );
}

async function revokeIdentity(
  db: InvitationDatabase,
  siteId: string,
  invitationId: string,
  now: Date,
  reason = "INVITATION_IDENTITY_CHANGED",
): Promise<void> {
  await db
    .update(invitationSession)
    .set({ revokedAt: now, revocationReason: reason })
    .where(
      and(
        eq(invitationSession.siteId, siteId),
        eq(invitationSession.invitationId, invitationId),
        isNull(invitationSession.revokedAt),
      ),
    );
  await db
    .update(invitationAccessChallenge)
    .set({
      status: "REVOKED",
      revokedAt: now,
      revocationReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(invitationAccessChallenge.siteId, siteId),
        eq(invitationAccessChallenge.invitationId, invitationId),
        inArray(invitationAccessChallenge.status, ["PENDING", "LOCKED"]),
      ),
    );
}

export async function listInvitations(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
): Promise<InvitationRecord[]> {
  await siteForActor(db, actor, siteId);
  const records = await db
    .select()
    .from(invitation)
    .where(eq(invitation.siteId, siteId))
    .orderBy(asc(invitation.id));
  if (records.length === 0) return [];
  const guests = await db
    .select()
    .from(invitationGuest)
    .where(eq(invitationGuest.siteId, siteId))
    .orderBy(asc(invitationGuest.id));
  const guestsByInvitation = new Map<string, InvitationGuestRow[]>();
  for (const guest of guests) {
    const invitationGuests = guestsByInvitation.get(guest.invitationId) ?? [];
    invitationGuests.push(guest);
    guestsByInvitation.set(guest.invitationId, invitationGuests);
  }
  return records.map((record) =>
    invitationRecordSchema.parse({
      id: record.id,
      siteId: record.siteId,
      name: record.name,
      phone: record.phoneE164,
      email: record.email,
      guests: (guestsByInvitation.get(record.id) ?? []).map((guest) => ({
        id: guest.id,
        fullName: guest.fullName,
        guestType: guest.guestType,
        rsvpState: guest.rsvpState,
        rsvpRevision: guest.rsvpRevision,
      })),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }),
  );
}

export async function createInvitation(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  input: unknown,
  nowValue?: Date,
): Promise<InvitationRecord> {
  const value: InvitationCreateInput = invitationCreateInputSchema.parse(input);
  const createdAt = currentTime(nowValue);
  const invitationId = randomUUID();
  const guests = value.guests.map((guest) => ({
    id: randomUUID(),
    fullName: guest.fullName,
    guestType: guest.guestType,
  }));
  try {
    return await db.transaction(async (tx) => {
      await lockSiteForActor(tx, actor, siteId, true);
      await tx.insert(invitation).values({
        id: invitationId,
        siteId,
        name: displayName(value.name),
        normalizedName: normalizeInvitationName(value.name),
        phoneE164: value.phone,
        email: value.email ?? null,
        manualPinSeed: manualPinSeed(),
        createdAt,
        updatedAt: createdAt,
      });
      await tx
        .insert(invitationGuest)
        .values(guestValues(siteId, invitationId, guests, createdAt));
      return readInvitation(tx, siteId, invitationId);
    });
  } catch (error) {
    if (error instanceof InvitationServiceError) throw error;
    if (isUniqueViolation(error)) {
      conflict("PHONE_CONFLICT", "Phone is already assigned to an invitation");
    }
    throw error;
  }
}

function updatedGuests(
  input: NonNullable<InvitationUpdateInput["guests"]>,
  current: InvitationGuestRow[],
) {
  const currentById = new Map(current.map((guest) => [guest.id, guest]));
  const seen = new Set<string>();
  return input.map((guest) => {
    const id = guest.id ?? randomUUID();
    if (seen.has(id)) {
      reject(400, "VALIDATION_ERROR", "Invalid invitation request");
    }
    seen.add(id);
    if (guest.id && !currentById.has(guest.id)) {
      notFound("INVITATION_GUEST_NOT_FOUND");
    }
    return { id, fullName: guest.fullName, guestType: guest.guestType };
  });
}

export async function updateInvitation(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  invitationId: string,
  input: unknown,
  nowValue?: Date,
): Promise<InvitationRecord> {
  const value: InvitationUpdateInput = invitationUpdateInputSchema.parse(input);
  const updatedAt = currentTime(nowValue);
  try {
    return await db.transaction(async (tx) => {
      await lockSiteForActor(tx, actor, siteId, true);
      const locked = await tx.execute(sql`
        SELECT id
        FROM invitation
        WHERE site_id = ${siteId} AND id = ${invitationId}
        FOR UPDATE
      `);
      if (locked.rows.length === 0) notFound("INVITATION_NOT_FOUND");
      const [current] = await tx
        .select()
        .from(invitation)
        .where(
          and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
        )
        .limit(1);
      if (!current) notFound("INVITATION_NOT_FOUND");

      const nextName =
        value.name === undefined ? current.name : displayName(value.name);
      const nextPhone = value.phone ?? current.phoneE164;
      const nextEmail = Object.hasOwn(value, "email")
        ? (value.email ?? null)
        : current.email;
      const identityChanged =
        nextName !== current.name || nextPhone !== current.phoneE164;

      await tx
        .update(invitation)
        .set({
          name: nextName,
          normalizedName: normalizeInvitationName(nextName),
          phoneE164: nextPhone,
          email: nextEmail,
          updatedAt,
        })
        .where(
          and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
        );

      if (value.guests) {
        const currentGuests = await tx
          .select()
          .from(invitationGuest)
          .where(
            and(
              eq(invitationGuest.siteId, siteId),
              eq(invitationGuest.invitationId, invitationId),
            ),
          )
          .orderBy(asc(invitationGuest.id))
          .for("update");
        const nextGuests = updatedGuests(value.guests, currentGuests);
        const currentIds = new Set(currentGuests.map((guest) => guest.id));
        const nextIds = new Set(nextGuests.map((guest) => guest.id));
        const removedIds = currentGuests
          .filter((guest) => !nextIds.has(guest.id))
          .map((guest) => guest.id);
        if (removedIds.length > 0) {
          const removedIdParameters = sql.join(
            removedIds.map((id) => sql`${id}`),
            sql`, `,
          );
          await tx.execute(sql`
            UPDATE rsvp_request_receipt AS receipt
            SET response_status = 'REMOVED', response_body = NULL,
              removed_at = ${updatedAt}
            WHERE receipt.site_id = ${siteId}
              AND receipt.response_body IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  COALESCE(receipt.response_body->'guests', '[]'::jsonb)
                ) AS response_guest(value)
                WHERE response_guest.value->>'id' IN (${removedIdParameters})
              )
          `);
          await tx
            .delete(invitationGuest)
            .where(
              and(
                eq(invitationGuest.siteId, siteId),
                eq(invitationGuest.invitationId, invitationId),
                inArray(invitationGuest.id, removedIds),
              ),
            );
        }
        for (const guest of nextGuests) {
          if (currentIds.has(guest.id)) {
            await tx
              .update(invitationGuest)
              .set({
                fullName: displayName(guest.fullName),
                normalizedName: normalizeInvitationName(guest.fullName),
                guestType: guest.guestType,
                updatedAt,
              })
              .where(
                and(
                  eq(invitationGuest.siteId, siteId),
                  eq(invitationGuest.invitationId, invitationId),
                  eq(invitationGuest.id, guest.id),
                ),
              );
          } else {
            await tx
              .insert(invitationGuest)
              .values(guestValues(siteId, invitationId, [guest], updatedAt));
          }
        }
      }
      if (identityChanged) {
        await revokeIdentity(tx, siteId, invitationId, updatedAt);
      }
      return readInvitation(tx, siteId, invitationId);
    });
  } catch (error) {
    if (error instanceof InvitationServiceError) throw error;
    if (isUniqueViolation(error)) {
      conflict("PHONE_CONFLICT", "Phone is already assigned to an invitation");
    }
    throw error;
  }
}

async function accessPinInvitation(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  invitationId: string,
): Promise<Pick<InvitationRow, "id" | "manualPinSeed">> {
  await siteForActor(db, actor, siteId);
  const [record] = await db
    .select({ id: invitation.id, manualPinSeed: invitation.manualPinSeed })
    .from(invitation)
    .where(and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)))
    .limit(1);
  if (!record) notFound("INVITATION_NOT_FOUND");
  return record;
}

export async function getInvitationAccessPin(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  invitationId: string,
  secret: string,
): Promise<{ accessPin: string }> {
  const record = await accessPinInvitation(db, actor, siteId, invitationId);
  return invitationAccessPinResponseSchema.parse({
    accessPin: deriveInvitationAccessPin(
      siteId,
      record.id,
      record.manualPinSeed,
      secret,
    ),
  });
}

export async function rotateInvitationAccessPin(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  invitationId: string,
  secret: string,
  nowValue?: Date,
): Promise<{ accessPin: string }> {
  const rotatedAt = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await lockSiteForActor(tx, actor, siteId, true);
    const result = await tx.execute(sql`
      SELECT id, manual_pin_seed
      FROM invitation
      WHERE site_id = ${siteId} AND id = ${invitationId}
      FOR UPDATE
    `);
    const record = result.rows[0] as
      | { id: string; manual_pin_seed: string }
      | undefined;
    if (!record) notFound("INVITATION_NOT_FOUND");

    const previousPin = deriveInvitationAccessPin(
      siteId,
      invitationId,
      record.manual_pin_seed,
      secret,
    );
    let seed = manualPinSeed();
    let accessPin = deriveInvitationAccessPin(
      siteId,
      invitationId,
      seed,
      secret,
    );
    while (accessPin === previousPin) {
      seed = manualPinSeed();
      accessPin = deriveInvitationAccessPin(siteId, invitationId, seed, secret);
    }
    await tx
      .update(invitation)
      .set({ manualPinSeed: seed, updatedAt: rotatedAt })
      .where(
        and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
      );
    await revokeIdentity(
      tx,
      siteId,
      invitationId,
      rotatedAt,
      "ACCESS_PIN_ROTATED",
    );
    return invitationAccessPinResponseSchema.parse({ accessPin });
  });
}

export async function deleteInvitation(
  db: InvitationDatabase,
  actor: InvitationActor,
  siteId: string,
  invitationId: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<{ ok: true }> {
  const confirmation = invitationDeleteConfirmationSchema.parse(inputValue);
  const deletedAt = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await lockSiteForActor(tx, actor, siteId, true);
    const locked = await tx.execute(sql`
      SELECT id, name
      FROM invitation
      WHERE site_id = ${siteId} AND id = ${invitationId}
      FOR UPDATE
    `);
    const record = locked.rows[0] as { id: string; name: string } | undefined;
    if (!record) notFound("INVITATION_NOT_FOUND");
    if (
      confirmation.confirmInvitationId !== record.id ||
      confirmation.confirmInvitationName !== record.name
    ) {
      conflict(
        "INVITATION_CONFIRMATION_MISMATCH",
        "Invitation confirmation does not match",
      );
    }

    const affectedAdminReceipts = await tx
      .select({ receiptId: rsvpRequestReceiptInvitation.receiptId })
      .from(rsvpRequestReceiptInvitation)
      .innerJoin(
        rsvpRequestReceipt,
        and(
          eq(rsvpRequestReceipt.siteId, rsvpRequestReceiptInvitation.siteId),
          eq(rsvpRequestReceipt.id, rsvpRequestReceiptInvitation.receiptId),
          eq(rsvpRequestReceipt.scope, "ADMIN"),
        ),
      )
      .where(
        and(
          eq(rsvpRequestReceiptInvitation.siteId, siteId),
          eq(rsvpRequestReceiptInvitation.invitationId, invitationId),
        ),
      );
    const adminReceiptIds = affectedAdminReceipts.map(
      (receipt) => receipt.receiptId,
    );
    if (adminReceiptIds.length > 0) {
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
            inArray(rsvpRequestReceipt.id, adminReceiptIds),
            eq(rsvpRequestReceipt.scope, "ADMIN"),
          ),
        );
    }

    await tx
      .delete(rsvpHistory)
      .where(
        and(
          eq(rsvpHistory.siteId, siteId),
          eq(rsvpHistory.invitationId, invitationId),
        ),
      );
    await tx
      .delete(rsvpRequestReceiptInvitation)
      .where(
        and(
          eq(rsvpRequestReceiptInvitation.siteId, siteId),
          eq(rsvpRequestReceiptInvitation.invitationId, invitationId),
        ),
      );
    await tx
      .delete(rsvpRequestReceipt)
      .where(
        and(
          eq(rsvpRequestReceipt.siteId, siteId),
          eq(rsvpRequestReceipt.invitationId, invitationId),
        ),
      );
    await tx
      .delete(invitationRateLimitEvent)
      .where(
        and(
          eq(invitationRateLimitEvent.siteId, siteId),
          eq(invitationRateLimitEvent.invitationId, invitationId),
        ),
      );
    await tx
      .delete(invitationSession)
      .where(
        and(
          eq(invitationSession.siteId, siteId),
          eq(invitationSession.invitationId, invitationId),
        ),
      );
    await tx
      .delete(invitationAccessChallenge)
      .where(
        and(
          eq(invitationAccessChallenge.siteId, siteId),
          eq(invitationAccessChallenge.invitationId, invitationId),
        ),
      );
    await tx
      .delete(invitationGuest)
      .where(
        and(
          eq(invitationGuest.siteId, siteId),
          eq(invitationGuest.invitationId, invitationId),
        ),
      );
    const deleted = await tx
      .delete(invitation)
      .where(
        and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
      )
      .returning({ id: invitation.id });
    if (deleted.length === 0) notFound("INVITATION_NOT_FOUND");
    return { ok: true } as const;
  });
}
