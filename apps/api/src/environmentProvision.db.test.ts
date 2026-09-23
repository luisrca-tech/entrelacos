import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitation,
  invitationGuest,
  site,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SITE_ID, provisionDemoEnvironment } from "./environmentProvision";

const prefix = `invitation-provision-${process.pid}-${randomUUID().slice(0, 8)}`;
const ownerEmail = `${prefix}@example.test`;
const sentinelSiteId = `${prefix}-sentinel`;
const publicUrl = "https://demo-dev.entrelacos.workers.dev/";
const owner = {
  email: ownerEmail,
  name: "Integration Owner",
  password: "integration-owner-password",
};
let connection: DatabaseConnection;

describe("invitation demo provisioning PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.delete(site).where(eq(site.id, DEMO_SITE_ID));
    await connection.db.insert(site).values({
      id: sentinelSiteId,
      repositorySlug: sentinelSiteId,
      provisioningKey: `${sentinelSiteId}:key`,
      displayName: "Sentinel Wedding",
      partnerOneName: "Ana",
      partnerTwoName: "Bia",
      eventDate: "2029-06-10",
      lifecycle: "ACTIVE",
      isDemo: false,
      createdAt: new Date("2028-04-01T12:00:00.000Z"),
      updatedAt: new Date("2028-04-01T12:00:00.000Z"),
    });
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.db.delete(site).where(eq(site.id, DEMO_SITE_ID));
    await connection.db.delete(site).where(eq(site.id, sentinelSiteId));
    await connection.db.delete(user).where(eq(user.email, ownerEmail));
    await connection.close();
  });

  it("provisions canonical invitations once and preserves the dataset on rerun", async () => {
    const input = {
      target: "development" as const,
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      owner,
      publicUrl,
    };
    const first = await provisionDemoEnvironment(connection.db, input);
    expect(first.site).toBe("created");
    expect(first.reset?.counts).toEqual({
      invitations: 5,
      guests: 10,
      messages: 1,
    });
    const seeded = await connection.db
      .select()
      .from(invitation)
      .where(eq(invitation.siteId, DEMO_SITE_ID));
    expect(seeded).toHaveLength(5);

    const second = await provisionDemoEnvironment(connection.db, input);
    expect(second.site).toBe("preserved");
    expect(second.reset).toBeNull();
    expect(
      await connection.db
        .select()
        .from(invitationGuest)
        .where(eq(invitationGuest.siteId, DEMO_SITE_ID)),
    ).toHaveLength(10);
    expect(
      await connection.db
        .select()
        .from(invitation)
        .where(eq(invitation.siteId, sentinelSiteId)),
    ).toHaveLength(0);
  });
});
