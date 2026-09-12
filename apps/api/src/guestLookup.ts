import { createHmac, randomUUID } from "node:crypto";
import {
  type GuestLookupInput,
  guestLookupInputSchema,
} from "@entrelacos/contracts";
import {
  guestGroup,
  guestMember,
  guestRateLimitEvent,
  site,
} from "@entrelacos/database/schema";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { normalizeGuestName } from "./guestGroups";

export const GUEST_LOOKUP_LIMIT = 10;
export const GUEST_LOOKUP_WINDOW_MS = 15 * 60 * 1000;

export type GuestLookupDatabase = NodePgDatabase<Record<string, never>>;

export interface GuestLookupOptions {
  ipAddress: string;
  fingerprintSecret: string;
  now?: Date;
}

export type GuestLookupResult =
  | {
      kind: "MATCH";
      siteId: string;
      groupId: string;
      representativeMemberId: string;
      phoneE164: string;
    }
  | { kind: "FOREIGN_ADMIN_ONLY" }
  | { kind: "NO_MATCH" };

export class GuestLookupServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = "GuestLookupServiceError";
  }
}

function reject(
  status: number,
  code: string,
  title: string,
  retryAfterSeconds?: number,
): never {
  throw new GuestLookupServiceError(status, code, title, retryAfterSeconds);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid lookup time");
  }
  return now;
}

export function fingerprintClientValue(value: string, secret: string): string {
  if (!value.trim() || !secret.trim()) {
    reject(
      503,
      "LOOKUP_CONFIGURATION_ERROR",
      "Lookup service is not configured",
    );
  }
  return createHmac("sha256", secret).update(value).digest("hex");
}

function lookupScope(siteId: string, ipFingerprint: string): string {
  return `${siteId}:${ipFingerprint}`;
}

export async function lookupGuestGroup(
  db: GuestLookupDatabase,
  siteId: string,
  input: unknown,
  options: GuestLookupOptions,
): Promise<GuestLookupResult> {
  const value: GuestLookupInput = guestLookupInputSchema.parse(input);
  const now = currentTime(options.now);
  const ipFingerprint = fingerprintClientValue(
    options.ipAddress,
    options.fingerprintSecret,
  );

  return db.transaction(async (tx) => {
    const [siteRecord] = await tx
      .select({ id: site.id, lifecycle: site.lifecycle })
      .from(site)
      .where(eq(site.id, siteId))
      .limit(1);
    if (!siteRecord) {
      reject(404, "NOT_FOUND", "Not Found");
    }
    if (siteRecord.lifecycle === "INACTIVE") {
      reject(409, "SITE_INACTIVE", "Site is inactive");
    }

    const scopeKey = lookupScope(siteId, ipFingerprint);
    const cutoff = new Date(now.getTime() - GUEST_LOOKUP_WINDOW_MS);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`,
    );

    const recent = await tx
      .select({
        id: guestRateLimitEvent.id,
        occurredAt: guestRateLimitEvent.occurredAt,
      })
      .from(guestRateLimitEvent)
      .where(
        and(
          eq(guestRateLimitEvent.siteId, siteId),
          isNull(guestRateLimitEvent.groupId),
          eq(guestRateLimitEvent.action, "LOOKUP"),
          eq(guestRateLimitEvent.scopeKey, scopeKey),
          eq(guestRateLimitEvent.ipFingerprint, ipFingerprint),
          gt(guestRateLimitEvent.occurredAt, cutoff),
          lte(guestRateLimitEvent.occurredAt, now),
        ),
      )
      .orderBy(asc(guestRateLimitEvent.occurredAt))
      .limit(GUEST_LOOKUP_LIMIT);
    if (recent.length >= GUEST_LOOKUP_LIMIT) {
      const oldest = recent[0]?.occurredAt ?? now;
      reject(
        429,
        "LOOKUP_RATE_LIMITED",
        "Too many lookup attempts",
        Math.max(
          1,
          Math.ceil(
            (oldest.getTime() + GUEST_LOOKUP_WINDOW_MS - now.getTime()) / 1000,
          ),
        ),
      );
    }
    await tx.insert(guestRateLimitEvent).values({
      id: randomUUID(),
      siteId,
      groupId: null,
      action: "LOOKUP",
      scopeKey,
      ipFingerprint,
      phoneFingerprint: null,
      occurredAt: now,
    });

    const normalizedName = normalizeGuestName(value.fullName);
    const [match] = await tx
      .select({
        groupId: guestGroup.id,
        representativeMemberId: guestGroup.representativeMemberId,
        phoneE164: guestGroup.phoneE164,
      })
      .from(guestMember)
      .innerJoin(
        guestGroup,
        and(
          eq(guestGroup.siteId, guestMember.siteId),
          eq(guestGroup.id, guestMember.groupId),
        ),
      )
      .where(
        and(
          eq(guestMember.siteId, siteId),
          eq(guestMember.normalizedName, normalizedName),
          eq(guestGroup.phoneE164, value.phone),
          eq(guestGroup.isForeign, false),
        ),
      )
      .limit(1);
    if (match?.phoneE164) {
      return {
        kind: "MATCH",
        siteId,
        groupId: match.groupId,
        representativeMemberId: match.representativeMemberId,
        phoneE164: match.phoneE164,
      };
    }

    const [foreign] = await tx
      .select({ id: guestGroup.id })
      .from(guestMember)
      .innerJoin(
        guestGroup,
        and(
          eq(guestGroup.siteId, guestMember.siteId),
          eq(guestGroup.id, guestMember.groupId),
        ),
      )
      .where(
        and(
          eq(guestMember.siteId, siteId),
          eq(guestMember.normalizedName, normalizedName),
          eq(guestGroup.isForeign, true),
          isNull(guestGroup.phoneE164),
        ),
      )
      .limit(1);
    if (foreign) return { kind: "FOREIGN_ADMIN_ONLY" };
    return { kind: "NO_MATCH" };
  });
}
