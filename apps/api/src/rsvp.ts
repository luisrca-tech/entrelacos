import { createHash, randomUUID } from "node:crypto";
import {
  type AdminRsvpWriteInput,
  adminRsvpWriteInputSchema,
  type FamilyRsvpResponse,
  type FamilyRsvpWriteInput,
  familyRsvpResponseSchema,
  familyRsvpWriteInputSchema,
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
  guestGroup,
  guestMember,
  rsvpHistory,
  rsvpRequestReceipt,
  site,
} from "@entrelacos/database/schema";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashFamilySessionToken } from "./familySession";

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
  if (!Number.isFinite(now.getTime()))
    reject(400, "VALIDATION_ERROR", "Invalid RSVP request");
  return now;
}

function asDate(value: Date | string | null): Date | null {
  return value === null
    ? null
    : value instanceof Date
      ? value
      : new Date(value);
}

type FamilyContext = {
  sessionId: string;
  siteId: string;
  groupId: string;
  expiresAt: Date;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
  deadlineAt: Date | null;
  deadlineTimezone: string | null;
  groupName: string;
  representativeId: string;
  representativeName: string;
};

async function familyContext(
  db: RsvpDatabase,
  token: string,
  now: Date,
  lock: boolean,
): Promise<FamilyContext> {
  const tokenHash = hashFamilySessionToken(token);
  const result = await db.execute(sql`
    SELECT fs.id AS session_id, fs.site_id, fs.group_id, fs.expires_at,
      fs.revoked_at, s.lifecycle, s.rsvp_deadline_at,
      s.rsvp_deadline_timezone, gg.name AS group_name, gg.is_foreign,
      gg.representative_member_id, gm.full_name AS representative_name
    FROM family_session fs
    INNER JOIN site s ON s.id = fs.site_id
    INNER JOIN guest_group gg
      ON gg.site_id = fs.site_id AND gg.id = fs.group_id
    INNER JOIN guest_member gm
      ON gm.site_id = gg.site_id AND gm.group_id = gg.id
      AND gm.id = gg.representative_member_id
    WHERE fs.token_hash = ${tokenHash}
    ${lock ? sql`FOR SHARE OF fs, s, gg` : sql``}
  `);
  const row = result.rows[0] as
    | {
        session_id: string;
        site_id: string;
        group_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        lifecycle: FamilyContext["lifecycle"];
        rsvp_deadline_at: Date | string | null;
        rsvp_deadline_timezone: string | null;
        group_name: string;
        is_foreign: boolean;
        representative_member_id: string;
        representative_name: string;
      }
    | undefined;
  if (
    !row ||
    row.revoked_at ||
    asDate(row.expires_at) === null ||
    (asDate(row.expires_at) as Date) <= now ||
    row.lifecycle === "INACTIVE" ||
    row.is_foreign
  ) {
    reject(401, "SESSION_INVALID", "Family session is invalid");
  }
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    groupId: row.group_id,
    expiresAt: asDate(row.expires_at) as Date,
    lifecycle: row.lifecycle,
    deadlineAt: asDate(row.rsvp_deadline_at),
    deadlineTimezone: row.rsvp_deadline_timezone,
    groupName: row.group_name,
    representativeId: row.representative_member_id,
    representativeName: row.representative_name,
  };
}

async function membersForGroup(
  db: RsvpDatabase,
  siteId: string,
  groupId: string,
) {
  const [group] = await db
    .select({ representativeId: guestGroup.representativeMemberId })
    .from(guestGroup)
    .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)))
    .limit(1);
  if (!group) reject(401, "SESSION_INVALID", "Family session is invalid");
  return db
    .select({
      id: guestMember.id,
      fullName: guestMember.fullName,
      state: guestMember.rsvpState,
      revision: guestMember.rsvpRevision,
    })
    .from(guestMember)
    .where(
      and(eq(guestMember.siteId, siteId), eq(guestMember.groupId, groupId)),
    )
    .orderBy(asc(guestMember.id))
    .then((rows) =>
      rows.map((member) => ({
        ...member,
        isRepresentative: member.id === group.representativeId,
      })),
    );
}

export async function readFamilyRsvp(
  db: RsvpDatabase,
  token: string,
  nowValue?: Date,
): Promise<FamilyRsvpResponse> {
  const now = currentTime(nowValue);
  const context = await familyContext(db, token, now, false);
  const deadlinePassed =
    context.deadlineAt !== null && now >= context.deadlineAt;
  return familyRsvpResponseSchema.parse({
    siteId: context.siteId,
    groupId: context.groupId,
    deadlineAt: context.deadlineAt?.toISOString() ?? null,
    deadlineTimezone: context.deadlineTimezone,
    serverNow: now.toISOString(),
    canEdit: !deadlinePassed,
    readOnlyReason: deadlinePassed ? "DEADLINE_PASSED" : null,
    members: await membersForGroup(db, context.siteId, context.groupId),
  });
}

function requestHash(input: FamilyRsvpWriteInput): string {
  const canonical = {
    requestId: input.requestId,
    members: [...input.members].sort((left, right) =>
      left.memberId.localeCompare(right.memberId),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function writeRsvp(
  db: RsvpDatabase,
  context: {
    scope: "PUBLIC" | "ADMIN";
    actorType: "FAMILY" | "ADMIN";
    actorId: string;
    receiptActorId: string;
    actorDisplayName: string;
    siteId: string;
    groupId: string | null;
    deadlineAt?: Date | null;
  },
  input: FamilyRsvpWriteInput,
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
      if (receipt.requestHash !== hash)
        reject(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "RSVP request ID was already used",
        );
      return rsvpWriteResponseSchema.parse({
        ...(receipt.responseBody as Record<string, unknown>),
        replayed: true,
      });
    }

    if (context.deadlineAt && now >= context.deadlineAt) {
      reject(409, "RSVP_DEADLINE_PASSED", "The RSVP deadline has passed");
    }

    const memberIds = input.members
      .map((member) => member.memberId)
      .sort((left, right) => left.localeCompare(right));
    for (const memberId of memberIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`rsvp-member:${memberId}`}))`,
      );
    }
    const conditions = [
      eq(guestMember.siteId, context.siteId),
      inArray(guestMember.id, memberIds),
    ];
    if (context.groupId)
      conditions.push(eq(guestMember.groupId, context.groupId));
    const current = await tx
      .select()
      .from(guestMember)
      .where(and(...conditions))
      .orderBy(asc(guestMember.id))
      .for("update");
    if (current.length !== memberIds.length)
      reject(404, "NOT_FOUND", "RSVP member was not found");

    const updateById = new Map(
      input.members.map((member) => [member.memberId, member]),
    );
    const conflicts = current.filter(
      (member) =>
        member.rsvpRevision !== updateById.get(member.id)?.expectedRevision,
    );
    if (conflicts.length > 0) {
      reject(409, "RSVP_CONFLICT", "RSVP data changed", {
        members: conflicts.map((member) => ({
          id: member.id,
          state: member.rsvpState,
          revision: member.rsvpRevision,
        })),
      });
    }

    const changed = current.filter(
      (member) => member.rsvpState !== updateById.get(member.id)?.state,
    );
    for (const member of changed) {
      const nextState = updateById.get(member.id)?.state as RsvpState;
      await tx
        .update(guestMember)
        .set({
          rsvpState: nextState,
          rsvpRevision: member.rsvpRevision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(guestMember.siteId, member.siteId),
            eq(guestMember.groupId, member.groupId),
            eq(guestMember.id, member.id),
          ),
        );
      const [group] = await tx
        .select({ name: guestGroup.name })
        .from(guestGroup)
        .where(
          and(
            eq(guestGroup.siteId, member.siteId),
            eq(guestGroup.id, member.groupId),
          ),
        )
        .limit(1);
      if (!group) reject(404, "NOT_FOUND", "RSVP group was not found");
      await tx.insert(rsvpHistory).values({
        id: randomUUID(),
        siteId: member.siteId,
        groupId: member.groupId,
        memberId: member.id,
        groupName: group.name,
        memberDisplayName: member.fullName,
        beforeState: member.rsvpState,
        afterState: nextState,
        actorType: context.actorType,
        actorId: context.actorId,
        actorDisplayName: context.actorDisplayName,
        occurredAt: now,
      });
    }

    const resultMembers = current.map((member) => {
      const state = updateById.get(member.id)?.state as RsvpState;
      return {
        id: member.id,
        fullName: member.fullName,
        isRepresentative: false,
        state,
        revision: member.rsvpRevision + (member.rsvpState === state ? 0 : 1),
      };
    });
    if (context.groupId) {
      const [group] = await tx
        .select({ representativeId: guestGroup.representativeMemberId })
        .from(guestGroup)
        .where(
          and(
            eq(guestGroup.siteId, context.siteId),
            eq(guestGroup.id, context.groupId),
          ),
        )
        .limit(1);
      for (const member of resultMembers)
        member.isRepresentative = member.id === group?.representativeId;
    }
    const response = rsvpWriteResponseSchema.parse({
      requestId: input.requestId,
      acceptedAt: now.toISOString(),
      result: changed.length > 0 ? "APPLIED" : "NO_CHANGE",
      replayed: false,
      members: resultMembers,
    });
    await tx.insert(rsvpRequestReceipt).values({
      id: randomUUID(),
      siteId: context.siteId,
      groupId: context.groupId,
      scope: context.scope,
      actorType: context.actorType,
      actorId: context.receiptActorId,
      requestId: input.requestId,
      requestHash: hash,
      responseStatus: response.result,
      responseBody: response,
      createdAt: now,
    });
    return response;
  });
}

export async function writeFamilyRsvp(
  db: RsvpDatabase,
  token: string,
  inputValue: unknown,
  nowValue?: Date,
): Promise<RsvpWriteResponse> {
  const input = familyRsvpWriteInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const context = await familyContext(tx, token, now, true);
    return writeRsvp(
      tx,
      {
        scope: "PUBLIC",
        actorType: "FAMILY",
        actorId: context.representativeId,
        receiptActorId: context.sessionId,
        actorDisplayName: context.representativeName,
        siteId: context.siteId,
        groupId: context.groupId,
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
  if (mutation && row.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
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
  if (state === "CONFIRMED") totals.confirmed += 1;
  if (state === "DECLINED") totals.declined += 1;
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
      groupId: guestGroup.id,
      groupName: guestGroup.name,
      representativeId: guestGroup.representativeMemberId,
      memberId: guestMember.id,
      memberName: guestMember.fullName,
      state: guestMember.rsvpState,
      revision: guestMember.rsvpRevision,
    })
    .from(guestGroup)
    .innerJoin(
      guestMember,
      and(
        eq(guestMember.siteId, guestGroup.siteId),
        eq(guestMember.groupId, guestGroup.id),
      ),
    )
    .where(eq(guestGroup.siteId, siteId))
    .orderBy(asc(guestGroup.name), asc(guestMember.id));

  const totals = emptyTotals();
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      totals: ReturnType<typeof emptyTotals>;
      members: Array<{
        id: string;
        fullName: string;
        isRepresentative: boolean;
        state: RsvpState;
        revision: number;
      }>;
    }
  >();
  for (const row of rows) {
    addState(totals, row.state);
    const group = groups.get(row.groupId) ?? {
      id: row.groupId,
      name: row.groupName,
      totals: emptyTotals(),
      members: [],
    };
    addState(group.totals, row.state);
    if (
      (!query.groupId || query.groupId === row.groupId) &&
      (!query.state || query.state === row.state)
    ) {
      group.members.push({
        id: row.memberId,
        fullName: row.memberName,
        isRepresentative: row.memberId === row.representativeId,
        state: row.state,
        revision: row.revision,
      });
    }
    groups.set(row.groupId, group);
  }
  return siteRsvpResponseSchema.parse({
    siteId,
    lifecycle: context.lifecycle,
    deadlineAt: context.deadlineAt?.toISOString() ?? null,
    deadlineTimezone: context.deadlineTimezone,
    totals,
    groups: [...groups.values()].filter(
      (group) =>
        group.members.length > 0 &&
        (!query.groupId || group.id === query.groupId),
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
        groupId: null,
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
    )
      throw new Error();
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
  if (query.groupId) conditions.push(eq(rsvpHistory.groupId, query.groupId));
  if (query.memberId) conditions.push(eq(rsvpHistory.memberId, query.memberId));
  if (query.actorType)
    conditions.push(eq(rsvpHistory.actorType, query.actorType));
  if (query.beforeState)
    conditions.push(eq(rsvpHistory.beforeState, query.beforeState));
  if (query.afterState)
    conditions.push(eq(rsvpHistory.afterState, query.afterState));
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
