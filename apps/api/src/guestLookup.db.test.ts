import { createHmac, randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { guestRateLimitEvent, site } from "@entrelacos/database/schema";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuestGroup } from "./guestGroups";
import { GuestLookupServiceError, lookupGuestGroup } from "./guestLookup";
import {
  approveReview,
  createSite,
  deactivateSite,
  startReview,
} from "./sites";

const fixturePrefix = `t3-lookup-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
const lookupOptions = {
  ipAddress: "203.0.113.44",
  fingerprintSecret: "lookup-test-secret",
  now: fixedNow,
};
let connection: DatabaseConnection;
const siteIds: string[] = [];

function siteInput(suffix: string) {
  return {
    repositorySlug: `${fixturePrefix}-${suffix}`,
    provisioningKey: `${fixturePrefix}:key-${suffix}`,
    displayName: `Wedding ${suffix}`,
    coupleNames: ["Ana", "João"] as [string, string],
    eventDate: "2029-06-10",
  };
}

async function createFixture(suffix: string) {
  const created = await createSite(connection.db, siteInput(suffix), fixedNow);
  siteIds.push(created.id);
  return created;
}

describe("public guest lookup PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
  });

  afterAll(async () => {
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    await connection.close();
  });

  it("matches exact normalized member names and the registered phone only", async () => {
    const wedding = await createFixture("exact");
    const otherWedding = await createFixture("exact-other");
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      {
        name: "Família Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      fixedNow,
    );
    const otherGroup = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      otherWedding.id,
      {
        name: "Família Silva em outro casamento",
        isForeign: false,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      fixedNow,
    );

    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "  áNA   SILVA ", phone: "(11) 99999-9999" },
        lookupOptions,
      ),
    ).resolves.toEqual({
      kind: "MATCH",
      siteId: wedding.id,
      groupId: group.id,
      representativeMemberId: group.members[0]?.id,
      phoneE164: "+5511999999999",
    });
    await expect(
      lookupGuestGroup(
        connection.db,
        otherWedding.id,
        { fullName: "Ana Silva", phone: "+5511999999999" },
        lookupOptions,
      ),
    ).resolves.toMatchObject({
      kind: "MATCH",
      siteId: otherWedding.id,
      groupId: otherGroup.id,
    });
    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: "+5511999999999" },
        { ...lookupOptions, ipAddress: "203.0.113.51" },
      ),
    ).resolves.toMatchObject({ groupId: group.id });

    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Ana", phone: "+5511999999999" },
        { ...lookupOptions, ipAddress: "203.0.113.45" },
      ),
    ).resolves.toEqual({ kind: "NO_MATCH" });
    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva Junior", phone: "+5511999999999" },
        { ...lookupOptions, ipAddress: "203.0.113.46" },
      ),
    ).resolves.toEqual({ kind: "NO_MATCH" });
    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: "+5511988888888" },
        { ...lookupOptions, ipAddress: "203.0.113.47" },
      ),
    ).resolves.toEqual({ kind: "NO_MATCH" });
  });

  it("returns only an administrative outcome for a foreign group", async () => {
    const wedding = await createFixture("foreign");
    await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      {
        name: "Família Müller",
        isForeign: true,
        phone: null,
        members: [{ fullName: "Alex Müller", isRepresentative: true }],
      },
      fixedNow,
    );

    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Alex Muller", phone: "+5511999999999" },
        { ...lookupOptions, ipAddress: "203.0.113.48" },
      ),
    ).resolves.toEqual({ kind: "FOREIGN_ADMIN_ONLY" });
  });

  it("blocks inactive sites before exposing lookup results", async () => {
    const wedding = await createFixture("inactive");
    await startReview(connection.db, wedding.id, {}, fixedNow);
    await approveReview(connection.db, wedding.id, {}, fixedNow);
    await deactivateSite(
      connection.db,
      wedding.id,
      new Date("2028-03-01T12:00:00.000Z"),
    );

    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Ana Silva", phone: "+5511999999999" },
        lookupOptions,
      ),
    ).rejects.toMatchObject({ status: 409, code: "SITE_INACTIVE" });
  });

  it("enforces ten attempts per site and IP, then opens at the window boundary", async () => {
    const wedding = await createFixture("rate");
    const options = { ...lookupOptions, ipAddress: "203.0.113.49" };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        lookupGuestGroup(
          connection.db,
          wedding.id,
          { fullName: "Unknown Guest", phone: "+5511999999999" },
          options,
        ),
      ).resolves.toEqual({ kind: "NO_MATCH" });
    }
    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Unknown Guest", phone: "+5511999999999" },
        options,
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "LOOKUP_RATE_LIMITED",
      retryAfterSeconds: 900,
    });

    const events = await connection.db
      .select({ ipFingerprint: guestRateLimitEvent.ipFingerprint })
      .from(guestRateLimitEvent)
      .where(
        and(
          eq(guestRateLimitEvent.siteId, wedding.id),
          eq(guestRateLimitEvent.action, "LOOKUP"),
        ),
      );
    expect(events).toHaveLength(10);
    expect(events[0]?.ipFingerprint).toHaveLength(64);
    expect(events[0]?.ipFingerprint).toBe(
      createHmac("sha256", "lookup-test-secret")
        .update("203.0.113.49")
        .digest("hex"),
    );
    expect(events[0]?.ipFingerprint).not.toContain("203.0.113.49");

    await expect(
      lookupGuestGroup(
        connection.db,
        wedding.id,
        { fullName: "Unknown Guest", phone: "+5511999999999" },
        { ...options, now: new Date(fixedNow.getTime() + 15 * 60 * 1000) },
      ),
    ).resolves.toEqual({ kind: "NO_MATCH" });
  });

  it("serializes concurrent attempts so exactly ten are accepted", async () => {
    const wedding = await createFixture("concurrency");
    const options = { ...lookupOptions, ipAddress: "203.0.113.50" };
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        lookupGuestGroup(
          connection.db,
          wedding.id,
          { fullName: "Unknown Guest", phone: "+5511999999999" },
          options,
        ),
      ),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(10);
    expect(rejected).toHaveLength(2);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof GuestLookupServiceError &&
          result.reason.status === 429 &&
          result.reason.code === "LOOKUP_RATE_LIMITED",
      ),
    ).toBe(true);
  });
});
