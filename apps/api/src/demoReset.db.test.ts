import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitation,
  invitationGuest,
  muralMessage,
  site,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_RESET_DATASET_IDS,
  DemoResetServiceError,
  resetDemoSite,
} from "./demoReset";

const prefix = `invitation-demo-reset-${process.pid}-${randomUUID().slice(0, 8)}`;
const demoSiteId = `${prefix}-demo`;
const sentinelSiteId = `${prefix}-sentinel`;
const now = new Date("2028-04-01T12:00:00.000Z");
let connection: DatabaseConnection;

function siteValues(id: string, isDemo: boolean) {
  return {
    id,
    repositorySlug: id,
    provisioningKey: `${id}:key`,
    displayName: isDemo ? "Demo Wedding" : "Sentinel Wedding",
    partnerOneName: "Ana",
    partnerTwoName: "Bia",
    eventDate: "2029-06-10",
    lifecycle: "ACTIVE" as const,
    isDemo,
    createdAt: now,
    updatedAt: now,
  };
}

describe("invitation demo reset PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .insert(site)
      .values([
        siteValues(demoSiteId, true),
        siteValues(sentinelSiteId, false),
      ]);
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.db.delete(site).where(eq(site.id, demoSiteId));
    await connection.db.delete(site).where(eq(site.id, sentinelSiteId));
    await connection.close();
  });

  it("requires an owner and a marked demo site", async () => {
    await expect(
      resetDemoSite(
        connection.db,
        { userId: "admin", role: "SITE_ADMIN" },
        demoSiteId,
      ),
    ).rejects.toBeInstanceOf(DemoResetServiceError);
    await expect(
      resetDemoSite(
        connection.db,
        { userId: "owner", role: "OWNER" },
        sentinelSiteId,
      ),
    ).rejects.toMatchObject({ code: "DEMO_SITE_NOT_FOUND" });
  });

  it("seeds invitation records and preserves another tenant on repeat", async () => {
    const actor = { userId: "owner", role: "OWNER" as const };
    const first = await resetDemoSite(connection.db, actor, demoSiteId, {
      clock: { now: () => now },
    });
    expect(first.counts).toEqual({ invitations: 5, guests: 10, messages: 0 });

    const [invitations, guests, messages, sentinelInvitations] =
      await Promise.all([
        connection.db
          .select()
          .from(invitation)
          .where(eq(invitation.siteId, demoSiteId)),
        connection.db
          .select()
          .from(invitationGuest)
          .where(eq(invitationGuest.siteId, demoSiteId)),
        connection.db
          .select()
          .from(muralMessage)
          .where(eq(muralMessage.siteId, demoSiteId)),
        connection.db
          .select()
          .from(invitation)
          .where(eq(invitation.siteId, sentinelSiteId)),
      ]);
    expect(invitations.map((item) => item.id).sort()).toEqual(
      [...DEMO_RESET_DATASET_IDS.invitationIds].sort(),
    );
    expect(guests.map((guest) => guest.id).sort()).toEqual(
      [...DEMO_RESET_DATASET_IDS.guestIds].sort(),
    );
    expect(guests.some((guest) => guest.guestType === "CHILD")).toBe(true);
    expect(invitations.some((item) => item.phoneE164.startsWith("+1"))).toBe(
      true,
    );
    expect(messages).toHaveLength(0);
    expect(sentinelInvitations).toHaveLength(0);

    await connection.db.insert(muralMessage).values({
      id: randomUUID(),
      siteId: demoSiteId,
      authorName: "Visitante",
      text: "Mensagem de teste",
      createdAt: now,
    });

    const second = await resetDemoSite(connection.db, actor, demoSiteId, {
      clock: { now: () => now },
    });
    expect(second.counts).toEqual(first.counts);
    expect(
      await connection.db
        .select()
        .from(muralMessage)
        .where(eq(muralMessage.siteId, demoSiteId)),
    ).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(invitation)
        .where(eq(invitation.siteId, demoSiteId)),
    ).toHaveLength(5);
  });
});
