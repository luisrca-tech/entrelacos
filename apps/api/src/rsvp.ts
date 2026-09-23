import { createHash, randomUUID } from "node:crypto";
import {
  type AdminRsvpWriteInput,
  adminRsvpWriteInputSchema,
  type InvitationRsvpResponse,
  type InvitationRsvpWriteInput,
  invitationRsvpResponseSchema,
  invitationRsvpWriteInputSchema,
  type RsvpDeadline,
  type RsvpHistoryQuery,
  type RsvpState,
  type RsvpWriteResponse,
  rsvpDeadlineSchema,
  rsvpHistoryQuerySchema,
  rsvpHistoryResponseSchema,
  rsvpWriteResponseSchema,
  type SiteRsvpResponse,
  siteRsvpQuerySchema,
  siteRsvpResponseSchema,
} from "@entrelacos/contracts";
import {
  invitation,
  invitationGuest,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptInvitation,
  site,
} from "@entrelacos/database/schema";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashInvitationSessionToken } from "./guestVerification";

export type RsvpDatabase = NodePgDatabase<Record<string, never>>;
export type RsvpAdminActor = { userId: string; role: "OWNER" | "SITE_ADMIN" };

export class RsvpServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(title);
    this.name = "RsvpServiceError";
  }
}

function reject(
  status: number,
  code: string,
  title: string,
  details?: Record<string, unknown>,
): never {
  throw new RsvpServiceError(status, code, title, details);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid RSVP request");
  }
  return now;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

type InvitationContext = {
  sessionId: string;
  siteId: string;
  invitationId: string;
  invitationName: string;
  expiresAt: Date;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
  deadlineAt: Date | null;
  deadlineTimezone: string | null;
};

async function invitationContext(
  db: RsvpDatabase,
  token: string,
  now: Date,
  lock: boolean,
): Promise<InvitationContext> {
  const tokenHash = hashInvitationSessionToken(token);
  const result = await db.execute(sql`
    SELECT session.id AS session_id, session.site_id, session.invitation_id,
      session.expires_at, session.revoked_at, wedding.lifecycle,
      wedding.rsvp_deadline_at, wedding.rsvp_deadline_timezone,
      invite.name AS invitation_name
    FROM invitation_session AS session
    INNER JOIN site AS wedding ON wedding.id = session.site_id
    INNER JOIN invitation AS invite
      ON invite.site_id = session.site_id AND invite.id = session.invitation_id
    WHERE session.token_hash = ${tokenHash}
    ${lock ? sql`FOR SHARE OF session, wedding, invite` : sql``}
  `);
  const row = result.rows[0] as
    | {
        session_id: string;
        site_id: string;
        invitation_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        lifecycle: InvitationContext["lifecycle"];
        rsvp_deadline_at: Date | string | null;
        rsvp_deadline_timezone: string | null;
        invitation_name: string;
      }
    | undefined;
  const expiresAt = row ? asDate(row.expires_at) : null;
  if (
    !row ||
    row.revoked_at ||
    !expiresAt ||
    expiresAt <= now ||
    row.lifecycle === "INACTIVE"
  ) {
    reject(401, "SESSION_INVALID", "Invitation session is invalid");
  }
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    invitationId: row.invitation_id,
    invitationName: row.invitation_name,
    expiresAt,
    lifecycle: row.lifecycle,
    deadlineAt: asDate(row.rsvp_deadline_at),
    deadlineTimezone: row.rsvp_deadline_timezone,
  };
}

async function invitationGuests(
  db: RsvpDatabase,
  siteId: string,
  invitationId: string,
) {
  return db
    .select({
      id: invitationGuest.id,
      fullName: invitationGuest.fullName,
      guestType: invitationGuest.guestType,
      state: invitationGuest.rsvpState,
      revision: invitationGuest.rsvpRevision,
    })
    .from(invitationGuest)
    .where(
      and(
        eq(invitationGuest.siteId, siteId),
        eq(invitationGuest.invitationId, invitationId),
      ),
    )
    .orderBy(asc(invitationGuest.id));
}

export async function readInvitationRsvp(
  db: RsvpDatabase,
  token: string,
  nowValue?: Date,
): Promise<InvitationRsvpResponse> {
  const now = currentTime(nowValue);
  const context = await invitationContext(db, token, now, false);
  const deadlinePassed =
    context.deadlineAt !== null && now >= context.deadlineAt;
  return invitationRsvpResponseSchema.parse({
    siteId: context.siteId,
    invitationId: context.invitationId,
    invitationName: context.invitationName,
    deadlineAt: context.deadlineAt?.toISOString() ?? null,
    deadlineTimezone: context.deadlineTimezone,
    serverNow: now.toISOString(),
    canEdit: !deadlinePassed,
    readOnlyReason: deadlinePassed ? "DEADLINE_PASSED" : null,
    guests: await invitationGuests(db, context.siteId, context.invitationId),
  });
}

type WriteContext = {
  scope: "PUBLIC" | "ADMIN";
  actorType: "INVITATION" | "ADMIN";
  actorId: string;
  receiptActorId: string;
  actorDisplayName: string;
  siteId: string;
  invitationId: string | null;
  deadlineAt?: Date | null;
};

function requestHash(input: InvitationRsvpWriteInput): string {
  const canonical = {
    requestId: input.requestId,
    guests: [...input.guests].sort((left, right) =>
      left.guestId.localeCompare(right.guestId),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function writeRsvp(
  db: RsvpDatabase,
  context: WriteContext,
  input: InvitationRsvpWriteInput,
  now: Date,
): Promise<RsvpWriteResponse> {
  const hash = requestHash(input);
  return db.transaction(async (tx) => {
    const lockKey = `${context.siteId}:${context.scope}:${context.actorType}:${context.receiptActorId}:${input.requestId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const [receipt] = await tx
      .select()
      .from(rsvpRequestReceipt)
      .where(
        and(
          eq(rsvpRequestReceipt.siteId, context.siteId),
          eq(rsvpRequestReceipt.scope, context.scope),
          eq(rsvpRequestReceipt.actorType, context.actorType),
          eq(rsvpRequestReceipt.actorId, context.receiptActorId),
          eq(rsvpRequestReceipt.requestId, input.requestId),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== hash) {
        reject(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "RSVP request ID was already used",
        );
      }
      if (
        receipt.responseStatus === "REMOVED" ||
        receipt.responseBody === null
      ) {
        reject(410, "RSVP_RESULT_REMOVED", "RSVP result was removed");
      }
      return rsvpWriteResponseSchema.parse({
        ...(receipt.responseBody as Record<string, unknown>),
        replayed: true,
      });
    }

    if (context.deadlineAt && now >= context.deadlineAt) {
      reject(409, "RSVP_DEADLINE_PASSED", "The RSVP deadline has passed");
    }

    const guestIds = input.guests
      .map((guest) => guest.guestId)
      .sort((left, right) => left.localeCompare(right));
    for (const guestId of guestIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`rsvp-guest:${guestId}`}))`,
      );
    }

    const conditions = [
      eq(invitationGuest.siteId, context.siteId),
      inArray(invitationGuest.id, guestIds),
    ];
    if (context.invitationId) {
      conditions.push(eq(invitationGuest.invitationId, context.invitationId));
    }
    const current = await tx
      .select()
      .from(invitationGuest)
      .where(and(...conditions))
      .orderBy(asc(invitationGuest.id))
      .for("update");
    if (current.length !== guestIds.length) {
      reject(404, "NOT_FOUND", "RSVP guest was not found");
    }

    const updateById = new Map(
      input.guests.map((guest) => [guest.guestId, guest]),
    );
    const conflicts = current.filter(
      (guest) =>
        guest.rsvpRevision !== updateById.get(guest.id)?.expectedRevision,
    );
    if (conflicts.length > 0) {
      reject(409, "RSVP_CONFLICT", "RSVP data changed", {
        guests: conflicts.map((guest) => ({
          id: guest.id,
          state: guest.rsvpState,
          revision: guest.rsvpRevision,
        })),
      });
    }

    const invitationIds = [
      ...new Set(current.map((guest) => guest.invitationId)),
    ];
    const invitationRows = await tx
      .select({ id: invitation.id, name: invitation.name })
      .from(invitation)
      .where(
        and(
          eq(invitation.siteId, context.siteId),
          inArray(invitation.id, invitationIds),
        ),
      );
    const invitationNames = new Map(
      invitationRows.map((record) => [record.id, record.name]),
    );
    if (invitationNames.size !== invitationIds.length) {
      reject(404, "NOT_FOUND", "RSVP invitation was not found");
    }

    const changed = current.filter(
      (guest) => guest.rsvpState !== updateById.get(guest.id)?.state,
    );
    for (const guest of changed) {
      const nextState = updateById.get(guest.id)?.state as RsvpState;
      await tx
        .update(invitationGuest)
        .set({
          rsvpState: nextState,
          rsvpRevision: guest.rsvpRevision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(invitationGuest.siteId, guest.siteId),
            eq(invitationGuest.invitationId, guest.invitationId),
            eq(invitationGuest.id, guest.id),
          ),
        );
      await tx.insert(rsvpHistory).values({
        id: randomUUID(),
        siteId: guest.siteId,
        invitationId: guest.invitationId,
        guestId: guest.id,
        invitationName: invitationNames.get(guest.invitationId) as string,
        guestDisplayName: guest.fullName,
        beforeState: guest.rsvpState,
        afterState: nextState,
        actorType: context.actorType,
        actorId: context.actorId,
        actorDisplayName: context.actorDisplayName,
        occurredAt: now,
      });
    }

    const response = rsvpWriteResponseSchema.parse({
      requestId: input.requestId,
      acceptedAt: now.toISOString(),
      result: changed.length > 0 ? "APPLIED" : "NO_CHANGE",
      replayed: false,
      guests: current.map((guest) => {
        const state = updateById.get(guest.id)?.state as RsvpState;
        return {
          id: guest.id,
          fullName: guest.fullName,
          guestType: guest.guestType,
          state,
          revision: guest.rsvpRevision + (guest.rsvpState === state ? 0 : 1),
        };
      }),
    });
    const receiptId = randomUUID();
    await tx.insert(rsvpRequestReceipt).values({
      id: receiptId,
      siteId: context.siteId,
      invitationId: context.invitationId,
      scope: context.scope,
      actorType: context.actorType,
      actorId: context.receiptActorId,
      requestId: input.requestId,
      requestHash: hash,
      responseStatus: response.result,
      responseBody: response,
      removedAt: null,
      createdAt: now,
    });
    if (context.scope === "ADMIN") {
      await tx.insert(rsvpRequestReceiptInvitation).values(
        invitationIds.map((invitationId) => ({
          siteId: context.siteId,
          receiptId,
          invitationId,
        })),
      );
    }
    return response;
  });
}

export async function writeInvitationRsvp(
  db: RsvpDatabase,
  token: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<RsvpWriteResponse> {
  const input = invitationRsvpWriteInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const context = await invitationContext(tx, token, now, true);
    return writeRsvp(
      tx,
      {
        scope: "PUBLIC",
        actorType: "INVITATION",
        actorId: context.invitationId,
        receiptActorId: context.sessionId,
        actorDisplayName: context.invitationName,
        siteId: context.siteId,
        invitationId: context.invitationId,
        deadlineAt: context.deadlineAt,
      },
      input,
      now,
    );
  });
}

type AdminContext = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
  deadlineAt: Date | null;
  deadlineTimezone: string | null;
  actorDisplayName: string;
};

async function adminContext(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
  lock: "share" | "update" | null,
  mutation: boolean,
): Promise<AdminContext> {
  const membership =
    actor.role === "OWNER"
      ? sql``
      : sql`INNER JOIN site_membership sm
          ON sm.site_id = s.id AND sm.user_id = u.id`;
  const lockSql =
    lock === "update"
      ? sql`FOR UPDATE OF s`
      : lock === "share"
        ? sql`FOR SHARE OF s`
        : sql``;
  const result = await db.execute(sql`
    SELECT s.id AS site_id, s.lifecycle, s.rsvp_deadline_at,
      s.rsvp_deadline_timezone, u.name AS actor_display_name
    FROM site s
    INNER JOIN "user" u ON u.id = ${actor.userId} AND u.state = 'ACTIVE'
    ${membership}
    WHERE s.id = ${siteId}
    ${lockSql}
  `);
  const row = result.rows[0] as
    | {
        site_id: string;
        lifecycle: AdminContext["lifecycle"];
        rsvp_deadline_at: Date | string | null;
        rsvp_deadline_timezone: string | null;
        actor_display_name: string;
      }
    | undefined;
  if (!row) reject(404, "NOT_FOUND", "Not Found");
  if (mutation && row.lifecycle === "INACTIVE") {
    reject(409, "SITE_INACTIVE", "Site is inactive");
  }
  return {
    siteId: row.site_id,
    lifecycle: row.lifecycle,
    deadlineAt: asDate(row.rsvp_deadline_at),
    deadlineTimezone: row.rsvp_deadline_timezone,
    actorDisplayName: row.actor_display_name,
  };
}

export async function readRsvpDeadline(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
): Promise<RsvpDeadline> {
  const context = await adminContext(db, actor, siteId, null, false);
  return rsvpDeadlineSchema.parse({
    deadlineAt: context.deadlineAt?.toISOString() ?? null,
    deadlineTimezone: context.deadlineTimezone,
  });
}

export async function updateRsvpDeadline(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<RsvpDeadline> {
  const input = rsvpDeadlineSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await adminContext(tx, actor, siteId, "update", true);
    await tx
      .update(site)
      .set({
        rsvpDeadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null,
        rsvpDeadlineTimezone: input.deadlineTimezone,
        updatedAt: now,
      })
      .where(eq(site.id, siteId));
    return input;
  });
}

function emptyTotals() {
  return { pending: 0, confirmed: 0, declined: 0 };
}

function addState(
  totals: ReturnType<typeof emptyTotals>,
  state: RsvpState,
): void {
  if (state === "PENDING") totals.pending += 1;
  else if (state === "CONFIRMED") totals.confirmed += 1;
  else totals.declined += 1;
}

export async function readSiteRsvp(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
  queryValue: unknown,
): Promise<SiteRsvpResponse> {
  const query = siteRsvpQuerySchema.parse(queryValue);
  const context = await adminContext(db, actor, siteId, null, false);
  const rows = await db
    .select({
      invitationId: invitation.id,
      invitationName: invitation.name,
      guestId: invitationGuest.id,
      guestName: invitationGuest.fullName,
      guestType: invitationGuest.guestType,
      state: invitationGuest.rsvpState,
      revision: invitationGuest.rsvpRevision,
    })
    .from(invitation)
    .innerJoin(
      invitationGuest,
      and(
        eq(invitationGuest.siteId, invitation.siteId),
        eq(invitationGuest.invitationId, invitation.id),
      ),
    )
    .where(eq(invitation.siteId, siteId))
    .orderBy(asc(invitation.name), asc(invitationGuest.id));

  const totals = emptyTotals();
  const invitations = new Map<
    string,
    {
      id: string;
      name: string;
      totals: ReturnType<typeof emptyTotals>;
      guests: Array<{
        id: string;
        fullName: string;
        guestType: "ADULT" | "CHILD";
        state: RsvpState;
        revision: number;
      }>;
    }
  >();
  for (const row of rows) {
    addState(totals, row.state);
    const record = invitations.get(row.invitationId) ?? {
      id: row.invitationId,
      name: row.invitationName,
      totals: emptyTotals(),
      guests: [],
    };
    addState(record.totals, row.state);
    if (
      (!query.invitationId || query.invitationId === row.invitationId) &&
      (!query.state || query.state === row.state)
    ) {
      record.guests.push({
        id: row.guestId,
        fullName: row.guestName,
        guestType: row.guestType,
        state: row.state,
        revision: row.revision,
      });
    }
    invitations.set(row.invitationId, record);
  }
  return siteRsvpResponseSchema.parse({
    siteId,
    lifecycle: context.lifecycle,
    deadlineAt: context.deadlineAt?.toISOString() ?? null,
    deadlineTimezone: context.deadlineTimezone,
    totals,
    invitations: [...invitations.values()].filter(
      (record) =>
        record.guests.length > 0 &&
        (!query.invitationId || record.id === query.invitationId),
    ),
  });
}

export async function writeAdminRsvp(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<RsvpWriteResponse> {
  const input: AdminRsvpWriteInput =
    adminRsvpWriteInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const context = await adminContext(tx, actor, siteId, "share", true);
    return writeRsvp(
      tx,
      {
        scope: "ADMIN",
        actorType: "ADMIN",
        actorId: actor.userId,
        receiptActorId: actor.userId,
        actorDisplayName: context.actorDisplayName,
        siteId,
        invitationId: null,
      },
      input,
      now,
    );
  });
}

type HistoryCursor = { occurredAt: string; id: string };

function decodeHistoryCursor(value: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.occurredAt)) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error();
    }
    return parsed;
  } catch {
    reject(400, "VALIDATION_ERROR", "Invalid RSVP history cursor");
  }
}

function encodeHistoryCursor(value: HistoryCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function listRsvpHistory(
  db: RsvpDatabase,
  actor: RsvpAdminActor,
  siteId: string,
  queryValue: unknown,
) {
  const query: RsvpHistoryQuery = rsvpHistoryQuerySchema.parse(queryValue);
  await adminContext(db, actor, siteId, null, false);
  const conditions = [eq(rsvpHistory.siteId, siteId)];
  if (query.invitationId) {
    conditions.push(eq(rsvpHistory.invitationId, query.invitationId));
  }
  if (query.guestId) conditions.push(eq(rsvpHistory.guestId, query.guestId));
  if (query.actorType)
    conditions.push(eq(rsvpHistory.actorType, query.actorType));
  if (query.beforeState) {
    conditions.push(eq(rsvpHistory.beforeState, query.beforeState));
  }
  if (query.afterState) {
    conditions.push(eq(rsvpHistory.afterState, query.afterState));
  }
  if (query.from)
    conditions.push(gte(rsvpHistory.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lt(rsvpHistory.occurredAt, new Date(query.to)));
  if (query.cursor) {
    const cursor = decodeHistoryCursor(query.cursor);
    const occurredAt = new Date(cursor.occurredAt);
    conditions.push(
      or(
        lt(rsvpHistory.occurredAt, occurredAt),
        and(
          eq(rsvpHistory.occurredAt, occurredAt),
          lt(rsvpHistory.id, cursor.id),
        ),
      ) as ReturnType<typeof eq>,
    );
  }
  const rows = await db
    .select()
    .from(rsvpHistory)
    .where(and(...conditions))
    .orderBy(desc(rsvpHistory.occurredAt), desc(rsvpHistory.id))
    .limit(query.limit + 1);
  const hasNext = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return rsvpHistoryResponseSchema.parse({
    entries: page.map((entry) => ({
      ...entry,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    nextCursor:
      hasNext && last
        ? encodeHistoryCursor({
            occurredAt: last.occurredAt.toISOString(),
            id: last.id,
          })
        : null,
  });
}
