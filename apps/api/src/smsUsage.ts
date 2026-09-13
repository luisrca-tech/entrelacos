import { randomUUID } from "node:crypto";
import {
  smsQuotaInputSchema,
  smsQuotaResponseSchema,
  smsUsageResponseSchema,
} from "@entrelacos/contracts";
import {
  site,
  smsSendReservation,
  smsUsage,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type SmsUsageDatabase = NodePgDatabase<Record<string, never>>;
export type SmsUsageMode = "SIMULATED" | "REAL_SMS";
export type SmsReservationOutcome =
  | "PROVIDER_ACCEPTED"
  | "FAILED_FINAL"
  | "UNKNOWN";
export type SmsUsageAdminActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN";
};

export const SMS_TIMEZONE = "America/Sao_Paulo" as const;

export class SmsUsageServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "SmsUsageServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new SmsUsageServiceError(status, code, title);
}

function currentTime(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (!Number.isFinite(now.getTime()))
    reject(400, "VALIDATION_ERROR", "Invalid SMS usage time");
  return now;
}

function localParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SMS_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const read = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function localMidnightUtc(year: number, month: number): Date {
  const wallClock = Date.UTC(year, month - 1, 1);
  let candidate = new Date(wallClock);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: SMS_TIMEZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    );
    const adjusted = new Date(candidate.getTime() + wallClock - represented);
    if (adjusted.getTime() === candidate.getTime()) return candidate;
    candidate = adjusted;
  }
  return candidate;
}

export function smsPeriod(nowValue?: Date): {
  periodStart: Date;
  periodEnd: Date;
} {
  const now = currentTime(nowValue);
  const { year, month } = localParts(now);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodStart: localMidnightUtc(year, month),
    periodEnd: localMidnightUtc(nextYear, nextMonth),
  };
}

export function smsUsageAlert(
  monthlyLimit: number | null,
  consumed: number,
): "NOT_CONFIGURED" | "BELOW_80" | "AT_OR_ABOVE_80" | "AT_OR_ABOVE_100" {
  if (monthlyLimit === null) return "NOT_CONFIGURED";
  if (monthlyLimit === 0 || consumed >= monthlyLimit) return "AT_OR_ABOVE_100";
  return consumed * 100 >= monthlyLimit * 80 ? "AT_OR_ABOVE_80" : "BELOW_80";
}

type UsageCounters = {
  reserved: number;
  providerAccepted: number;
  failedFinal: number;
  unknown: number;
  consumed: number;
};

function emptyCounters(): UsageCounters {
  return {
    reserved: 0,
    providerAccepted: 0,
    failedFinal: 0,
    unknown: 0,
    consumed: 0,
  };
}

async function requireSiteAccess(
  db: SmsUsageDatabase,
  actor: SmsUsageAdminActor,
  siteId: string,
): Promise<{ id: string; monthlyLimit: number | null }> {
  const access = await db.execute(sql`
    SELECT s.id, s.sms_monthly_limit
    FROM site s
    INNER JOIN "user" u
      ON u.id = ${actor.userId} AND u.state = 'ACTIVE'
    WHERE s.id = ${siteId}
      AND (
        ${actor.role === "OWNER"}
        OR EXISTS (
          SELECT 1 FROM site_membership sm
          WHERE sm.site_id = s.id AND sm.user_id = u.id
        )
      )
    LIMIT 1
  `);
  const row = access.rows[0] as
    | { id: string; sms_monthly_limit: number | null }
    | undefined;
  if (!row) reject(404, "NOT_FOUND", "Not Found");
  return { id: row.id, monthlyLimit: row.sms_monthly_limit };
}

export async function readSmsUsage(
  db: SmsUsageDatabase,
  actor: SmsUsageAdminActor,
  siteId: string,
  nowValue?: Date,
) {
  const current = currentTime(nowValue);
  const period = smsPeriod(current);
  const accessibleSite = await requireSiteAccess(db, actor, siteId);
  const rows = await db
    .select({
      mode: smsUsage.mode,
      reserved: smsUsage.reserved,
      providerAccepted: smsUsage.providerAccepted,
      failedFinal: smsUsage.failedFinal,
      unknown: smsUsage.unknown,
      consumed: smsUsage.consumed,
    })
    .from(smsUsage)
    .where(
      and(
        eq(smsUsage.siteId, siteId),
        eq(smsUsage.periodStart, period.periodStart),
      ),
    );
  const byMode: Record<SmsUsageMode, UsageCounters> = {
    SIMULATED: emptyCounters(),
    REAL_SMS: emptyCounters(),
  };
  for (const { mode, ...counters } of rows) byMode[mode] = counters;
  return smsUsageResponseSchema.parse({
    siteId,
    timezone: SMS_TIMEZONE,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    monthlyLimit: accessibleSite.monthlyLimit,
    alert: smsUsageAlert(accessibleSite.monthlyLimit, byMode.REAL_SMS.consumed),
    realSms: byMode.REAL_SMS,
    simulated: byMode.SIMULATED,
  });
}

export async function updateSmsQuota(
  db: SmsUsageDatabase,
  actor: SmsUsageAdminActor,
  siteId: string,
  input: unknown,
  nowValue?: Date,
) {
  const value = smsQuotaInputSchema.parse(input);
  if (actor.role !== "OWNER") reject(403, "FORBIDDEN", "Forbidden");
  const now = currentTime(nowValue);
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT s.id, s.lifecycle
      FROM site s
      INNER JOIN "user" u
        ON u.id = ${actor.userId} AND u.state = 'ACTIVE'
      WHERE s.id = ${siteId}
      FOR UPDATE OF s
    `);
    const record = result.rows[0] as
      | { id: string; lifecycle: string }
      | undefined;
    if (!record) reject(404, "NOT_FOUND", "Not Found");
    if (record.lifecycle === "INACTIVE")
      reject(409, "SITE_INACTIVE", "Site is inactive");
    await tx
      .update(site)
      .set({ smsMonthlyLimit: value.monthlyLimit, updatedAt: now })
      .where(eq(site.id, siteId));
    return smsQuotaResponseSchema.parse({
      siteId,
      monthlyLimit: value.monthlyLimit,
    });
  });
}

export async function reserveSmsUnit(
  tx: SmsUsageDatabase,
  siteId: string,
  mode: SmsUsageMode,
  reservationId: string,
  nowValue?: Date,
): Promise<string> {
  const now = currentTime(nowValue);
  const period = smsPeriod(now);
  const siteResult = await tx.execute(sql`
    SELECT id, lifecycle, sms_monthly_limit
    FROM site
    WHERE id = ${siteId}
    FOR UPDATE
  `);
  const siteRecord = siteResult.rows[0] as
    | { id: string; lifecycle: string; sms_monthly_limit: number | null }
    | undefined;
  if (!siteRecord) reject(404, "NOT_FOUND", "Not Found");
  if (siteRecord.lifecycle === "INACTIVE")
    reject(409, "SITE_INACTIVE", "Site is inactive");
  if (siteRecord.sms_monthly_limit === null) {
    reject(
      503,
      "SMS_QUOTA_NOT_CONFIGURED",
      "SMS monthly quota is not configured",
    );
  }
  await tx
    .insert(smsUsage)
    .values({
      id: randomUUID(),
      siteId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      mode,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [smsUsage.siteId, smsUsage.periodStart, smsUsage.mode],
    });
  const [usage] = await tx
    .select({ id: smsUsage.id, consumed: smsUsage.consumed })
    .from(smsUsage)
    .where(
      and(
        eq(smsUsage.siteId, siteId),
        eq(smsUsage.periodStart, period.periodStart),
        eq(smsUsage.mode, mode),
      ),
    )
    .limit(1);
  if (!usage) reject(503, "SERVICE_UNAVAILABLE", "Service unavailable");
  if (usage.consumed >= siteRecord.sms_monthly_limit) {
    reject(429, "SMS_QUOTA_EXCEEDED", "SMS monthly quota is exhausted");
  }
  await tx.insert(smsSendReservation).values({
    id: reservationId,
    siteId,
    usageId: usage.id,
    mode,
    status: "RESERVED",
    reservedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await tx
    .update(smsUsage)
    .set({
      reserved: sql`${smsUsage.reserved} + 1`,
      consumed: sql`${smsUsage.consumed} + 1`,
      updatedAt: now,
    })
    .where(eq(smsUsage.id, usage.id));
  return reservationId;
}

export async function completeSmsReservation(
  db: SmsUsageDatabase,
  siteId: string,
  reservationId: string,
  outcome: SmsReservationOutcome,
  metadata: { providerReference?: string; failureCode?: string } = {},
  nowValue?: Date,
): Promise<void> {
  const now = currentTime(nowValue);
  await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, usage_id, status
      FROM sms_send_reservation
      WHERE site_id = ${siteId} AND id = ${reservationId}
      FOR UPDATE
    `);
    const reservation = result.rows[0] as
      | { id: string; usage_id: string; status: string }
      | undefined;
    if (reservation?.status !== "RESERVED") return;
    await tx
      .update(smsSendReservation)
      .set({
        status: outcome,
        providerReference: metadata.providerReference ?? null,
        failureCode: metadata.failureCode ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(smsSendReservation.siteId, siteId),
          eq(smsSendReservation.id, reservationId),
        ),
      );
    const increment =
      outcome === "PROVIDER_ACCEPTED"
        ? { providerAccepted: sql`${smsUsage.providerAccepted} + 1` }
        : outcome === "FAILED_FINAL"
          ? { failedFinal: sql`${smsUsage.failedFinal} + 1` }
          : { unknown: sql`${smsUsage.unknown} + 1` };
    await tx
      .update(smsUsage)
      .set({
        reserved: sql`${smsUsage.reserved} - 1`,
        ...increment,
        updatedAt: now,
      })
      .where(
        and(eq(smsUsage.siteId, siteId), eq(smsUsage.id, reservation.usage_id)),
      );
  });
}
