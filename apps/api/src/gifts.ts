import { randomUUID } from "node:crypto";
import {
  calendarDateSchema,
  type GiftCreateInput,
  type GiftItem,
  type GiftUpdateInput,
  giftCatalogLimits,
  type giftCatalogResponseSchema,
  giftCreateInputSchema,
  type giftItemResponseSchema,
  giftItemSchema,
  giftPublishInputSchema,
  giftReorderInputSchema,
  giftUpdateInputSchema,
  type PublicGiftCatalogQuery,
  type PublicGiftItem,
  publicGiftCatalogPageResponseSchema,
  publicGiftCatalogQuerySchema,
  publicGiftItemSchema,
  type ReceivingReadiness,
  receivingReadinessSchema,
  siteAccessSchema,
} from "@entrelacos/contracts";
import {
  giftItem,
  type giftMediaAsset,
  type site,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { readDatabaseTimestamp } from "./databaseTimestamp";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";
import { createDefaultReceivingReadiness } from "./receivingReadiness";
import type { ReceivingTransaction } from "./receivingRepository";
import { requireSiteCapability, type SiteAccessActor } from "./siteAccess";

export type GiftDatabase = NodePgDatabase<Record<string, never>>;
export interface GiftServiceOptions extends LiveSitePolicy {
  applicationEnvironment?: "development" | "test" | "production";
  readReadiness?: (
    siteId: string,
    transaction?: ReceivingTransaction,
  ) => Promise<ReceivingReadiness>;
  now?: () => Date;
}

export class GiftServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "GiftServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new GiftServiceError(status, code, title);
}
function invalid(): never {
  return reject(400, "VALIDATION_ERROR", "Invalid gift request");
}
function notFound(): never {
  return reject(404, "GIFT_NOT_FOUND", "Gift unavailable");
}
function mediaInvalid(): never {
  return reject(400, "GIFT_MEDIA_INVALID", "Gift image unavailable");
}
function receivingNotReady(): never {
  return reject(409, "RECEIVING_NOT_READY", "Receiving is not ready");
}

type GiftRow = typeof giftItem.$inferSelect;
type MediaRow = typeof giftMediaAsset.$inferSelect;
type SiteContext = Pick<
  typeof site.$inferSelect,
  "id" | "lifecycle" | "publicationState" | "isDemo"
> & {
  startsOn: string | null;
  endsOn: string | null;
};

function currentTime(options: GiftServiceOptions): Date {
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  return now;
}

function validIds(siteId: string, giftId?: string): void {
  if (
    !siteAccessSchema.shape.siteId.safeParse(siteId).success ||
    (giftId !== undefined && !giftItemSchema.shape.id.safeParse(giftId).success)
  )
    invalid();
}

async function readReady(
  siteId: string,
  options: GiftServiceOptions,
  transaction?: ReceivingTransaction,
): Promise<ReceivingReadiness> {
  let value: unknown;
  try {
    value = options.readReadiness
      ? await (transaction
          ? options.readReadiness(siteId, transaction)
          : options.readReadiness(siteId))
      : createDefaultReceivingReadiness(siteId);
  } catch {
    receivingNotReady();
  }
  const result = receivingReadinessSchema.safeParse(value);
  if (
    !result.success ||
    result.data.siteId !== siteId ||
    result.data.state !== "READY" ||
    !result.data.catalogEligible ||
    result.data.mode === "disabled"
  )
    receivingNotReady();
  return result.data;
}

async function readSiteContext(
  db: GiftDatabase,
  siteId: string,
): Promise<SiteContext> {
  const result = await db.execute(sql`
    SELECT s.id, s.lifecycle, s.publication_state AS "publicationState", s.is_demo AS "isDemo",
      to_char(t.starts_on, 'YYYY-MM-DD') AS "startsOn",
      to_char(t.ends_on, 'YYYY-MM-DD') AS "endsOn"
    FROM site s LEFT JOIN site_term t ON t.site_id = s.id
    WHERE s.id = ${siteId}
  `);
  const row = result.rows[0] as SiteContext | undefined;
  if (!row || row.id !== siteId) notFound();
  return row;
}

async function lockSite(db: GiftDatabase, siteId: string): Promise<void> {
  const result = await db.execute(
    sql`SELECT id FROM site WHERE id = ${siteId} FOR UPDATE`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.id !== siteId) notFound();
}

function validTerm(context: SiteContext): boolean {
  return (
    calendarDateSchema.safeParse(context.startsOn).success &&
    calendarDateSchema.safeParse(context.endsOn).success &&
    (context.startsOn as string) <= (context.endsOn as string)
  );
}

function weddingDate(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
  }).format(now);
}

function assertMode(
  context: SiteContext,
  readiness: ReceivingReadiness,
  options: GiftServiceOptions,
): void {
  if (
    context.isDemo &&
    readiness.mode === "live" &&
    !allowsLiveSite({
      siteId: context.id,
      isDemo: context.isDemo,
      mode: readiness.mode,
      applicationEnvironment: options.applicationEnvironment ?? "test",
      liveDemoSiteId: options.liveDemoSiteId,
    })
  )
    receivingNotReady();
}

function assertMutationSite(context: SiteContext, now: Date): void {
  if (context.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
  if ((context.startsOn || context.endsOn) && !validTerm(context)) {
    reject(409, "SITE_INELIGIBLE", "Site unavailable");
  }
  if (context.endsOn && context.endsOn < weddingDate(now))
    reject(409, "SITE_EXPIRED", "Site term has expired");
}

function assertPublicSite(context: SiteContext, now: Date): void {
  const day = weddingDate(now);
  if (
    context.lifecycle !== "ACTIVE" ||
    context.publicationState !== "PUBLISHED" ||
    !validTerm(context) ||
    !context.startsOn ||
    !context.endsOn ||
    day < context.startsOn ||
    day > context.endsOn
  ) {
    reject(409, "SITE_INELIGIBLE", "Site unavailable");
  }
}

export async function withGiftCatalogMutation<T>(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  options: GiftServiceOptions,
  operation: (tx: GiftDatabase, now: Date) => Promise<T>,
): Promise<T> {
  validIds(siteId);
  currentTime(options);
  await requireSiteCapability(db, actor, siteId, "manageCatalog");
  await readReady(siteId, options);
  return db.transaction(
    async (transaction) => {
      const tx = transaction as GiftDatabase;
      await lockSite(tx, siteId);
      // A new statement refreshes the joined term after waiting for the site lock.
      const context = await readSiteContext(tx, siteId);
      const now = currentTime(options);
      assertMutationSite(context, now);
      await requireSiteCapability(tx, actor, siteId, "manageCatalog");
      // Refreshing on another connection here would wait on our own site lock.
      const readiness = await readReady(siteId, options, transaction);
      assertMode(context, readiness, options);
      const executionTime = currentTime(options);
      assertMutationSite(context, executionTime);
      return operation(tx, executionTime);
    },
    { isolationLevel: "read committed" },
  );
}

const giftColumns = sql`
  id, site_id AS "siteId", title, description, nominal_cents AS "nominalCents", currency,
  media_asset_id AS "mediaAssetId", alt_text AS "altText", sort_order AS "sortOrder",
  publication_state AS "publicationState", created_at AS "createdAt", updated_at AS "updatedAt"
`;

async function readGiftRows(
  db: GiftDatabase,
  siteId: string,
  scope: "all" | "published" | "current" = "all",
  giftId?: string,
): Promise<GiftRow[]> {
  const filter =
    scope === "published"
      ? sql`AND publication_state = 'PUBLISHED'`
      : scope === "current"
        ? sql`AND publication_state <> 'ARCHIVED'`
        : sql``;
  const result = await db.execute(sql`
    SELECT ${giftColumns} FROM gift_item WHERE site_id = ${siteId}
      ${giftId === undefined ? sql`` : sql`AND id = ${giftId}`} ${filter}
    ORDER BY sort_order, id
  `);
  const rows = result.rows as GiftRow[];
  if (rows.some((row) => row.siteId !== siteId)) notFound();
  try {
    return rows.map((row) => ({
      ...row,
      createdAt: readDatabaseTimestamp(row.createdAt),
      updatedAt: readDatabaseTimestamp(row.updatedAt),
    }));
  } catch {
    reject(503, "SERVICE_UNAVAILABLE", "Gift catalog unavailable");
  }
}

async function getGift(
  db: GiftDatabase,
  siteId: string,
  giftId: string,
): Promise<GiftRow> {
  const [row] = await readGiftRows(db, siteId, "all", giftId);
  if (!row || row.id !== giftId) notFound();
  return row;
}

function giftRecord(row: GiftRow): GiftItem {
  const result = giftItemSchema.safeParse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!result.success)
    reject(503, "SERVICE_UNAVAILABLE", "Gift catalog unavailable");
  return result.data;
}

async function readMedia(
  db: GiftDatabase,
  siteId: string,
  ids: string[],
): Promise<Map<string, MediaRow>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute(sql`
    SELECT id, site_id AS "siteId", staging_key AS "stagingKey", derivative_key AS "derivativeKey",
      stable_object_version AS "stableObjectVersion", state, public_url AS "publicUrl",
      content_type AS "contentType", byte_length AS "byteLength", width, height
    FROM gift_media_asset WHERE site_id = ${siteId} AND id = ANY(${sql.param(ids)}::text[])
  `);
  return new Map((result.rows as MediaRow[]).map((row) => [row.id, row]));
}

function giftImage(
  row: Pick<GiftRow, "siteId" | "mediaAssetId" | "altText">,
  assets: Map<string, MediaRow>,
): PublicGiftItem["image"] {
  if (!row.mediaAssetId) return null;
  const asset = assets.get(row.mediaAssetId);
  if (
    !asset ||
    asset.siteId !== row.siteId ||
    asset.state !== "FINALIZED" ||
    !asset.stableObjectVersion?.trim() ||
    !asset.derivativeKey?.trim() ||
    !asset.stagingKey?.trim() ||
    asset.derivativeKey === asset.stagingKey ||
    !asset.contentType ||
    !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(
      asset.contentType,
    ) ||
    !Number.isSafeInteger(asset.width) ||
    (asset.width as number) <= 0 ||
    !Number.isSafeInteger(asset.height) ||
    (asset.height as number) <= 0 ||
    !Number.isSafeInteger(asset.byteLength) ||
    (asset.byteLength as number) <= 0 ||
    !row.altText.trim()
  )
    mediaInvalid();
  const image = publicGiftItemSchema.shape.image.safeParse({
    url: asset.publicUrl,
    alt: row.altText,
  });
  if (!image.success || !image.data) mediaInvalid();
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(image.data.url).pathname);
  } catch {
    mediaInvalid();
  }
  if (
    pathname === asset.stagingKey ||
    pathname.endsWith(`/${asset.stagingKey}`)
  )
    mediaInvalid();
  return image.data;
}

async function validateMedia(
  db: GiftDatabase,
  siteId: string,
  row: Pick<GiftRow, "mediaAssetId" | "altText">,
): Promise<void> {
  if (!row.mediaAssetId) return;
  const assets = await readMedia(db, siteId, [row.mediaAssetId]);
  giftImage({ ...row, siteId }, assets);
}

async function persistGift(
  tx: GiftDatabase,
  siteId: string,
  giftId: string,
  values: Partial<typeof giftItem.$inferInsert>,
): Promise<GiftRow> {
  const [row] = await tx
    .update(giftItem)
    .set(values)
    .where(and(eq(giftItem.siteId, siteId), eq(giftItem.id, giftId)))
    .returning();
  if (!row) notFound();
  return row;
}

function catalogCount(value: unknown): number {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
  )
    reject(503, "SERVICE_UNAVAILABLE", "Gift catalog unavailable");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    reject(503, "SERVICE_UNAVAILABLE", "Gift catalog unavailable");
  return count;
}

async function assertCatalogCapacity(tx: GiftDatabase, siteId: string) {
  const result = await tx.execute(sql`
    SELECT COUNT(*) AS "activeCount" FROM gift_item
    WHERE site_id = ${siteId} AND publication_state IN ('DRAFT', 'PUBLISHED')
  `);
  const count = catalogCount(result.rows[0]?.activeCount);
  if (count >= giftCatalogLimits.activeItems)
    reject(409, "REQUEST_CONFLICT", "Gift catalog is full");
}

export async function listSiteGifts(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  options: GiftServiceOptions = {},
): Promise<typeof giftCatalogResponseSchema._output> {
  validIds(siteId);
  await requireSiteCapability(db, actor, siteId, "manageCatalog");
  const readiness = await readReady(siteId, options);
  assertMode(await readSiteContext(db, siteId), readiness, options);
  return { gifts: (await readGiftRows(db, siteId)).map(giftRecord) };
}

export async function createSiteGift(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  input: GiftCreateInput,
  options: GiftServiceOptions = {},
): Promise<typeof giftItemResponseSchema._output> {
  const result = giftCreateInputSchema.safeParse(input);
  if (!result.success) invalid();
  return withGiftCatalogMutation(
    db,
    actor,
    siteId,
    options,
    async (tx, now) => {
      await assertCatalogCapacity(tx, siteId);
      await validateMedia(tx, siteId, result.data);
      const order = await tx.execute(sql`
      SELECT COALESCE(MAX(sort_order), -1) AS "maxSortOrder" FROM gift_item
      WHERE site_id = ${siteId} AND publication_state <> 'ARCHIVED'
    `);
      const row: GiftRow = {
        ...result.data,
        id: randomUUID(),
        siteId,
        sortOrder: Number(order.rows[0]?.maxSortOrder ?? -1) + 1,
        publicationState: "DRAFT",
        createdAt: now,
        updatedAt: now,
      };
      const record = giftRecord(row);
      await tx.insert(giftItem).values(row);
      return { gift: record };
    },
  );
}

export async function updateSiteGift(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  giftId: string,
  input: GiftUpdateInput,
  options: GiftServiceOptions = {},
): Promise<typeof giftItemResponseSchema._output> {
  validIds(siteId, giftId);
  const result = giftUpdateInputSchema.safeParse(input);
  if (!result.success) invalid();
  return withGiftCatalogMutation(
    db,
    actor,
    siteId,
    options,
    async (tx, now) => {
      const current = await getGift(tx, siteId, giftId);
      await validateMedia(tx, siteId, { ...current, ...result.data });
      const row = await persistGift(tx, siteId, giftId, {
        ...result.data,
        updatedAt: now,
      });
      return { gift: giftRecord(row) };
    },
  );
}

export async function updateSiteGiftPublication(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  giftId: string,
  input: typeof giftPublishInputSchema._input,
  options: GiftServiceOptions = {},
): Promise<typeof giftItemResponseSchema._output> {
  validIds(siteId, giftId);
  const result = giftPublishInputSchema.safeParse(input);
  if (!result.success) invalid();
  return withGiftCatalogMutation(
    db,
    actor,
    siteId,
    options,
    async (tx, now) => {
      const current = await getGift(tx, siteId, giftId);
      if (
        current.publicationState === "ARCHIVED" &&
        result.data.publicationState !== "ARCHIVED"
      )
        await assertCatalogCapacity(tx, siteId);
      if (result.data.publicationState !== "ARCHIVED")
        await validateMedia(tx, siteId, current);
      const row = await persistGift(tx, siteId, giftId, {
        ...result.data,
        updatedAt: now,
      });
      return { gift: giftRecord(row) };
    },
  );
}

export async function reorderSiteGifts(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  input: typeof giftReorderInputSchema._input,
  options: GiftServiceOptions = {},
): Promise<typeof giftCatalogResponseSchema._output> {
  const result = giftReorderInputSchema.safeParse(input);
  if (!result.success) invalid();
  return withGiftCatalogMutation(
    db,
    actor,
    siteId,
    options,
    async (tx, now) => {
      const rows = await readGiftRows(tx, siteId, "current");
      const ids = new Set(rows.map((row) => row.id));
      if (
        rows.length !== result.data.giftIds.length ||
        result.data.giftIds.some((id) => !ids.has(id))
      ) {
        reject(409, "GIFT_REORDER_CONFLICT", "Gift catalog order has changed");
      }
      for (const [sortOrder, giftId] of result.data.giftIds.entries()) {
        await persistGift(tx, siteId, giftId, { sortOrder, updatedAt: now });
      }
      return { gifts: (await readGiftRows(tx, siteId)).map(giftRecord) };
    },
  );
}

async function publicContext(
  db: GiftDatabase,
  siteId: string,
  options: GiftServiceOptions,
): Promise<ReceivingReadiness> {
  validIds(siteId);
  currentTime(options);
  const readiness = await readReady(siteId, options);
  const context = await readSiteContext(db, siteId);
  assertMode(context, readiness, options);
  assertPublicSite(context, currentTime(options));
  return readiness;
}

function publicRecord(
  row: GiftRow,
  assets: Map<string, MediaRow>,
): PublicGiftItem {
  if (row.publicationState !== "PUBLISHED") notFound();
  const record = giftRecord(row);
  return publicGiftItemSchema.parse({
    id: record.id,
    siteId: record.siteId,
    title: record.title,
    description: record.description,
    nominalCents: record.nominalCents,
    currency: record.currency,
    image: giftImage(row, assets),
    sortOrder: record.sortOrder,
  });
}

export async function readPublicGifts(
  db: GiftDatabase,
  siteId: string,
  options: GiftServiceOptions = {},
  input: typeof publicGiftCatalogQuerySchema._input = {},
): Promise<typeof publicGiftCatalogPageResponseSchema._output> {
  const parsed = publicGiftCatalogQuerySchema.safeParse(input);
  if (!parsed.success) invalid();
  const query: PublicGiftCatalogQuery = parsed.data;
  const readiness = await publicContext(db, siteId, options);
  const snapshot = await db.execute(sql`
    WITH matching AS (
      SELECT ${giftColumns} FROM gift_item
      WHERE site_id = ${siteId} AND publication_state = 'PUBLISHED'
        AND (strpos(lower(title), lower(${query.q})) > 0
          OR strpos(lower(description), lower(${query.q})) > 0)
    ), total AS (SELECT COUNT(*) AS total FROM matching), selected AS (
      SELECT * FROM matching ORDER BY "sortOrder", id COLLATE "C"
      LIMIT ${giftCatalogLimits.pageSize} OFFSET ${giftCatalogLimits.pageSize * (query.page - 1)}
    )
    SELECT total.total, selected.* FROM total LEFT JOIN selected ON TRUE
    ORDER BY selected."sortOrder", selected.id COLLATE "C"
  `);
  const records = snapshot.rows as Array<GiftRow & { total: string | number }>;
  const total = catalogCount(records[0]?.total);
  const unavailable = () =>
    reject(503, "SERVICE_UNAVAILABLE", "Gift catalog unavailable");
  if (records.some((row) => catalogCount(row.total) !== total)) unavailable();
  const rows = records.filter((row) => row.id !== null);
  if (rows.length && rows.length !== records.length) unavailable();
  if (!rows.length && (records.length !== 1 || records[0]?.id !== null))
    unavailable();
  const mediaIds = [
    ...new Set(
      rows.flatMap((row) => (row.mediaAssetId ? [row.mediaAssetId] : [])),
    ),
  ];
  const assets = await readMedia(db, siteId, mediaIds);
  try {
    const gifts = rows.map((row) => {
      if (row.siteId !== siteId || row.publicationState !== "PUBLISHED")
        unavailable();
      readDatabaseTimestamp(row.createdAt);
      readDatabaseTimestamp(row.updatedAt);
      const binding = giftItemSchema.shape.mediaAssetId.safeParse(
        row.mediaAssetId,
      );
      if (!binding.success || binding.data !== row.mediaAssetId)
        return unavailable();
      let image: PublicGiftItem["image"] = null;
      if (row.mediaAssetId) {
        const asset = assets.get(row.mediaAssetId);
        if (
          !asset ||
          asset.siteId !== siteId ||
          asset.state !== "FINALIZED" ||
          !asset.stableObjectVersion?.trim() ||
          !asset.derivativeKey?.trim() ||
          !asset.stagingKey?.trim() ||
          asset.derivativeKey === asset.stagingKey ||
          !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(
            asset.contentType ?? "",
          ) ||
          !Number.isSafeInteger(asset.width) ||
          (asset.width as number) <= 0 ||
          !Number.isSafeInteger(asset.height) ||
          (asset.height as number) <= 0 ||
          !Number.isSafeInteger(asset.byteLength) ||
          (asset.byteLength as number) <= 0
        )
          return unavailable();
        const pathname = decodeURIComponent(
          new URL(asset.publicUrl as string).pathname,
        );
        if (
          pathname === asset.stagingKey ||
          pathname.endsWith(`/${asset.stagingKey}`)
        )
          unavailable();
        image = { url: asset.publicUrl as string, alt: row.altText };
      }
      return {
        id: row.id,
        siteId: row.siteId,
        title: row.title,
        description: row.description,
        nominalCents: row.nominalCents,
        currency: row.currency,
        image,
        sortOrder: row.sortOrder,
      };
    });
    const page = publicGiftCatalogPageResponseSchema.safeParse({
      siteId,
      mode: readiness.mode,
      gifts,
      ...query,
      pageSize: giftCatalogLimits.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / giftCatalogLimits.pageSize)),
      hasNext:
        query.page < Math.max(1, Math.ceil(total / giftCatalogLimits.pageSize)),
    });
    if (!page.success) return unavailable();
    return page.data;
  } catch {
    return unavailable();
  }
}

export async function lookupPublishedGift(
  db: GiftDatabase,
  siteId: string,
  giftId: string,
  options: GiftServiceOptions = {},
): Promise<PublicGiftItem> {
  validIds(siteId, giftId);
  await publicContext(db, siteId, options);
  const [row] = await readGiftRows(db, siteId, "published", giftId);
  if (!row || row.id !== giftId) notFound();
  const assets = await readMedia(
    db,
    siteId,
    row.mediaAssetId ? [row.mediaAssetId] : [],
  );
  return publicRecord(row, assets);
}
