import { randomUUID } from "node:crypto";
import { demoGuestGrantResponseSchema } from "@entrelacos/contracts";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { site } from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  issueDemoGuestGrant,
  issueDemoGuestGrantForSite,
  verifyDemoGuestGrant,
} from "./demoGuestGrant";
import { createGuestGroup } from "./guestGroups";
import { createSite } from "./sites";

const fixturePrefix = `t3-demo-grant-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
const secret = "demo-grant-db-secret-with-at-least-32-characters";
const phone = "+5511999999999";
let connection: DatabaseConnection;
const siteIds: string[] = [];

describe("demo guest grants PostgreSQL integration", () => {
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

  it("issues only for demo sites and an approved phone, binding the sentinel site", async () => {
    const demo = await createSite(
      connection.db,
      {
        repositorySlug: `${fixturePrefix}-demo`,
        provisioningKey: `${fixturePrefix}:demo`,
        displayName: "Demo Wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      fixedNow,
    );
    siteIds.push(demo.id);
    await connection.db
      .update(site)
      .set({ isDemo: true })
      .where(eq(site.id, demo.id));
    await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      demo.id,
      {
        name: "Demo Group",
        isForeign: false,
        phone,
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      },
      fixedNow,
    );
    const sentinel = await createSite(
      connection.db,
      {
        repositorySlug: `${fixturePrefix}-sentinel`,
        provisioningKey: `${fixturePrefix}:sentinel`,
        displayName: "Sentinel Wedding",
        coupleNames: ["Bia", "Caio"],
        eventDate: "2029-06-10",
      },
      fixedNow,
    );
    siteIds.push(sentinel.id);

    const issued = await issueDemoGuestGrantForSite(
      connection.db,
      { id: "owner", role: "OWNER" },
      demo.id,
      phone,
      { secret, now: fixedNow, phoneAllowlist: [phone] },
    );
    expect(demoGuestGrantResponseSchema.safeParse(issued).success).toBe(true);
    expect(
      verifyDemoGuestGrant(issued.grant, {
        siteId: demo.id,
        phoneE164: phone,
        secret,
        now: fixedNow,
      }),
    ).toMatchObject({ siteId: demo.id });
    expect(() =>
      verifyDemoGuestGrant(issued.grant, {
        siteId: sentinel.id,
        phoneE164: phone,
        secret,
        now: fixedNow,
      }),
    ).toThrowError("Demo guest grant does not match request");
    await expect(
      issueDemoGuestGrantForSite(
        connection.db,
        { id: "admin", role: "SITE_ADMIN" },
        demo.id,
        phone,
        { secret, now: fixedNow, phoneAllowlist: [phone] },
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      issueDemoGuestGrantForSite(
        connection.db,
        { id: "owner", role: "OWNER" },
        demo.id,
        phone,
        { secret, now: fixedNow, phoneAllowlist: [] },
      ),
    ).rejects.toMatchObject({ status: 403, code: "DEMO_PHONE_NOT_ALLOWED" });
    await expect(
      issueDemoGuestGrantForSite(
        connection.db,
        { id: "owner", role: "OWNER" },
        demo.id,
        phone,
        { secret, now: fixedNow },
      ),
    ).rejects.toMatchObject({ status: 403, code: "DEMO_PHONE_NOT_ALLOWED" });
    await expect(
      issueDemoGuestGrantForSite(
        connection.db,
        { id: "owner", role: "OWNER" },
        sentinel.id,
        phone,
        { secret, now: fixedNow, phoneAllowlist: [phone] },
      ),
    ).rejects.toMatchObject({ status: 403, code: "DEMO_SITE_REQUIRED" });
  });

  it("keeps the grant token free of the phone value", () => {
    const token = issueDemoGuestGrant({
      siteId: "site-sentinel",
      phoneE164: phone,
      secret,
      now: fixedNow,
    });
    expect(token).not.toContain(phone);
  });
});
