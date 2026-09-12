import { randomUUID } from "node:crypto";
import {
  type DateEditInput,
  dateEditInputSchema,
  type OwnerSiteCreateInput,
  ownerSiteCreateInputSchema,
  ownerSiteListQuerySchema,
  ownerSiteResumeInputSchema,
  type SiteRecord,
  siteDomainCreateInputSchema,
  siteDomainUpdateInputSchema,
  sitePublicationUpdateInputSchema,
  siteReviewApproveInputSchema,
  siteStartReviewInputSchema,
  siteUpdateInputSchema,
} from "@entrelacos/contracts";
import {
  site,
  siteDomain,
  siteMembership,
  siteOrigin,
  siteTerm,
} from "@entrelacos/database/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type SiteDatabase = NodePgDatabase<Record<string, never>>;
export type SiteRole = "OWNER" | "SITE_ADMIN";

export interface SiteActor {
  userId: string;
  role: SiteRole;
}

export class SiteServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "SiteServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new SiteServiceError(status, code, title);
}

function validationError(): never {
  return reject(400, "VALIDATION_ERROR", "Invalid site request");
}

function notFound(): never {
  return reject(404, "NOT_FOUND", "Not Found");
}

function conflict(code = "CONFLICT"): never {
  return reject(409, code, "Site request conflicts with existing data");
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

function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function nextCalendarYear(value: Date): string {
  const year = value.getUTCFullYear() + 1;
  const month = value.getUTCMonth();
  const day = value.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year.toString().padStart(4, "0")}-${(month + 1)
    .toString()
    .padStart(2, "0")}-${Math.min(day, lastDay).toString().padStart(2, "0")}`;
}

export function defaultTermDates(approvalDate: Date): {
  startsOn: string;
  endsOn: string;
} {
  const now = currentTime(approvalDate);
  return { startsOn: calendarDate(now), endsOn: nextCalendarYear(now) };
}

export interface PersistedTermDates {
  startsOn: string;
  endsOn: string;
}

export function validateDateEditAgainstTerm(
  persisted: PersistedTermDates | undefined,
  input: Pick<DateEditInput, "termStartsOn" | "termEndsOn">,
): PersistedTermDates | undefined {
  const hasStart = Object.hasOwn(input, "termStartsOn");
  const hasEnd = Object.hasOwn(input, "termEndsOn");
  if (!hasStart && !hasEnd) return persisted;
  if (!persisted || input.termStartsOn === null || input.termEndsOn === null) {
    validationError();
  }
  const startsOn = input.termStartsOn ?? persisted.startsOn;
  const endsOn = input.termEndsOn ?? persisted.endsOn;
  if (endsOn < startsOn) validationError();
  return { startsOn, endsOn };
}

type SiteRow = typeof site.$inferSelect;
type SiteTermRow = typeof siteTerm.$inferSelect;

interface SiteBundle {
  row: SiteRow;
  origins: string[];
  term: SiteTermRow | undefined;
}

async function readSiteBundle(
  db: SiteDatabase,
  siteId: string,
): Promise<SiteBundle | undefined> {
  const [row] = await db
    .select()
    .from(site)
    .where(eq(site.id, siteId))
    .limit(1);
  if (!row) return undefined;
  const [origins, terms] = await Promise.all([
    db
      .select({ origin: siteOrigin.origin })
      .from(siteOrigin)
      .where(eq(siteOrigin.siteId, siteId))
      .orderBy(asc(siteOrigin.origin)),
    db.select().from(siteTerm).where(eq(siteTerm.siteId, siteId)).limit(1),
  ]);
  return { row, origins: origins.map((value) => value.origin), term: terms[0] };
}

async function lockSite(
  db: SiteDatabase,
  siteId: string,
): Promise<SiteBundle | undefined> {
  const result = await db.execute(
    sql`SELECT id FROM "site" WHERE id = ${siteId} FOR UPDATE`,
  );
  if (result.rows.length === 0) return undefined;
  return readSiteBundle(db, siteId);
}

function ownerRecord(bundle: SiteBundle): SiteRecord {
  const { row, origins, term } = bundle;
  return {
    id: row.id,
    repositorySlug: row.repositorySlug,
    provisioningKey: row.provisioningKey,
    displayName: row.displayName,
    coupleNames: [row.partnerOneName, row.partnerTwoName],
    eventDate: row.eventDate,
    lifecycle: row.lifecycle,
    previousLifecycle: row.previousLifecycle,
    publicationState: row.publicationState,
    isDemo: row.isDemo,
    publicUrl: row.publicUrl,
    trustedOrigins: origins,
    reviewApprovedAt: row.reviewApprovedAt?.toISOString() ?? null,
    termStartsOn: term?.startsOn ?? null,
    termEndsOn: term?.endsOn ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scopedRecord(bundle: SiteBundle) {
  const record = ownerRecord(bundle);
  return {
    id: record.id,
    displayName: record.displayName,
    coupleNames: record.coupleNames,
    eventDate: record.eventDate,
    lifecycle: record.lifecycle,
    previousLifecycle: record.previousLifecycle,
    publicationState: record.publicationState,
    isDemo: record.isDemo,
    publicUrl: record.publicUrl,
    termStartsOn: record.termStartsOn,
    termEndsOn: record.termEndsOn,
  };
}

function domainRecord(row: typeof siteDomain.$inferSelect) {
  return {
    id: row.id,
    siteId: row.siteId,
    hostname: row.hostname,
    state: row.state,
    isPrimary: row.isPrimary,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresOn: row.expiresOn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findByKey(
  db: SiteDatabase,
  provisioningKey: string,
): Promise<SiteBundle | undefined> {
  const [row] = await db
    .select({ id: site.id })
    .from(site)
    .where(eq(site.provisioningKey, provisioningKey))
    .limit(1);
  return row ? readSiteBundle(db, row.id) : undefined;
}

async function findBySlug(
  db: SiteDatabase,
  repositorySlug: string,
): Promise<SiteBundle | undefined> {
  const [row] = await db
    .select({ id: site.id })
    .from(site)
    .where(eq(site.repositorySlug, repositorySlug))
    .limit(1);
  return row ? readSiteBundle(db, row.id) : undefined;
}

export async function createSite(
  db: SiteDatabase,
  input: OwnerSiteCreateInput,
  now?: Date,
): Promise<SiteRecord> {
  const value = ownerSiteCreateInputSchema.parse(input);
  const createdAt = currentTime(now);
  try {
    return await db.transaction(async (tx) => {
      const existingKey = await findByKey(tx, value.provisioningKey);
      if (existingKey) {
        if (existingKey.row.repositorySlug !== value.repositorySlug)
          conflict("PROVISIONING_KEY_CONFLICT");
        return ownerRecord(existingKey);
      }
      const existingSlug = await findBySlug(tx, value.repositorySlug);
      if (existingSlug) {
        if (existingSlug.row.provisioningKey === value.provisioningKey) {
          return ownerRecord(existingSlug);
        }
        conflict("REPOSITORY_SLUG_CONFLICT");
      }

      const siteId = randomUUID();
      await tx.insert(site).values({
        id: siteId,
        repositorySlug: value.repositorySlug,
        provisioningKey: value.provisioningKey,
        displayName: value.displayName,
        partnerOneName: value.coupleNames[0],
        partnerTwoName: value.coupleNames[1],
        eventDate: value.eventDate,
        lifecycle: "DRAFT",
        publicationState: "UNPUBLISHED",
        createdAt,
        updatedAt: createdAt,
      });
      const created = await readSiteBundle(tx, siteId);
      if (!created) throw new Error("Site insert did not return a site");
      return ownerRecord(created);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existingKey = await findByKey(db, value.provisioningKey);
    if (existingKey) {
      if (existingKey.row.repositorySlug !== value.repositorySlug)
        conflict("PROVISIONING_KEY_CONFLICT");
      return ownerRecord(existingKey);
    }
    if (await findBySlug(db, value.repositorySlug))
      conflict("REPOSITORY_SLUG_CONFLICT");
    conflict();
  }
}

export async function resumeSite(
  db: SiteDatabase,
  provisioningKeyInput: unknown,
): Promise<SiteRecord> {
  const { provisioningKey } =
    ownerSiteResumeInputSchema.parse(provisioningKeyInput);
  return db.transaction(async (tx) => {
    const existing = await findByKey(tx, provisioningKey);
    if (!existing) notFound();
    const locked = await lockSite(tx, existing.row.id);
    if (!locked) notFound();
    return ownerRecord(locked);
  });
}

export async function listSites(
  db: SiteDatabase,
  queryInput: unknown,
): Promise<{ sites: SiteRecord[]; nextCursor: string | null }> {
  const query = ownerSiteListQuerySchema.parse(queryInput);
  const rows = await db
    .select({ id: site.id })
    .from(site)
    .where(query.cursor ? sql`${site.id} > ${query.cursor}` : undefined)
    .orderBy(asc(site.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const records: SiteRecord[] = [];
  for (const row of page) {
    const bundle = await readSiteBundle(db, row.id);
    if (bundle) records.push(ownerRecord(bundle));
  }
  return {
    sites: records,
    nextCursor:
      rows.length > query.limit ? (rows[query.limit]?.id ?? null) : null,
  };
}

export async function getSite(
  db: SiteDatabase,
  siteId: string,
): Promise<SiteRecord> {
  const bundle = await readSiteBundle(db, siteId);
  if (!bundle) notFound();
  return ownerRecord(bundle);
}

export async function getSiteForActor(
  db: SiteDatabase,
  actor: SiteActor,
  siteId: string,
) {
  const [membership] =
    actor.role === "OWNER"
      ? [{ siteId }]
      : await db
          .select({ siteId: siteMembership.siteId })
          .from(siteMembership)
          .where(
            and(
              eq(siteMembership.siteId, siteId),
              eq(siteMembership.userId, actor.userId),
            ),
          )
          .limit(1);
  if (!membership) notFound();
  const bundle = await readSiteBundle(db, siteId);
  if (!bundle) notFound();
  return scopedRecord(bundle);
}

export async function updateSite(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<SiteRecord> {
  const value = siteUpdateInputSchema.parse(input);
  const updatedAt = currentTime(now);
  if (
    value.trustedOrigins &&
    new Set(value.trustedOrigins).size !== value.trustedOrigins.length
  ) {
    validationError();
  }
  try {
    return await db.transaction(async (tx) => {
      const current = await lockSite(tx, siteId);
      if (!current) notFound();
      const updates: Partial<typeof site.$inferInsert> = { updatedAt };
      if (value.displayName !== undefined)
        updates.displayName = value.displayName;
      if (value.coupleNames !== undefined) {
        updates.partnerOneName = value.coupleNames[0];
        updates.partnerTwoName = value.coupleNames[1];
      }
      if (value.eventDate !== undefined) updates.eventDate = value.eventDate;
      if (value.publicUrl !== undefined) updates.publicUrl = value.publicUrl;
      if (value.publicationState !== undefined)
        updates.publicationState = value.publicationState;
      await tx.update(site).set(updates).where(eq(site.id, siteId));

      if (value.trustedOrigins !== undefined) {
        await tx.delete(siteOrigin).where(eq(siteOrigin.siteId, siteId));
        if (value.trustedOrigins.length > 0) {
          await tx.insert(siteOrigin).values(
            value.trustedOrigins.map((origin) => ({
              id: randomUUID(),
              siteId,
              origin,
              createdAt: updatedAt,
            })),
          );
        }
      }
      const result = await readSiteBundle(tx, siteId);
      if (!result) notFound();
      return ownerRecord(result);
    });
  } catch (error) {
    if (isUniqueViolation(error)) conflict("ORIGIN_OR_PUBLIC_URL_CONFLICT");
    throw error;
  }
}

export async function startReview(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<SiteRecord> {
  siteStartReviewInputSchema.parse(input);
  const updatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    if (current.row.lifecycle === "IN_REVIEW") return ownerRecord(current);
    if (current.row.lifecycle !== "DRAFT")
      conflict("INVALID_LIFECYCLE_TRANSITION");
    await tx
      .update(site)
      .set({ lifecycle: "IN_REVIEW", updatedAt })
      .where(eq(site.id, siteId));
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function approveReview(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<SiteRecord> {
  siteReviewApproveInputSchema.parse(input);
  const approvedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    if (current.row.lifecycle === "ACTIVE") return ownerRecord(current);
    if (current.row.lifecycle !== "IN_REVIEW")
      conflict("INVALID_LIFECYCLE_TRANSITION");
    const dates = current.term
      ? { startsOn: current.term.startsOn, endsOn: current.term.endsOn }
      : defaultTermDates(approvedAt);
    if (!current.term) {
      await tx.insert(siteTerm).values({
        id: randomUUID(),
        siteId,
        startsOn: dates.startsOn,
        endsOn: dates.endsOn,
        approvedAt,
        createdAt: approvedAt,
        updatedAt: approvedAt,
      });
    }
    await tx
      .update(site)
      .set({
        lifecycle: "ACTIVE",
        reviewApprovedAt: current.row.reviewApprovedAt ?? approvedAt,
        updatedAt: approvedAt,
      })
      .where(eq(site.id, siteId));
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function updatePublication(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<SiteRecord> {
  const { publicationState } = sitePublicationUpdateInputSchema.parse(input);
  const updatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    await tx
      .update(site)
      .set({ publicationState, updatedAt })
      .where(eq(site.id, siteId));
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function deactivateSite(
  db: SiteDatabase,
  siteId: string,
  now?: Date,
): Promise<SiteRecord> {
  const updatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    if (current.row.lifecycle !== "INACTIVE") {
      await tx
        .update(site)
        .set({
          lifecycle: "INACTIVE",
          previousLifecycle: current.row.lifecycle,
          updatedAt,
        })
        .where(eq(site.id, siteId));
    }
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function reactivateSite(
  db: SiteDatabase,
  siteId: string,
  now?: Date,
): Promise<SiteRecord> {
  const updatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    if (current.row.lifecycle === "INACTIVE") {
      if (!current.row.previousLifecycle) conflict("INVALID_LIFECYCLE_STATE");
      await tx
        .update(site)
        .set({
          lifecycle: current.row.previousLifecycle,
          previousLifecycle: null,
          updatedAt,
        })
        .where(eq(site.id, siteId));
    }
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function editSiteDates(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
): Promise<SiteRecord> {
  const value = dateEditInputSchema.parse(input);
  const updatedAt = currentTime(now);
  return db.transaction(async (tx) => {
    const current = await lockSite(tx, siteId);
    if (!current) notFound();
    const dates = validateDateEditAgainstTerm(current.term, value);
    if (value.eventDate !== undefined) {
      await tx
        .update(site)
        .set({ eventDate: value.eventDate, updatedAt })
        .where(eq(site.id, siteId));
    }
    if (
      dates &&
      (Object.hasOwn(value, "termStartsOn") ||
        Object.hasOwn(value, "termEndsOn"))
    ) {
      await tx
        .update(siteTerm)
        .set({ startsOn: dates.startsOn, endsOn: dates.endsOn, updatedAt })
        .where(eq(siteTerm.siteId, siteId));
    }
    const result = await readSiteBundle(tx, siteId);
    if (!result) notFound();
    return ownerRecord(result);
  });
}

export async function createDomain(
  db: SiteDatabase,
  siteId: string,
  input: unknown,
  now?: Date,
) {
  const value = siteDomainCreateInputSchema.parse(input);
  const createdAt = currentTime(now);
  try {
    return await db.transaction(async (tx) => {
      const current = await lockSite(tx, siteId);
      if (!current) notFound();
      if (value.isPrimary) {
        await tx
          .update(siteDomain)
          .set({ isPrimary: false, updatedAt: createdAt })
          .where(eq(siteDomain.siteId, siteId));
      }
      const id = randomUUID();
      await tx.insert(siteDomain).values({
        id,
        siteId,
        hostname: value.hostname,
        isPrimary: value.isPrimary,
        state: "NONE",
        verifiedAt: null,
        expiresOn: value.expiresOn ?? null,
        createdAt,
        updatedAt: createdAt,
      });
      const [created] = await tx
        .select()
        .from(siteDomain)
        .where(eq(siteDomain.id, id))
        .limit(1);
      if (!created) throw new Error("Domain insert did not return a domain");
      return domainRecord(created);
    });
  } catch (error) {
    if (isUniqueViolation(error)) conflict("DOMAIN_CONFLICT");
    throw error;
  }
}

export async function listDomains(db: SiteDatabase, siteId: string) {
  const bundle = await readSiteBundle(db, siteId);
  if (!bundle) notFound();
  const rows = await db
    .select()
    .from(siteDomain)
    .where(eq(siteDomain.siteId, siteId))
    .orderBy(asc(siteDomain.hostname));
  return rows.map(domainRecord);
}

export async function updateDomain(
  db: SiteDatabase,
  siteId: string,
  domainId: string,
  input: unknown,
  now?: Date,
) {
  const value = siteDomainUpdateInputSchema.parse(input);
  const updatedAt = currentTime(now);
  try {
    return await db.transaction(async (tx) => {
      const current = await lockSite(tx, siteId);
      if (!current) notFound();
      const [domain] = await tx
        .select()
        .from(siteDomain)
        .where(and(eq(siteDomain.id, domainId), eq(siteDomain.siteId, siteId)))
        .limit(1);
      if (!domain) notFound();
      if (value.isPrimary === true) {
        await tx
          .update(siteDomain)
          .set({ isPrimary: false, updatedAt })
          .where(eq(siteDomain.siteId, siteId));
      }
      const updates: Partial<typeof siteDomain.$inferInsert> = { updatedAt };
      if (value.isPrimary !== undefined) updates.isPrimary = value.isPrimary;
      if (value.expiresOn !== undefined) updates.expiresOn = value.expiresOn;
      if (value.state !== undefined) {
        updates.state = value.state;
        updates.verifiedAt = value.state === "ACTIVE" ? updatedAt : null;
      }
      await tx
        .update(siteDomain)
        .set(updates)
        .where(eq(siteDomain.id, domainId));
      const [result] = await tx
        .select()
        .from(siteDomain)
        .where(eq(siteDomain.id, domainId))
        .limit(1);
      if (!result) notFound();
      return domainRecord(result);
    });
  } catch (error) {
    if (isUniqueViolation(error)) conflict("DOMAIN_CONFLICT");
    throw error;
  }
}
