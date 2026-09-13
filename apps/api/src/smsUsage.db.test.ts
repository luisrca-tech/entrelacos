import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  site,
  siteMembership,
  smsSendReservation,
  smsUsage,
  user,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeSmsReservation,
  readSmsUsage,
  reserveSmsUnit,
  SmsUsageServiceError,
  updateSmsQuota,
} from "./smsUsage";

const prefix = `b5-sms-${process.pid}-${randomUUID().slice(0, 8)}`;
const ownerId = `${prefix}-owner`;
const adminId = `${prefix}-admin`;
let connection: DatabaseConnection;
let counter = 0;

function now(month = 2): Date {
  return new Date(`2028-${String(month).padStart(2, "0")}-15T12:00:00.000Z`);
}

async function createSiteFixture(
  suffix: string,
  monthlyLimit: number | null,
  lifecycle: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  const id = `${prefix}-${suffix}`;
  await connection.db.insert(site).values({
    id,
    repositorySlug: id,
    provisioningKey: `${id}:key`,
    displayName: `SMS ${suffix}`,
    partnerOneName: "Ana",
    partnerTwoName: "João",
    eventDate: "2029-06-10",
    lifecycle,
    previousLifecycle: lifecycle === "INACTIVE" ? "ACTIVE" : null,
    smsMonthlyLimit: monthlyLimit,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

function reservationId(label: string): string {
  counter += 1;
  return `${prefix}-${label}-${counter}`;
}

async function reserve(
  siteId: string,
  mode: "SIMULATED" | "REAL_SMS",
  at = now(),
) {
  const id = reservationId(mode.toLowerCase());
  await connection.db.transaction((tx) =>
    reserveSmsUnit(tx, siteId, mode, id, at),
  );
  return id;
}

describe("SMS usage PostgreSQL boundary", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    await connection.db.delete(user).where(like(user.id, `${prefix}%`));
    await connection.db.insert(user).values([
      {
        id: ownerId,
        name: "SMS Owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: "OWNER",
        state: "ACTIVE",
      },
      {
        id: adminId,
        name: "SMS Admin",
        email: `${adminId}@example.test`,
        emailVerified: true,
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    ]);
  });

  afterAll(async () => {
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    await connection.db.delete(user).where(like(user.id, `${prefix}%`));
    await connection.close();
  });

  it("enforces missing, zero, lower, and raised limits", async () => {
    const siteId = await createSiteFixture("configuration", null);
    await expect(reserve(siteId, "REAL_SMS")).rejects.toMatchObject({
      status: 503,
      code: "SMS_QUOTA_NOT_CONFIGURED",
    });
    await updateSmsQuota(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { monthlyLimit: 0 },
      now(),
    );
    await expect(reserve(siteId, "REAL_SMS")).rejects.toMatchObject({
      status: 429,
      code: "SMS_QUOTA_EXCEEDED",
    });
    await expect(reserve(siteId, "SIMULATED")).rejects.toMatchObject({
      status: 429,
      code: "SMS_QUOTA_EXCEEDED",
    });
    await updateSmsQuota(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { monthlyLimit: 2 },
      now(),
    );
    await reserve(siteId, "REAL_SMS");
    await reserve(siteId, "REAL_SMS");
    await updateSmsQuota(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { monthlyLimit: 1 },
      now(),
    );
    await expect(reserve(siteId, "REAL_SMS")).rejects.toBeInstanceOf(
      SmsUsageServiceError,
    );
    await updateSmsQuota(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { monthlyLimit: 3 },
      now(),
    );
    await expect(reserve(siteId, "REAL_SMS")).resolves.toBeTypeOf("string");
  });

  it("allows exactly one concurrent reservation to take the final slot", async () => {
    const siteId = await createSiteFixture("concurrency", 1);
    const attempts = await Promise.allSettled([
      reserve(siteId, "REAL_SMS"),
      reserve(siteId, "REAL_SMS"),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { status: 429, code: "SMS_QUOTA_EXCEEDED" },
    });
  });

  it("separates modes, moves every final outcome, and keeps consumed fixed", async () => {
    const siteId = await createSiteFixture("outcomes", 10);
    const accepted = await reserve(siteId, "REAL_SMS");
    const failed = await reserve(siteId, "REAL_SMS");
    const unknown = await reserve(siteId, "REAL_SMS");
    const simulated = await reserve(siteId, "SIMULATED");
    await expect(
      readSmsUsage(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        siteId,
        now(),
      ),
    ).resolves.toMatchObject({
      realSms: { reserved: 3, consumed: 3 },
      simulated: { reserved: 1, consumed: 1 },
    });
    await completeSmsReservation(
      connection.db,
      siteId,
      accepted,
      "PROVIDER_ACCEPTED",
      { providerReference: "accepted-reference" },
      now(),
    );
    await completeSmsReservation(
      connection.db,
      siteId,
      failed,
      "FAILED_FINAL",
      { failureCode: "rejected" },
      now(),
    );
    await completeSmsReservation(
      connection.db,
      siteId,
      unknown,
      "UNKNOWN",
      { failureCode: "network" },
      now(),
    );
    await completeSmsReservation(
      connection.db,
      siteId,
      simulated,
      "PROVIDER_ACCEPTED",
      {},
      now(),
    );
    await completeSmsReservation(
      connection.db,
      siteId,
      accepted,
      "PROVIDER_ACCEPTED",
      {},
      now(),
    );
    const usage = await readSmsUsage(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      now(),
    );
    expect(usage.realSms).toEqual({
      reserved: 0,
      providerAccepted: 1,
      failedFinal: 1,
      unknown: 1,
      consumed: 3,
    });
    expect(usage.simulated).toEqual({
      reserved: 0,
      providerAccepted: 1,
      failedFinal: 0,
      unknown: 0,
      consumed: 1,
    });
    const stored = await connection.db
      .select()
      .from(smsSendReservation)
      .where(eq(smsSendReservation.id, failed));
    expect(stored[0]).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "rejected",
    });
  });

  it("starts a fresh usage record at the Sao Paulo month boundary", async () => {
    const siteId = await createSiteFixture("turnover", 1);
    await reserve(siteId, "REAL_SMS", new Date("2028-03-01T02:59:59.999Z"));
    await reserve(siteId, "REAL_SMS", new Date("2028-03-01T03:00:00.000Z"));
    const rows = await connection.db
      .select({
        periodStart: smsUsage.periodStart,
        consumed: smsUsage.consumed,
      })
      .from(smsUsage)
      .where(eq(smsUsage.siteId, siteId));
    expect(rows).toEqual(
      expect.arrayContaining([
        { periodStart: new Date("2028-02-01T03:00:00.000Z"), consumed: 1 },
        { periodStart: new Date("2028-03-01T03:00:00.000Z"), consumed: 1 },
      ]),
    );
  });

  it("uses real usage for exact alert boundaries", async () => {
    const siteId = await createSiteFixture("alerts", 100);
    await connection.db.insert(smsUsage).values({
      id: reservationId("usage"),
      siteId,
      periodStart: new Date("2028-02-01T03:00:00.000Z"),
      periodEnd: new Date("2028-03-01T03:00:00.000Z"),
      mode: "REAL_SMS",
      reserved: 79,
      consumed: 79,
    });
    const actor = { userId: ownerId, role: "OWNER" as const };
    await expect(
      readSmsUsage(connection.db, actor, siteId, now()),
    ).resolves.toMatchObject({
      alert: "BELOW_80",
    });
    for (const [consumed, alert] of [
      [80, "AT_OR_ABOVE_80"],
      [99, "AT_OR_ABOVE_80"],
      [100, "AT_OR_ABOVE_100"],
    ] as const) {
      await connection.db
        .update(smsUsage)
        .set({ reserved: consumed, consumed })
        .where(eq(smsUsage.siteId, siteId));
      await expect(
        readSmsUsage(connection.db, actor, siteId, now()),
      ).resolves.toMatchObject({ alert });
    }
  });

  it("permits assigned inactive reads while rejecting mutation and hiding tenants", async () => {
    const inactiveSite = await createSiteFixture("inactive", 5, "INACTIVE");
    const otherSite = await createSiteFixture("other", 5);
    await connection.db.insert(siteMembership).values({
      id: `${prefix}-membership`,
      siteId: inactiveSite,
      userId: adminId,
    });
    await expect(
      readSmsUsage(
        connection.db,
        { userId: adminId, role: "SITE_ADMIN" },
        inactiveSite,
        now(),
      ),
    ).resolves.toMatchObject({ siteId: inactiveSite, monthlyLimit: 5 });
    await expect(
      readSmsUsage(
        connection.db,
        { userId: adminId, role: "SITE_ADMIN" },
        otherSite,
        now(),
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(
      updateSmsQuota(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        inactiveSite,
        { monthlyLimit: 6 },
        now(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "SITE_INACTIVE" });
  });
});
