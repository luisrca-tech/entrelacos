import { createHash, randomUUID } from "node:crypto";
import {
  invitationMessageResponseSchema,
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
  invitation,
  invitationMessage,
  messageRequestReceipt,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashInvitationSessionToken } from "./guestVerification";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";

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
  invitation_name: string;
  text: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    authorName: row.author_name,
    invitationName: row.invitation_name,
    text: messageTextSchema.parse(row.text),
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type InvitationContext = {
  sessionId: string;
  siteId: string;
  invitationId: string;
  invitationName: string;
  muralEnabled: boolean;
  messageBlocked: boolean;
  messageRevision: number;
  message:
    | {
        id: string;
        author_name: string;
        invitation_name: string;
        text: string;
        revision: number;
        created_at: Date | string;
        updated_at: Date | string;
      }
    | undefined;
};

async function invitationContext(
  db: MessagesDatabase,
  token: string,
  now: Date,
  lock: boolean,
): Promise<InvitationContext> {
  const result = await db.execute(sql`
    SELECT session.id AS session_id, session.site_id, session.invitation_id,
      session.expires_at, session.revoked_at, s.lifecycle, s.mural_enabled,
      i.name AS invitation_name, i.message_blocked, i.message_revision,
      fm.id AS message_id, fm.author_name, fm.invitation_name AS message_invitation_name,
      fm.text AS message_text, fm.revision AS message_revision_value,
      fm.created_at AS message_created_at, fm.updated_at AS message_updated_at
    FROM invitation_session session
    INNER JOIN site s ON s.id = session.site_id
    INNER JOIN invitation i
      ON i.site_id = session.site_id AND i.id = session.invitation_id
    LEFT JOIN invitation_message fm
      ON fm.site_id = i.site_id AND fm.invitation_id = i.id
    WHERE session.token_hash = ${hashInvitationSessionToken(token)}
    ${lock ? sql`FOR UPDATE OF session, s, i` : sql``}
  `);
  const row = result.rows[0] as
    | {
        session_id: string;
        site_id: string;
        invitation_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        lifecycle: string;
        mural_enabled: boolean;
        invitation_name: string;
        message_blocked: boolean;
        message_revision: number;
        message_id: string | null;
        author_name: string | null;
        message_invitation_name: string | null;
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
    row.lifecycle === "INACTIVE"
  ) {
    reject(401, "SESSION_INVALID", "Invitation session is invalid");
  }
  const message =
    row.message_id &&
    row.author_name !== null &&
    row.message_invitation_name !== null &&
    row.message_text !== null &&
    row.message_revision_value !== null &&
    row.message_created_at !== null &&
    row.message_updated_at !== null
      ? {
          id: row.message_id,
          author_name: row.author_name,
          invitation_name: row.message_invitation_name,
          text: row.message_text,
          revision: row.message_revision_value,
          created_at: row.message_created_at,
          updated_at: row.message_updated_at,
        }
      : undefined;
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    invitationId: row.invitation_id,
    invitationName: row.invitation_name,
    muralEnabled: row.mural_enabled,
    messageBlocked: row.message_blocked,
    messageRevision: row.message_revision,
    message,
  };
}

function readOnlyReason(
  context: InvitationContext,
): "MURAL_DISABLED" | "MESSAGE_BLOCKED" | null {
  if (!context.muralEnabled) return "MURAL_DISABLED";
  if (context.messageBlocked) return "MESSAGE_BLOCKED";
  return null;
}

export async function readInvitationMessage(
  db: MessagesDatabase,
  token: string,
  nowValue?: Date,
) {
  const now = currentTime(nowValue);
  const context = await invitationContext(db, token, now, false);
  return invitationMessageResponseSchema.parse({
    siteId: context.siteId,
    invitationId: context.invitationId,
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

async function lockMessageInvitation(
  db: MessagesDatabase,
  siteId: string,
  invitationId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`invitation-message:${siteId}:${invitationId}`}))`,
  );
}

function receiptResponse(value: unknown) {
  return messageMutationResponseSchema.parse(value);
}

export async function writeInvitationMessage(
  db: MessagesDatabase,
  token: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = messageMutationInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const initial = await invitationContext(tx, token, now, false);
    await lockMessageInvitation(tx, initial.siteId, initial.invitationId);
    const context = await invitationContext(tx, token, now, true);
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
          eq(messageRequestReceipt.invitationId, context.invitationId),
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
          .update(invitationMessage)
          .set({
            text: input.text,
            revision: nextRevision,
            updatedAt: now,
          })
          .where(
            and(
              eq(invitationMessage.siteId, context.siteId),
              eq(invitationMessage.invitationId, context.invitationId),
            ),
          );
      } else {
        await tx.insert(invitationMessage).values({
          id: nextMessageId,
          siteId: context.siteId,
          invitationId: context.invitationId,
          authorName: context.invitationName,
          invitationName: context.invitationName,
          text: input.text,
          revision: nextRevision,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx
        .update(invitation)
        .set({ messageRevision: nextRevision, updatedAt: now })
        .where(
          and(
            eq(invitation.siteId, context.siteId),
            eq(invitation.id, context.invitationId),
          ),
        );
      message = {
        id: nextMessageId,
        author_name: current?.author_name ?? context.invitationName,
        invitation_name: current?.invitation_name ?? context.invitationName,
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
      invitationId: context.invitationId,
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
  scope: "mural" | "invitations",
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
        : ["scope", "siteId", "invitationName", "id"];
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
    if (scope === "invitations" && !(record.invitationName as string).trim())
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
  apiRequestUrl = "",
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
    ) &&
    !allowsLocalPublicOrigin(apiRequestUrl, origin)
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

  const conditions = [eq(invitationMessage.siteId, siteId)];
  if (cursor) {
    const createdAt = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(invitationMessage.createdAt, createdAt),
        and(
          eq(invitationMessage.createdAt, createdAt),
          lt(invitationMessage.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const messages = await db
    .select()
    .from(invitationMessage)
    .where(and(...conditions))
    .orderBy(desc(invitationMessage.createdAt), desc(invitationMessage.id))
    .limit(query.limit + 1);
  const page = messages.slice(0, query.limit);
  return publicMuralResponseSchema.parse({
    enabled: true,
    messages: page.map((message) => ({
      id: message.id,
      authorName: message.authorName,
      invitationName: message.invitationName,
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
  const cursor = decodeCursor(query.cursor, siteId, "invitations");
  await adminSiteContext(db, actor, siteId, false, false);
  const conditions = [eq(invitation.siteId, siteId)];
  if (query.invitationId)
    conditions.push(eq(invitation.id, query.invitationId));
  if (cursor) {
    conditions.push(
      or(
        gt(invitation.name, cursor.invitationName),
        and(
          eq(invitation.name, cursor.invitationName),
          gt(invitation.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const rows = await db
    .select({
      invitationId: invitation.id,
      invitationName: invitation.name,
      blocked: invitation.messageBlocked,
      currentRevision: invitation.messageRevision,
      message: invitationMessage,
    })
    .from(invitation)
    .leftJoin(
      invitationMessage,
      and(
        eq(invitationMessage.siteId, invitation.siteId),
        eq(invitationMessage.invitationId, invitation.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(invitation.name), asc(invitation.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return siteMessagesResponseSchema.parse({
    invitations: page.map((row) => ({
      invitationId: row.invitationId,
      invitationName: row.invitationName,
      blocked: row.blocked,
      currentRevision: row.currentRevision,
      message: row.message
        ? messageRecord({
            id: row.message.id,
            author_name: row.message.authorName,
            invitation_name: row.message.invitationName,
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
            scope: "invitations",
            siteId,
            invitationName: page[page.length - 1].invitationName,
            id: page[page.length - 1].invitationId,
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
  invitationId: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = siteMessageBlockInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await adminSiteContext(tx, actor, siteId, true, true);
    const invitationResult = await tx.execute(sql`
      SELECT id, message_blocked FROM invitation
      WHERE site_id = ${siteId} AND id = ${invitationId}
      FOR UPDATE
    `);
    const record = invitationResult.rows[0] as
      | { id: string; message_blocked: boolean }
      | undefined;
    if (!record) reject(404, "NOT_FOUND", "Not Found");
    if (record.message_blocked !== input.blocked) {
      await tx
        .update(invitation)
        .set({ messageBlocked: input.blocked, updatedAt: now })
        .where(
          and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
        );
    }
    return siteMessageBlockResponseSchema.parse({
      invitationId,
      blocked: input.blocked,
    });
  });
}

export async function deleteInvitationMessage(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  invitationId: string,
  inputValue: unknown,
  nowValue?: Date,
) {
  const input = messageDeletionInputSchema.parse(inputValue);
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    await adminSiteContext(tx, actor, siteId, true, true);
    const invitationResult = await tx.execute(sql`
      SELECT id, message_revision FROM invitation
      WHERE site_id = ${siteId} AND id = ${invitationId}
      FOR UPDATE
    `);
    const record = invitationResult.rows[0] as
      | { id: string; message_revision: number }
      | undefined;
    if (!record) reject(404, "MESSAGE_NOT_FOUND", "Message was not found");
    if (record.message_revision !== input.expectedRevision)
      reject(409, "MESSAGE_CONFLICT", "Message revision changed", {
        currentRevision: record.message_revision,
      });
    const messageResult = await tx.execute(sql`
      SELECT id FROM invitation_message
      WHERE site_id = ${siteId} AND invitation_id = ${invitationId}
      FOR UPDATE
    `);
    if (messageResult.rows.length === 0)
      reject(404, "MESSAGE_NOT_FOUND", "Message was not found");
    const nextRevision = record.message_revision + 1;
    await tx
      .update(messageRequestReceipt)
      .set({ result: "REMOVED", responseBody: null, removedAt: now })
      .where(
        and(
          eq(messageRequestReceipt.siteId, siteId),
          eq(messageRequestReceipt.invitationId, invitationId),
        ),
      );
    await tx
      .delete(invitationMessage)
      .where(
        and(
          eq(invitationMessage.siteId, siteId),
          eq(invitationMessage.invitationId, invitationId),
        ),
      );
    await tx
      .update(invitation)
      .set({ messageRevision: nextRevision, updatedAt: now })
      .where(
        and(eq(invitation.siteId, siteId), eq(invitation.id, invitationId)),
      );
    return messageDeletionResponseSchema.parse({
      ok: true,
      currentRevision: nextRevision,
    });
  });
}

export const getMuralConfiguration = readMuralConfiguration;
export const patchMuralConfiguration = updateMuralConfiguration;
export const patchMessageBlock = updateMessageBlock;
export const readSiteMural = readMuralConfiguration;
export const updateSiteMural = updateMuralConfiguration;
export const listMessages = listSiteMessages;
export const deleteMessage = deleteInvitationMessage;
