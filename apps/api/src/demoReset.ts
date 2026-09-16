import { createHash } from "node:crypto";
import {
  type DemoResetResponse,
  demoResetInputSchema,
  demoResetResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import {
  familyMessage,
  familySession,
  guestGroup,
  guestMember,
  guestRateLimitEvent,
  guestVerificationChallenge,
  guestVerificationSend,
  messageRequestReceipt,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptGroup,
  site,
  smsSendReservation,
  smsUsage,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { normalizeGuestName } from "./guestGroups";
import { smsPeriod } from "./smsUsage";

export const DEMO_RESET_DATASET_VERSION = "block7-demo-v1" as const;

export type DemoResetDatabase = NodePgDatabase<Record<string, never>>;

export type DemoResetActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN";
};

export interface DemoResetClock {
  now(): Date;
}

export class DemoResetServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "DemoResetServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new DemoResetServiceError(status, code, title);
}

function currentTime(value: Date): Date {
  const now = new Date(value.getTime());
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid demo reset time");
  }
  return now;
}

function at(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() + offsetMs);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticBrazilianPhone(sequence: number): string {
  return ["+55", "11", "9", sequence.toString().padStart(8, "0")].join("");
}

const groups = [
  {
    id: "b7-group-pending",
    name: "Pending Family",
    normalizedName: "pending family",
    isForeign: false,
    phoneE164: syntheticBrazilianPhone(1),
    representativeMemberId: "b7-member-pending-1",
    memberIds: ["b7-member-pending-1", "b7-member-pending-2"],
    memberNames: ["Paula Pending", "Pedro Pending"],
    memberStates: ["PENDING", "PENDING"] as const,
  },
  {
    id: "b7-group-partial",
    name: "Partial Family",
    normalizedName: "partial family",
    isForeign: false,
    phoneE164: syntheticBrazilianPhone(2),
    representativeMemberId: "b7-member-partial-1",
    memberIds: ["b7-member-partial-1", "b7-member-partial-2"],
    memberNames: ["Clara Partial", "Carlos Partial"],
    memberStates: ["PENDING", "CONFIRMED"] as const,
  },
  {
    id: "b7-group-confirmed",
    name: "Confirmed Family",
    normalizedName: "confirmed family",
    isForeign: false,
    phoneE164: syntheticBrazilianPhone(3),
    representativeMemberId: "b7-member-confirmed-1",
    memberIds: ["b7-member-confirmed-1", "b7-member-confirmed-2"],
    memberNames: ["Beatriz Confirmed", "Bruno Confirmed"],
    memberStates: ["CONFIRMED", "CONFIRMED"] as const,
  },
  {
    id: "b7-group-declined",
    name: "Declined Family",
    normalizedName: "declined family",
    isForeign: false,
    phoneE164: syntheticBrazilianPhone(4),
    representativeMemberId: "b7-member-declined-1",
    memberIds: ["b7-member-declined-1", "b7-member-declined-2"],
    memberNames: ["Daniel Declined", "Dora Declined"],
    memberStates: ["DECLINED", "DECLINED"] as const,
  },
  {
    id: "b7-group-foreign",
    name: "Foreign Family",
    normalizedName: "foreign family",
    isForeign: true,
    phoneE164: null,
    representativeMemberId: "b7-member-foreign-1",
    memberIds: ["b7-member-foreign-1", "b7-member-foreign-2"],
    memberNames: ["Elliot Foreign", "Emma Foreign"],
    memberStates: ["PENDING", "CONFIRMED"] as const,
  },
] as const;

const pinSeeds = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));

async function deleteOperationalRows(
  tx: Parameters<Parameters<DemoResetDatabase["transaction"]>[0]>[0],
  siteId: string,
): Promise<void> {
  // Delete dependent rows explicitly so every operation carries the demo-site predicate.
  await tx
    .delete(guestVerificationSend)
    .where(eq(guestVerificationSend.siteId, siteId));
  await tx
    .delete(messageRequestReceipt)
    .where(eq(messageRequestReceipt.siteId, siteId));
  await tx
    .delete(rsvpRequestReceiptGroup)
    .where(eq(rsvpRequestReceiptGroup.siteId, siteId));
  await tx
    .delete(rsvpRequestReceipt)
    .where(eq(rsvpRequestReceipt.siteId, siteId));
  await tx.delete(rsvpHistory).where(eq(rsvpHistory.siteId, siteId));
  await tx.delete(familySession).where(eq(familySession.siteId, siteId));
  await tx.delete(familyMessage).where(eq(familyMessage.siteId, siteId));
  await tx
    .delete(guestVerificationChallenge)
    .where(eq(guestVerificationChallenge.siteId, siteId));
  await tx
    .delete(guestRateLimitEvent)
    .where(eq(guestRateLimitEvent.siteId, siteId));
  await tx
    .delete(smsSendReservation)
    .where(eq(smsSendReservation.siteId, siteId));
  await tx.delete(smsUsage).where(eq(smsUsage.siteId, siteId));
  await tx.delete(guestGroup).where(eq(guestGroup.siteId, siteId));
  // The representative-member FK is RESTRICT; deleting groups first cascades their members.
  await tx.delete(guestMember).where(eq(guestMember.siteId, siteId));
}

async function seedOperationalRows(
  tx: Parameters<Parameters<DemoResetDatabase["transaction"]>[0]>[0],
  siteId: string,
  now: Date,
): Promise<{ groups: number; members: number; messages: number }> {
  await tx.insert(guestGroup).values(
    groups.map((group, index) => ({
      id: group.id,
      siteId,
      name: group.name,
      normalizedName: group.normalizedName,
      isForeign: group.isForeign,
      phoneE164: group.phoneE164,
      representativeMemberId: group.representativeMemberId,
      messageBlocked: false,
      messageRevision: group.id === "b7-group-pending" ? 1 : 0,
      manualPinSeed: pinSeeds[index] ?? "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    })),
  );

  await tx.insert(guestMember).values(
    groups.flatMap((group) =>
      group.memberIds.map((id, index) => ({
        id,
        siteId,
        groupId: group.id,
        fullName: group.memberNames[index] ?? "Block 7 Guest",
        normalizedName: normalizeGuestName(
          group.memberNames[index] ?? "Block 7 Guest",
        ),
        rsvpState: group.memberStates[index] ?? "PENDING",
        rsvpRevision: 0,
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );

  const period = smsPeriod(now);
  const usageId = "b7-sms-usage-simulated";
  await tx.insert(smsUsage).values({
    id: usageId,
    siteId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    mode: "SIMULATED",
    reserved: 0,
    providerAccepted: 1,
    failedFinal: 1,
    unknown: 1,
    consumed: 3,
    createdAt: now,
    updatedAt: now,
  });

  await tx.insert(smsSendReservation).values([
    {
      id: "b7-sms-reservation-accepted",
      siteId,
      usageId,
      mode: "SIMULATED",
      status: "PROVIDER_ACCEPTED",
      reservedAt: at(now, -3_000),
      completedAt: at(now, -2_000),
      createdAt: at(now, -3_000),
      updatedAt: at(now, -2_000),
    },
    {
      id: "b7-sms-reservation-failed",
      siteId,
      usageId,
      mode: "SIMULATED",
      status: "FAILED_FINAL",
      failureCode: "SIMULATED_FINAL_FAILURE",
      reservedAt: at(now, -2_000),
      completedAt: at(now, -1_000),
      createdAt: at(now, -2_000),
      updatedAt: at(now, -1_000),
    },
    {
      id: "b7-sms-reservation-unknown",
      siteId,
      usageId,
      mode: "SIMULATED",
      status: "UNKNOWN",
      failureCode: "SIMULATED_UNKNOWN",
      reservedAt: at(now, -1_000),
      completedAt: now,
      createdAt: at(now, -1_000),
      updatedAt: now,
    },
  ]);

  await tx.insert(guestVerificationChallenge).values([
    {
      id: "b7-challenge-pending",
      siteId,
      groupId: "b7-group-pending",
      mode: "MANUAL",
      status: "PENDING",
      phoneE164: syntheticBrazilianPhone(1),
      expiresAt: at(now, 5 * 60_000),
      resendAvailableAt: at(now, 60_000),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b7-challenge-locked",
      siteId,
      groupId: "b7-group-partial",
      mode: "MANUAL",
      status: "LOCKED",
      phoneE164: syntheticBrazilianPhone(2),
      wrongAttempts: 5,
      cooldownUntil: at(now, 10 * 60_000),
      expiresAt: at(now, 5 * 60_000),
      resendAvailableAt: at(now, 60_000),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b7-challenge-accepted",
      siteId,
      groupId: "b7-group-confirmed",
      mode: "MOCK",
      status: "PENDING",
      phoneE164: syntheticBrazilianPhone(3),
      expiresAt: at(now, 5 * 60_000),
      resendAvailableAt: at(now, 60_000),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b7-challenge-unknown",
      siteId,
      groupId: "b7-group-declined",
      mode: "MOCK",
      status: "PENDING",
      phoneE164: syntheticBrazilianPhone(4),
      expiresAt: at(now, 5 * 60_000),
      resendAvailableAt: at(now, 60_000),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await tx.insert(guestVerificationSend).values([
    {
      id: "b7-send-manual",
      siteId,
      groupId: "b7-group-pending",
      challengeId: "b7-challenge-pending",
      phoneE164: syntheticBrazilianPhone(1),
      status: "MANUAL",
      reservedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b7-send-failed",
      siteId,
      groupId: "b7-group-partial",
      challengeId: "b7-challenge-locked",
      smsReservationId: "b7-sms-reservation-failed",
      phoneE164: syntheticBrazilianPhone(2),
      status: "FAILED_FINAL",
      failureCode: "SIMULATED_FINAL_FAILURE",
      reservedAt: at(now, -2_000),
      completedAt: at(now, -1_000),
      createdAt: at(now, -2_000),
      updatedAt: at(now, -1_000),
    },
    {
      id: "b7-send-accepted",
      siteId,
      groupId: "b7-group-confirmed",
      challengeId: "b7-challenge-accepted",
      smsReservationId: "b7-sms-reservation-accepted",
      phoneE164: syntheticBrazilianPhone(3),
      status: "PROVIDER_ACCEPTED",
      reservedAt: at(now, -3_000),
      completedAt: at(now, -2_000),
      createdAt: at(now, -3_000),
      updatedAt: at(now, -2_000),
    },
    {
      id: "b7-send-unknown",
      siteId,
      groupId: "b7-group-declined",
      challengeId: "b7-challenge-unknown",
      smsReservationId: "b7-sms-reservation-unknown",
      phoneE164: syntheticBrazilianPhone(4),
      status: "UNKNOWN",
      failureCode: "SIMULATED_UNKNOWN",
      reservedAt: at(now, -1_000),
      completedAt: now,
      createdAt: at(now, -1_000),
      updatedAt: now,
    },
  ]);

  await tx.insert(familySession).values({
    id: "b7-family-session",
    siteId,
    groupId: "b7-group-pending",
    tokenHash: "a".repeat(64),
    expiresAt: at(now, 24 * 60 * 60_000),
    createdAt: now,
  });
  await tx.insert(familyMessage).values({
    id: "b7-message",
    siteId,
    groupId: "b7-group-pending",
    authorMemberId: "b7-member-pending-1",
    authorName: "Paula Pending",
    groupName: "Pending Family",
    text: "Que alegria celebrar este momento com vocês!",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(messageRequestReceipt).values({
    id: "b7-message-receipt",
    siteId,
    groupId: "b7-group-pending",
    sessionId: "b7-family-session",
    requestId: "00000000-0000-4000-8000-000000000007",
    requestHash: digest("block7-message"),
    revision: 1,
    result: "APPLIED",
    responseBody: { result: "APPLIED", revision: 1 },
    createdAt: now,
  });
  await tx.insert(rsvpHistory).values({
    id: "b7-rsvp-history",
    siteId,
    groupId: "b7-group-partial",
    memberId: "b7-member-partial-2",
    groupName: "Partial Family",
    memberDisplayName: "Carlos Partial",
    beforeState: "PENDING",
    afterState: "CONFIRMED",
    actorType: "ADMIN",
    actorId: "b7-owner",
    actorDisplayName: "Block 7 Owner",
    occurredAt: now,
  });
  const rsvpRequestId = "00000000-0000-4000-8000-000000000008";
  await tx.insert(rsvpRequestReceipt).values({
    id: "b7-rsvp-receipt",
    siteId,
    groupId: null,
    scope: "ADMIN",
    actorType: "ADMIN",
    actorId: "b7-owner",
    requestId: rsvpRequestId,
    requestHash: digest("block7-rsvp"),
    responseStatus: "APPLIED",
    responseBody: { requestId: rsvpRequestId, result: "APPLIED" },
    createdAt: now,
  });
  await tx.insert(rsvpRequestReceiptGroup).values({
    siteId,
    receiptId: "b7-rsvp-receipt",
    groupId: "b7-group-partial",
  });
  await tx.insert(guestRateLimitEvent).values([
    {
      id: "b7-rate-limit-lookup",
      siteId,
      groupId: "b7-group-pending",
      action: "LOOKUP",
      scopeKey: "block7:lookup",
      ipFingerprint: "b".repeat(64),
      phoneFingerprint: "c".repeat(64),
      occurredAt: at(now, -2_000),
    },
    {
      id: "b7-rate-limit-verify",
      siteId,
      groupId: "b7-group-partial",
      action: "OTP_VERIFY",
      scopeKey: "block7:verify",
      ipFingerprint: "d".repeat(64),
      phoneFingerprint: "e".repeat(64),
      occurredAt: at(now, -1_000),
    },
  ]);

  return { groups: groups.length, members: 10, messages: 1 };
}

export async function resetDemoSite(
  db: DemoResetDatabase,
  actor: DemoResetActor,
  siteIdInput: string,
  options: { clock?: DemoResetClock } = {},
): Promise<DemoResetResponse> {
  if (actor.role !== "OWNER") {
    reject(403, "FORBIDDEN", "Only the owner can reset the demo site");
  }
  const siteId = siteIdSchema.parse(siteIdInput);
  const input = demoResetInputSchema.parse({
    datasetVersion: DEMO_RESET_DATASET_VERSION,
  });

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended('entrelacos:block7:demo-reset:' || ${siteId}, 0)
    )`);
    const lockedSite = await tx.execute(sql`
      SELECT id, is_demo
      FROM "site"
      WHERE id = ${siteId}
      FOR UPDATE
    `);
    const target = lockedSite.rows[0] as
      | { id: string; is_demo: boolean }
      | undefined;
    if (!target?.is_demo) {
      reject(404, "DEMO_SITE_NOT_FOUND", "Demo site was not found");
    }

    const now = currentTime(options.clock?.now() ?? new Date());
    await deleteOperationalRows(tx, siteId);
    await tx
      .update(site)
      .set({
        isDemo: true,
        lifecycle: "ACTIVE",
        previousLifecycle: null,
        publicationState: "PUBLISHED",
        rsvpDeadlineAt: null,
        rsvpDeadlineTimezone: null,
        muralEnabled: false,
        smsMonthlyLimit: null,
        updatedAt: now,
      })
      .where(and(eq(site.id, siteId), eq(site.isDemo, true)));
    const counts = await seedOperationalRows(tx, siteId, now);
    return demoResetResponseSchema.parse({
      siteId,
      datasetVersion: input.datasetVersion,
      result: "RESET",
      resetAt: now.toISOString(),
      counts,
    });
  });
}
