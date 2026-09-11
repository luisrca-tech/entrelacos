import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { site, siteMembership, user } from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveReview,
  createDomain,
  createSite,
  deactivateSite,
  editSiteDates,
  getSiteForActor,
  listDomains,
  reactivateSite,
  startReview,
  updateDomain,
  updateSite,
} from "./sites";

const fixturePrefix = `t2s-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
let connection: DatabaseConnection;
const siteIds: string[] = [];
const userIds: string[] = [];

function input(suffix: string) {
  return {
    repositorySlug: `${fixturePrefix}-${suffix}`,
    provisioningKey: `${fixturePrefix}:key-${suffix}`,
    displayName: `Wedding ${suffix}`,
    coupleNames: ["Ana", "João"] as [string, string],
    eventDate: "2029-06-10",
  };
}

async function createFixture(suffix: string) {
  const created = await createSite(connection.db, input(suffix), fixedNow);
  siteIds.push(created.id);
  return created;
}

describe("site lifecycle PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `t2s-${process.pid}-%`));
  });

  afterAll(async () => {
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    for (const userId of userIds) {
      await connection.db.delete(user).where(eq(user.id, userId));
    }
    await connection.close();
  });

  it("creates one site for concurrent retries and rejects key or slug conflicts", async () => {
    const firstInput = input("concurrent");
    const attempts = await Promise.allSettled([
      createSite(connection.db, firstInput, fixedNow),
      createSite(
        connection.db,
        firstInput,
        new Date("2028-03-01T12:00:00.000Z"),
      ),
    ]);
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") siteIds.push(attempt.value.id);
    }
    const [firstAttempt, secondAttempt] = attempts;
    if (firstAttempt.status === "rejected") throw firstAttempt.reason;
    if (secondAttempt.status === "rejected") throw secondAttempt.reason;
    const first = firstAttempt.value;
    const second = secondAttempt.value;
    expect(second).toEqual(first);

    await expect(
      createSite(
        connection.db,
        { ...input("other-key"), repositorySlug: first.repositorySlug },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createSite(
        connection.db,
        { ...input("other-slug"), provisioningKey: first.provisioningKey },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("starts one editable leap-year term and does not reset it on repeated approval", async () => {
    const created = await createFixture("approval");
    const review = await startReview(connection.db, created.id, {}, fixedNow);
    expect(review.lifecycle).toBe("IN_REVIEW");
    const approved = await approveReview(
      connection.db,
      created.id,
      {},
      fixedNow,
    );
    expect(approved).toMatchObject({
      lifecycle: "ACTIVE",
      reviewApprovedAt: "2028-02-29T12:00:00.000Z",
      termStartsOn: "2028-02-29",
      termEndsOn: "2029-02-28",
    });

    const edited = await editSiteDates(
      connection.db,
      created.id,
      { termStartsOn: "2028-03-01", termEndsOn: "2029-03-01" },
      new Date("2028-04-01T12:00:00.000Z"),
    );
    const repeated = await approveReview(
      connection.db,
      created.id,
      {},
      new Date("2029-04-01T12:00:00.000Z"),
    );
    expect(repeated.termStartsOn).toBe(edited.termStartsOn);
    expect(repeated.termEndsOn).toBe(edited.termEndsOn);
    expect(repeated.reviewApprovedAt).toBe(approved.reviewApprovedAt);
  });

  it("deactivates and reactivates without overwriting site data or term", async () => {
    const created = await createFixture("reactivate");
    await startReview(connection.db, created.id, {}, fixedNow);
    await approveReview(connection.db, created.id, {}, fixedNow);
    const configured = await updateSite(
      connection.db,
      created.id,
      {
        displayName: "Edited Wedding",
        publicUrl: "https://edited.example.test/",
        trustedOrigins: ["https://panel.edited.example.test"],
      },
      fixedNow,
    );
    const inactive = await deactivateSite(
      connection.db,
      created.id,
      new Date("2028-03-02T12:00:00.000Z"),
    );
    expect(inactive).toMatchObject({
      lifecycle: "INACTIVE",
      previousLifecycle: "ACTIVE",
    });
    const reactivated = await reactivateSite(
      connection.db,
      created.id,
      new Date("2028-03-03T12:00:00.000Z"),
    );
    expect(reactivated).toMatchObject({
      lifecycle: "ACTIVE",
      previousLifecycle: null,
      displayName: configured.displayName,
      publicUrl: configured.publicUrl,
      trustedOrigins: configured.trustedOrigins,
      termStartsOn: configured.termStartsOn,
      termEndsOn: configured.termEndsOn,
    });
  });

  it("rejects term edits before approval and reversed persisted-term ranges", async () => {
    const draft = await createFixture("date-errors");
    await expect(
      editSiteDates(
        connection.db,
        draft.id,
        { termStartsOn: "2029-01-01" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await startReview(connection.db, draft.id, {}, fixedNow);
    await approveReview(connection.db, draft.id, {}, fixedNow);
    await expect(
      editSiteDates(
        connection.db,
        draft.id,
        { termEndsOn: "2028-01-01" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps site-scoped reads tenant-bound and keeps owner reads global", async () => {
    const first = await createFixture("scope-a");
    const second = await createFixture("scope-b");
    const userId = `${fixturePrefix}-admin`;
    userIds.push(userId);
    await connection.db.insert(user).values({
      id: userId,
      name: "Scoped Admin",
      email: `${userId}@example.test`,
      role: "SITE_ADMIN",
      state: "ACTIVE",
    });
    await connection.db.insert(siteMembership).values({
      id: `${fixturePrefix}-membership`,
      siteId: first.id,
      userId,
    });

    await expect(
      getSiteForActor(connection.db, { userId, role: "SITE_ADMIN" }, second.id),
    ).rejects.toMatchObject({ status: 404 });
    const ownerRead = await getSiteForActor(
      connection.db,
      { userId: "owner", role: "OWNER" },
      second.id,
    );
    expect(ownerRead.id).toBe(second.id);
    expect(ownerRead).not.toHaveProperty("provisioningKey");
  });

  it("rejects cross-site origin/domain collisions and replaces one primary atomically", async () => {
    const first = await createFixture("collisions-a");
    const second = await createFixture("collisions-b");
    await updateSite(
      connection.db,
      first.id,
      { trustedOrigins: ["https://collision.example.test"] },
      fixedNow,
    );
    await expect(
      updateSite(
        connection.db,
        second.id,
        { trustedOrigins: ["https://collision.example.test"] },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const primary = await createDomain(
      connection.db,
      first.id,
      { hostname: "one.collision.example.test", isPrimary: true },
      fixedNow,
    );
    const replacement = await createDomain(
      connection.db,
      first.id,
      { hostname: "two.collision.example.test", isPrimary: true },
      fixedNow,
    );
    expect(primary.isPrimary).toBe(true);
    expect(replacement.isPrimary).toBe(true);
    expect(
      (await listDomains(connection.db, first.id)).filter((d) => d.isPrimary),
    ).toHaveLength(1);
    const verified = await updateDomain(
      connection.db,
      first.id,
      replacement.id,
      { state: "ACTIVE", expiresOn: "2030-01-01" },
      fixedNow,
    );
    expect(verified).toMatchObject({
      state: "ACTIVE",
      verifiedAt: fixedNow.toISOString(),
      expiresOn: "2030-01-01",
    });
    const pending = await updateDomain(
      connection.db,
      first.id,
      replacement.id,
      { state: "PENDING", expiresOn: "2031-01-01" },
      new Date("2028-03-01T12:00:00.000Z"),
    );
    expect(pending).toMatchObject({
      state: "PENDING",
      verifiedAt: null,
      expiresOn: "2031-01-01",
    });
    await expect(
      createDomain(
        connection.db,
        second.id,
        { hostname: "one.collision.example.test" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
