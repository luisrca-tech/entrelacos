import { createHash, randomUUID } from "node:crypto";
import {
  familyMessageResponseSchema,
  messageDeletionInputSchema,
  messageDeletionResponseSchema,
  messageMutationInputSchema,
  messageMutationResponseSchema,
  messageTextSchema,
  muralConfigurationResponseSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  siteMessageBlockInputSchema,
  siteMessageBlockResponseSchema,
  siteMessagesQuerySchema,
  siteMessagesResponseSchema,
} from "@entrelacos/contracts";
import {
  familyMessage,
  guestGroup,
  messageRequestReceipt,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashFamilySessionToken } from "./familySession";

export type MessagesDatabase = NodePgDatabase<Record<string, never>>;
export type MessagesAdminActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN";
};

export class MessagesServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(title);
    this.name = "MessagesServiceError";
  }
}

function reject(
  status: number,
  code: string,
  title: string,
  details?: Record<string, unknown>,
): never {
  throw new MessagesServiceError(status, code, title, details);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid message time");
  }
  return now;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function messageRecord(row: {
  id: string;
  author_name: string;
  group_name: string;
  text: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    authorName: row.author_name,
    groupName: row.group_name,
    text: messageTextSchema.parse(row.text),
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type FamilyContext = {
  sessionId: string;
  siteId: string;
  groupId: string;
  groupName: string;
  representativeMemberId: string;
  representativeName: string;
  muralEnabled: boolean;
  messageBlocked: boolean;
  messageRevision: number;
  message:
    | {
        id: string;
        author_name: string;
        group_name: string;
        text: string;
        revision: number;
        created_at: Date | string;
        updated_at: Date | string;
      }
    | undefined;
};

async function familyContext(
  db: MessagesDatabase,
  token: string,
  now: Date,
  lock: boolean,
): Promise<FamilyContext> {
  const result = await db.execute(sql`
    SELECT fs.id AS session_id, fs.site_id, fs.group_id,
      fs.expires_at, fs.revoked_at, s.lifecycle, s.mural_enabled,
      gg.name AS group_name, gg.is_foreign, gg.message_blocked, gg.message_revision,
      gg.representative_member_id, rep.full_name AS representative_name,
      fm.id AS message_id, fm.author_name, fm.group_name AS message_group_name,
      fm.text AS message_text, fm.revision AS message_revision_value,
      fm.created_at AS message_created_at, fm.updated_at AS message_updated_at
    FROM family_session fs
    INNER JOIN site s ON s.id = fs.site_id
    INNER JOIN guest_group gg
      ON gg.site_id = fs.site_id AND gg.id = fs.group_id
    INNER JOIN guest_member rep
      ON rep.site_id = gg.site_id AND rep.group_id = gg.id
      AND rep.id = gg.representative_member_id
    LEFT JOIN family_message fm
      ON fm.site_id = gg.site_id AND fm.group_id = gg.id
    WHERE fs.token_hash = ${hashFamilySessionToken(token)}
    ${lock ? sql`FOR UPDATE OF fs, s, gg` : sql``}
  `);
  const row = result.rows[0] as
    | {
        session_id: string;
        site_id: string;
        group_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        lifecycle: string;
        mural_enabled: boolean;
        group_name: string;
        is_foreign: boolean;
        message_blocked: boolean;
        message_revision: number;
        representative_member_id: string;
        representative_name: string;
        message_id: string | null;
        author_name: string | null;
        message_group_name: string | null;
        message_text: string | null;
        message_revision_value: number | null;
        message_created_at: Date | string | null;
        message_updated_at: Date | string | null;
      }
    | undefined;
  const expiresAt = row ? asDate(row.expires_at) : null;
  if (
    !row ||
    row.revoked_at ||
    !expiresAt ||
    expiresAt <= now ||
    row.lifecycle === "INACTIVE" ||
    row.is_foreign
  ) {
    reject(401, "SESSION_INVALID", "Family session is invalid");
  }
  const message =
    row.message_id &&
    row.author_name !== null &&
    row.message_group_name !== null &&
    row.message_text !== null &&
    row.message_revision_value !== null &&
    row.message_created_at !== null &&
    row.message_updated_at !== null
      ? {
          id: row.message_id,
          author_name: row.author_name,
          group_name: row.message_group_name,
          text: row.message_text,
          revision: row.message_revision_value,
          created_at: row.message_created_at,
          updated_at: row.message_updated_at,
        }
      : undefined;
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    groupId: row.group_id,
    groupName: row.group_name,
    representativeMemberId: row.representative_member_id,
    representativeName: row.representative_name,
    muralEnabled: row.mural_enabled,
    messageBlocked: row.message_blocked,
    messageRevision: row.message_revision,
    message,
  };
}

function readOnlyReason(
  context: FamilyContext,
): "MURAL_DISABLED" | "MESSAGE_BLOCKED" | null {
  if (!context.muralEnabled) return "MURAL_DISABLED";
  if (context.messageBlocked) return "MESSAGE_BLOCKED";
  return null;
}

export async function readFamilyMessage(
  db: MessagesDatabase,
  token: string,
  nowValue?: Date,
) {
  const now = currentTime(nowValue);
  const context = await familyContext(db, token, now, false);
  return familyMessageResponseSchema.parse({
    siteId: context.siteId,
    groupId: context.groupId,
    currentRevision: context.messageRevision,
    canEdit: context.muralEnabled && !context.messageBlocked,
    readOnlyReason: readOnlyReason(context),
    message: context.message ? messageRecord(context.message) : null,
  });
}

function canonicalRequestHash(input: {
  requestId: string;
  expectedRevision: number;
  text: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        text: input.text,
      }),
    )
    .digest("hex");
}

async function lockMessageGroup(
  db: MessagesDatabase,
  siteId: string,
  groupId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`family-message:${siteId}:${groupId}`}))`,
  );
}

function receiptResponse(value: unknown) {
  return messageMutationResponseSchema.parse(value);
}

export async function writeFamilyMessage(
  db: MessagesDatabase,
  token: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = messageMutationInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const initial = await familyContext(tx, token, now, false);
    await lockMessageGroup(tx, initial.siteId, initial.groupId);
    const context = await familyContext(tx, token, now, true);
    if (!context.muralEnabled)
      reject(409, "MURAL_DISABLED", "The mural is disabled");
    if (context.messageBlocked)
      reject(409, "MESSAGE_BLOCKED", "Message writes are blocked");

    const hash = canonicalRequestHash(input);
    const [receipt] = await tx
      .select()
      .from(messageRequestReceipt)
      .where(
        and(
          eq(messageRequestReceipt.siteId, context.siteId),
          eq(messageRequestReceipt.groupId, context.groupId),
          eq(messageRequestReceipt.sessionId, context.sessionId),
          eq(messageRequestReceipt.requestId, input.requestId),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== hash)
        reject(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Message request ID was already used",
        );
      if (receipt.result === "REMOVED")
        reject(410, "MESSAGE_REMOVED", "Message was removed");
      const replay = receiptResponse(receipt.responseBody);
      return { ...replay, replayed: true };
    }

    if (input.expectedRevision !== context.messageRevision) {
      reject(409, "MESSAGE_CONFLICT", "Message revision changed", {
        currentRevision: context.messageRevision,
      });
    }

    const current = context.message;
    const changed = !current || current.text !== input.text;
    let message = current;
    let nextRevision = context.messageRevision;
    if (changed) {
      nextRevision += 1;
      const nextMessageId = current?.id ?? randomUUID();
      if (current) {
        await tx
          .update(familyMessage)
          .set({
            text: input.text,
            revision: nextRevision,
            updatedAt: now,
          })
          .where(
            and(
              eq(familyMessage.siteId, context.siteId),
              eq(familyMessage.groupId, context.groupId),
            ),
          );
      } else {
        await tx.insert(familyMessage).values({
          id: nextMessageId,
          siteId: context.siteId,
          groupId: context.groupId,
          authorMemberId: context.representativeMemberId,
          authorName: context.representativeName,
          groupName: context.groupName,
          text: input.text,
          revision: nextRevision,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx
        .update(guestGroup)
        .set({ messageRevision: nextRevision, updatedAt: now })
        .where(
          and(
            eq(guestGroup.siteId, context.siteId),
            eq(guestGroup.id, context.groupId),
          ),
        );
      message = {
        id: nextMessageId,
        author_name: current?.author_name ?? context.representativeName,
        group_name: current?.group_name ?? context.groupName,
        text: input.text,
        revision: nextRevision,
        created_at: current?.created_at ?? now,
        updated_at: now,
      };
    }
    if (!message) reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
    const response = messageMutationResponseSchema.parse({
      requestId: input.requestId,
      acceptedAt: now.toISOString(),
      result: changed ? "APPLIED" : "NO_CHANGE",
      replayed: false,
      message: messageRecord(message),
    });
    await tx.insert(messageRequestReceipt).values({
      id: randomUUID(),
      siteId: context.siteId,
      groupId: context.groupId,
      sessionId: context.sessionId,
      requestId: input.requestId,
      requestHash: hash,
      revision: nextRevision,
      result: response.result,
      responseBody: response,
      createdAt: now,
    });
    return response;
  });
}

async function adminSiteContext(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  mutation: boolean,
  lock: boolean,
): Promise<{ id: string; lifecycle: string; muralEnabled: boolean }> {
  const authorization =
    actor.role === "OWNER"
      ? sql`TRUE`
      : sql`EXISTS (SELECT 1 FROM site_membership sm WHERE sm.site_id = s.id AND sm.user_id = ${actor.userId})`;
  const lockSql = lock ? sql`FOR UPDATE OF s` : sql``;
  const result = await db.execute(sql`
    SELECT s.id, s.lifecycle, s.mural_enabled
    FROM site s
    INNER JOIN "user" u
      ON u.id = ${actor.userId}
      AND u.state = 'ACTIVE'
      AND u.role = ${actor.role}
    WHERE s.id = ${siteId} AND ${authorization}
    ${lockSql}
  `);
  const row = result.rows[0] as
    | { id: string; lifecycle: string; mural_enabled: boolean }
    | undefined;
  if (!row) reject(404, "NOT_FOUND", "Not Found");
  if (mutation && row.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
  return {
    id: row.id,
    lifecycle: row.lifecycle,
    muralEnabled: row.mural_enabled,
  };
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function decodeCursor(
  value: string | undefined,
  siteId: string,
  scope: "mural" | "groups",
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid cursor");
    const record = parsed as Record<string, unknown>;
    const expectedKeys =
      scope === "mural"
        ? ["scope", "siteId", "createdAt", "id"]
        : ["scope", "siteId", "groupName", "id"];
    if (
      Object.keys(record).length !== expectedKeys.length ||
      expectedKeys.some((key) => typeof record[key] !== "string") ||
      record.scope !== scope ||
      record.siteId !== siteId ||
      !identifierPattern.test(record.id as string)
    )
      throw new Error("invalid cursor");
    if (scope === "mural") {
      const createdAt = record.createdAt as string;
      if (
        !Number.isFinite(Date.parse(createdAt)) ||
        new Date(createdAt).toISOString() !== createdAt
      )
        throw new Error("invalid cursor");
    }
    if (scope === "groups" && !(record.groupName as string).trim())
      throw new Error("invalid cursor");
    return record as Record<string, string>;
  } catch {
    reject(400, "VALIDATION_ERROR", "Invalid message cursor");
  }
}

export async function readPublicMural(
  db: MessagesDatabase,
  siteId: string,
  origin: string,
  queryValue: unknown,
) {
  const query = publicMuralQuerySchema.parse(queryValue);
  const cursor = decodeCursor(query.cursor, siteId, "mural");
  const rows = await db
    .select({
      id: site.id,
      lifecycle: site.lifecycle,
      muralEnabled: site.muralEnabled,
      publicUrl: site.publicUrl,
      registeredOrigin: siteOrigin.origin,
    })
    .from(site)
    .leftJoin(siteOrigin, eq(siteOrigin.siteId, site.id))
    .where(eq(site.id, siteId));
  if (rows.length === 0) reject(403, "FORBIDDEN", "Forbidden");
  const siteRow = rows[0];
  const publicUrlOrigin = siteRow.publicUrl
    ? (() => {
        try {
          return new URL(siteRow.publicUrl as string).origin;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (
    !rows.some(
      (row) => row.registeredOrigin === origin || publicUrlOrigin === origin,
    )
  )
    reject(403, "FORBIDDEN", "Forbidden");
  if (siteRow.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
  if (!siteRow.muralEnabled)
    return publicMuralResponseSchema.parse({
      enabled: false,
      messages: [],
      nextCursor: null,
    });

  const conditions = [eq(familyMessage.siteId, siteId)];
  if (cursor) {
    const createdAt = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(familyMessage.createdAt, createdAt),
        and(
          eq(familyMessage.createdAt, createdAt),
          lt(familyMessage.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const messages = await db
    .select()
    .from(familyMessage)
    .where(and(...conditions))
    .orderBy(desc(familyMessage.createdAt), desc(familyMessage.id))
    .limit(query.limit + 1);
  const page = messages.slice(0, query.limit);
  return publicMuralResponseSchema.parse({
    enabled: true,
    messages: page.map((message) => ({
      id: message.id,
      authorName: message.authorName,
      groupName: message.groupName,
      text: messageTextSchema.parse(message.text),
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
    })),
    nextCursor:
      messages.length > query.limit && page.length > 0
        ? encodeCursor({
            scope: "mural",
            siteId,
            createdAt: page[page.length - 1].createdAt.toISOString(),
            id: page[page.length - 1].id,
          })
        : null,
  });
}

export async function listSiteMessages(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  queryValue: unknown,
) {
  const query = siteMessagesQuerySchema.parse(queryValue);
  const cursor = decodeCursor(query.cursor, siteId, "groups");
  await adminSiteContext(db, actor, siteId, false, false);
  const conditions = [eq(guestGroup.siteId, siteId)];
  if (query.groupId) conditions.push(eq(guestGroup.id, query.groupId));
  if (cursor) {
    conditions.push(
      or(
        gt(guestGroup.name, cursor.groupName),
        and(
          eq(guestGroup.name, cursor.groupName),
          gt(guestGroup.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const rows = await db
    .select({
      groupId: guestGroup.id,
      groupName: guestGroup.name,
      blocked: guestGroup.messageBlocked,
      currentRevision: guestGroup.messageRevision,
      message: familyMessage,
    })
    .from(guestGroup)
    .leftJoin(
      familyMessage,
      and(
        eq(familyMessage.siteId, guestGroup.siteId),
        eq(familyMessage.groupId, guestGroup.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(guestGroup.name), asc(guestGroup.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return siteMessagesResponseSchema.parse({
    groups: page.map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      blocked: row.blocked,
      currentRevision: row.currentRevision,
      message: row.message
        ? messageRecord({
            id: row.message.id,
            author_name: row.message.authorName,
            group_name: row.message.groupName,
            text: row.message.text,
            revision: row.message.revision,
            created_at: row.message.createdAt,
            updated_at: row.message.updatedAt,
          })
        : null,
    })),
    nextCursor:
      rows.length > query.limit && page.length > 0
        ? encodeCursor({
            scope: "groups",
            siteId,
            groupName: page[page.length - 1].groupName,
            id: page[page.length - 1].groupId,
          })
        : null,
  });
}

export async function readMuralConfiguration(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
) {
  const context = await adminSiteContext(db, actor, siteId, false, false);
  return muralConfigurationResponseSchema.parse({
    siteId: context.id,
    enabled: context.muralEnabled,
  });
}

export async function updateMuralConfiguration(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = muralConfigurationSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const context = await adminSiteContext(tx, actor, siteId, true, true);
    if (context.muralEnabled !== input.enabled) {
      await tx
        .update(site)
        .set({ muralEnabled: input.enabled, updatedAt: now })
        .where(eq(site.id, siteId));
    }
    return muralConfigurationResponseSchema.parse({
      siteId,
      enabled: input.enabled,
    });
  });
}

export async function updateMessageBlock(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  groupId: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = siteMessageBlockInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await adminSiteContext(tx, actor, siteId, true, true);
    const groupResult = await tx.execute(sql`
      SELECT id, message_blocked FROM guest_group
      WHERE site_id = ${siteId} AND id = ${groupId}
      FOR UPDATE
    `);
    const group = groupResult.rows[0] as
      | { id: string; message_blocked: boolean }
      | undefined;
    if (!group) reject(404, "NOT_FOUND", "Not Found");
    if (group.message_blocked !== input.blocked) {
      await tx
        .update(guestGroup)
        .set({ messageBlocked: input.blocked, updatedAt: now })
        .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)));
    }
    return siteMessageBlockResponseSchema.parse({
      groupId,
      blocked: input.blocked,
    });
  });
}

export async function deleteGroupMessage(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  groupId: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = messageDeletionInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await adminSiteContext(tx, actor, siteId, true, true);
    const groupResult = await tx.execute(sql`
      SELECT id, message_revision FROM guest_group
      WHERE site_id = ${siteId} AND id = ${groupId}
      FOR UPDATE
    `);
    const group = groupResult.rows[0] as
      | { id: string; message_revision: number }
      | undefined;
    if (!group) reject(404, "MESSAGE_NOT_FOUND", "Message was not found");
    if (group.message_revision !== input.expectedRevision)
      reject(409, "MESSAGE_CONFLICT", "Message revision changed", {
        currentRevision: group.message_revision,
      });
    const messageResult = await tx.execute(sql`
      SELECT id FROM family_message
      WHERE site_id = ${siteId} AND group_id = ${groupId}
      FOR UPDATE
    `);
    if (messageResult.rows.length === 0)
      reject(404, "MESSAGE_NOT_FOUND", "Message was not found");
    const nextRevision = group.message_revision + 1;
    await tx
      .update(messageRequestReceipt)
      .set({ result: "REMOVED", responseBody: null, removedAt: now })
      .where(
        and(
          eq(messageRequestReceipt.siteId, siteId),
          eq(messageRequestReceipt.groupId, groupId),
        ),
      );
    await tx
      .delete(familyMessage)
      .where(
        and(
          eq(familyMessage.siteId, siteId),
          eq(familyMessage.groupId, groupId),
        ),
      );
    await tx
      .update(guestGroup)
      .set({ messageRevision: nextRevision, updatedAt: now })
      .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.id, groupId)));
    return messageDeletionResponseSchema.parse({
      ok: true,
      currentRevision: nextRevision,
    });
  });
}

export const getMuralConfiguration = readMuralConfiguration;
export const patchMuralConfiguration = updateMuralConfiguration;
export const patchMessageBlock = updateMessageBlock;
export const removeGroupMessage = deleteGroupMessage;
export const readSiteMural = readMuralConfiguration;
export const updateSiteMural = updateMuralConfiguration;
export const listMessages = listSiteMessages;
export const deleteMessage = deleteGroupMessage;
export const updateGroupMessageBlock = updateMessageBlock;
