import { createHash, randomUUID } from "node:crypto";
import {
  createPublicSiteMessageRequestSchema,
  createPublicSiteMessageResponseSchema,
  messageTextSchema,
  muralConfigurationResponseSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  publicSiteMessageRecordSchema,
  siteMessagesQuerySchema,
  siteMessagesResponseSchema,
} from "@entrelacos/contracts";
import {
  muralMessage,
  muralMessageRateLimitEvent,
  muralMessageRequestReceipt,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
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
    readonly retryAfterSeconds?: number,
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
  retryAfterSeconds?: number,
): never {
  throw new MessagesServiceError(
    status,
    code,
    title,
    details,
    retryAfterSeconds,
  );
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid message time");
  }
  return now;
}

function messageRecord(row: {
  id: string;
  authorName: string;
  text: string;
  createdAt: Date | string;
}) {
  return publicSiteMessageRecordSchema.parse({
    id: row.id,
    authorName: row.authorName,
    text: messageTextSchema.parse(row.text),
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

function requestHash(input: { authorName: string; text: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ authorName: input.authorName, text: input.text }))
    .digest("hex");
}

function searchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

async function lockRequestId(
  db: MessagesDatabase,
  siteId: string,
  requestId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`mural-request:${siteId}:${requestId}`}))`,
  );
}

async function lockPublicationQuota(
  db: MessagesDatabase,
  siteId: string,
  ipFingerprint: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`mural-quota:${siteId}:${ipFingerprint}`}))`,
  );
}

function rateLimit(retryAfterSeconds: number): never {
  reject(
    429,
    "RATE_LIMITED",
    "Too many public messages",
    undefined,
    retryAfterSeconds,
  );
}

export async function createPublicSiteMessage(
  db: MessagesDatabase,
  siteId: string,
  inputValue: unknown,
  ipFingerprint: string,
  nowValue?: Date,
) {
  const input = createPublicSiteMessageRequestSchema.parse(inputValue);
  const now = currentTime(nowValue);
  if (!/^[a-f0-9]{64}$/u.test(ipFingerprint)) {
    reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  }

  return db.transaction(async (tx) => {
    await lockRequestId(tx, siteId, input.requestId);
    const [siteContext] = await tx
      .select({ lifecycle: site.lifecycle, muralEnabled: site.muralEnabled })
      .from(site)
      .where(eq(site.id, siteId))
      .limit(1)
      .for("share");
    if (!siteContext) reject(403, "FORBIDDEN", "Forbidden");
    if (siteContext.lifecycle === "INACTIVE")
      reject(409, "SITE_INACTIVE", "Site is inactive");
    if (!siteContext.muralEnabled)
      reject(409, "MURAL_DISABLED", "The mural is disabled");

    const hash = requestHash(input);
    const [receipt] = await tx
      .select()
      .from(muralMessageRequestReceipt)
      .where(
        and(
          eq(muralMessageRequestReceipt.siteId, siteId),
          eq(muralMessageRequestReceipt.requestId, input.requestId),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== hash)
        reject(409, "MESSAGE_CONFLICT", "This request ID was already used");
      const [message] = await tx
        .select()
        .from(muralMessage)
        .where(
          and(
            eq(muralMessage.siteId, siteId),
            eq(muralMessage.id, receipt.messageId),
          ),
        )
        .limit(1);
      if (!message) reject(410, "MESSAGE_REMOVED", "This message was removed");
      return createPublicSiteMessageResponseSchema.parse({
        requestId: input.requestId,
        acceptedAt: new Date(receipt.acceptedAt).toISOString(),
        replayed: true,
        message: messageRecord(message),
      });
    }

    await lockPublicationQuota(tx, siteId, ipFingerprint);
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
    await tx
      .delete(muralMessageRateLimitEvent)
      .where(lt(muralMessageRateLimitEvent.occurredAt, windowStart));
    const recentEvents = await tx
      .select({ occurredAt: muralMessageRateLimitEvent.occurredAt })
      .from(muralMessageRateLimitEvent)
      .where(
        and(
          eq(muralMessageRateLimitEvent.siteId, siteId),
          eq(muralMessageRateLimitEvent.ipFingerprint, ipFingerprint),
          gt(muralMessageRateLimitEvent.occurredAt, windowStart),
        ),
      )
      .orderBy(asc(muralMessageRateLimitEvent.occurredAt))
      .limit(5);
    if (recentEvents.length >= 5) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (new Date(recentEvents[0].occurredAt).getTime() +
            60 * 60 * 1000 -
            now.getTime()) /
            1000,
        ),
      );
      rateLimit(retryAfterSeconds);
    }

    const messageId = randomUUID();
    const [message] = await tx
      .insert(muralMessage)
      .values({
        id: messageId,
        siteId,
        authorName: input.authorName,
        text: input.text,
        createdAt: now,
      })
      .returning();
    if (!message) reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
    await tx.insert(muralMessageRequestReceipt).values({
      id: randomUUID(),
      siteId,
      requestId: input.requestId,
      requestHash: hash,
      messageId,
      acceptedAt: now,
    });
    await tx.insert(muralMessageRateLimitEvent).values({
      id: randomUUID(),
      siteId,
      ipFingerprint,
      occurredAt: now,
    });

    return createPublicSiteMessageResponseSchema.parse({
      requestId: input.requestId,
      acceptedAt: now.toISOString(),
      replayed: false,
      message: messageRecord(message),
    });
  });
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function decodeCursor(
  value: string | undefined,
  siteId: string,
  search?: string,
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid cursor");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    const hasSearch = Object.hasOwn(record, "search");
    if (
      (keys !== "createdAt,id,scope,siteId" &&
        keys !== "createdAt,id,scope,search,siteId") ||
      (hasSearch &&
        (typeof record.search !== "string" || record.search.length === 0)) ||
      (record.search ?? undefined) !== search ||
      record.scope !== "site-messages" ||
      record.siteId !== siteId ||
      typeof record.id !== "string" ||
      !identifierPattern.test(record.id) ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      new Date(record.createdAt).toISOString() !== record.createdAt
    ) {
      throw new Error("invalid cursor");
    }
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
  const cursor = decodeCursor(query.cursor, siteId);
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
  ) {
    reject(403, "FORBIDDEN", "Forbidden");
  }
  if (siteRow.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
  const conditions = [eq(muralMessage.siteId, siteId)];
  if (cursor) {
    const createdAt = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(muralMessage.createdAt, createdAt),
        and(
          eq(muralMessage.createdAt, createdAt),
          lt(muralMessage.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const messages = await db
    .select()
    .from(muralMessage)
    .where(and(...conditions))
    .orderBy(desc(muralMessage.createdAt), desc(muralMessage.id))
    .limit(query.limit + 1);
  const page = messages.slice(0, query.limit);
  return publicMuralResponseSchema.parse({
    enabled: siteRow.muralEnabled,
    messages: page.map(messageRecord),
    nextCursor:
      messages.length > query.limit && page.length > 0
        ? encodeCursor({
            scope: "site-messages",
            siteId,
            createdAt: page[page.length - 1].createdAt.toISOString(),
            id: page[page.length - 1].id,
          })
        : null,
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

export async function listSiteMessages(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  queryValue: unknown,
) {
  const query = siteMessagesQuerySchema.parse(queryValue);
  const search = query.search ? searchKey(query.search) : "";
  const cursor = decodeCursor(query.cursor, siteId, search || undefined);
  await adminSiteContext(db, actor, siteId, false, false);
  const conditions = [eq(muralMessage.siteId, siteId)];
  if (search) {
    const normalizedAuthor = sql<string>`lower(regexp_replace(normalize(${muralMessage.authorName}, NFD), U&'[\\0300-\\036F]', '', 'g'))`;
    conditions.push(
      sql`${normalizedAuthor} LIKE ${`%${escapeLikePattern(search)}%`} ESCAPE E'\\\\'`,
    );
  }
  if (cursor) {
    conditions.push(
      or(
        lt(muralMessage.createdAt, new Date(cursor.createdAt)),
        and(
          eq(muralMessage.createdAt, new Date(cursor.createdAt)),
          lt(muralMessage.id, cursor.id),
        ),
      ) as (typeof conditions)[number],
    );
  }
  const rows = await db
    .select()
    .from(muralMessage)
    .where(and(...conditions))
    .orderBy(desc(muralMessage.createdAt), desc(muralMessage.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return siteMessagesResponseSchema.parse({
    messages: page.map(messageRecord),
    nextCursor:
      rows.length > query.limit && page.length > 0
        ? encodeCursor({
            scope: "site-messages",
            siteId,
            createdAt: page[page.length - 1].createdAt.toISOString(),
            id: page[page.length - 1].id,
            ...(search ? { search } : {}),
          })
        : null,
  });
}

export async function deleteSiteMessage(
  db: MessagesDatabase,
  actor: MessagesAdminActor,
  siteId: string,
  messageId: string,
) {
  return db.transaction(async (tx) => {
    await adminSiteContext(tx, actor, siteId, false, true);
    const removed = await tx
      .delete(muralMessage)
      .where(
        and(eq(muralMessage.siteId, siteId), eq(muralMessage.id, messageId)),
      )
      .returning({ id: muralMessage.id });
    if (removed.length === 0)
      reject(404, "MESSAGE_NOT_FOUND", "Message not found");
    return { ok: true as const };
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
      siteId: context.id,
      enabled: input.enabled,
    });
  });
}
