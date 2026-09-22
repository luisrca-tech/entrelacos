import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  account,
  familyMessage,
  guestGroup,
  guestMember,
  site,
  siteOrigin,
  user,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SITE_ID, provisionDemoEnvironment } from "./environmentProvision";

const fixturePrefix = `environment-provision-${process.pid}-${randomUUID().slice(0, 8)}`;
const ownerEmail = `${fixturePrefix}@example.test`;
const sentinelSiteId = `${fixturePrefix}-sentinel`;
const sentinelOrigin = `https://${fixturePrefix}.example.test`;
const publicUrl = "https://demo-dev.entrelacos.workers.dev/";
const ownerInput = {
  email: ownerEmail,
  name: "Integration Owner",
  password: "integration-owner-password",
};

let connection: DatabaseConnection;

async function demoSnapshot() {
  const [siteRows, originRows, groupRows, memberRows, messageRows] =
    await Promise.all([
      connection.db
        .select({
          id: site.id,
          repositorySlug: site.repositorySlug,
          provisioningKey: site.provisioningKey,
          displayName: site.displayName,
          partnerOneName: site.partnerOneName,
          partnerTwoName: site.partnerTwoName,
          eventDate: site.eventDate,
          lifecycle: site.lifecycle,
          publicationState: site.publicationState,
          isDemo: site.isDemo,
          publicUrl: site.publicUrl,
          muralEnabled: site.muralEnabled,
        })
        .from(site)
        .where(eq(site.id, DEMO_SITE_ID)),
      connection.db
        .select({ origin: siteOrigin.origin })
        .from(siteOrigin)
        .where(eq(siteOrigin.siteId, DEMO_SITE_ID))
        .orderBy(siteOrigin.origin),
      connection.db
        .select({
          id: guestGroup.id,
          siteId: guestGroup.siteId,
          name: guestGroup.name,
          normalizedName: guestGroup.normalizedName,
          isForeign: guestGroup.isForeign,
          representativeMemberId: guestGroup.representativeMemberId,
          messageBlocked: guestGroup.messageBlocked,
          messageRevision: guestGroup.messageRevision,
          manualPinSeed: guestGroup.manualPinSeed,
        })
        .from(guestGroup)
        .where(eq(guestGroup.siteId, DEMO_SITE_ID))
        .orderBy(guestGroup.id),
      connection.db
        .select({
          id: guestMember.id,
          siteId: guestMember.siteId,
          groupId: guestMember.groupId,
          fullName: guestMember.fullName,
          normalizedName: guestMember.normalizedName,
          rsvpState: guestMember.rsvpState,
          rsvpRevision: guestMember.rsvpRevision,
        })
        .from(guestMember)
        .where(eq(guestMember.siteId, DEMO_SITE_ID))
        .orderBy(guestMember.id),
      connection.db
        .select({
          id: familyMessage.id,
          siteId: familyMessage.siteId,
          groupId: familyMessage.groupId,
          authorMemberId: familyMessage.authorMemberId,
          authorName: familyMessage.authorName,
          groupName: familyMessage.groupName,
          text: familyMessage.text,
          revision: familyMessage.revision,
        })
        .from(familyMessage)
        .where(eq(familyMessage.siteId, DEMO_SITE_ID))
        .orderBy(familyMessage.id),
    ]);

  return {
    site: siteRows,
    origins: originRows,
    groups: groupRows,
    members: memberRows,
    messages: messageRows,
  };
}

async function sentinelSnapshot() {
  const [siteRows, originRows] = await Promise.all([
    connection.db
      .select({
        id: site.id,
        repositorySlug: site.repositorySlug,
        provisioningKey: site.provisioningKey,
        displayName: site.displayName,
        partnerOneName: site.partnerOneName,
        partnerTwoName: site.partnerTwoName,
        eventDate: site.eventDate,
        lifecycle: site.lifecycle,
        publicationState: site.publicationState,
        isDemo: site.isDemo,
        publicUrl: site.publicUrl,
        muralEnabled: site.muralEnabled,
      })
      .from(site)
      .where(eq(site.id, sentinelSiteId)),
    connection.db
      .select({ origin: siteOrigin.origin })
      .from(siteOrigin)
      .where(eq(siteOrigin.siteId, sentinelSiteId)),
  ]);
  return { site: siteRows, origins: originRows };
}

describe("environment demo provisioning PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);

    await connection.db.delete(site).where(eq(site.id, DEMO_SITE_ID));
    await connection.db.delete(user).where(eq(user.email, ownerEmail));
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));

    const now = new Date("2028-04-01T12:00:00.000Z");
    await connection.db.insert(site).values({
      id: sentinelSiteId,
      repositorySlug: `${fixturePrefix}-sentinel`,
      provisioningKey: `${fixturePrefix}:sentinel`,
      displayName: "Sentinel Wedding",
      partnerOneName: "Bia",
      partnerTwoName: "Caio",
      eventDate: "2029-06-10",
      lifecycle: "ACTIVE",
      publicationState: "PUBLISHED",
      isDemo: false,
      publicUrl: `https://${fixturePrefix}.example.test/`,
      muralEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(siteOrigin).values({
      id: `${fixturePrefix}-origin`,
      siteId: sentinelSiteId,
      origin: sentinelOrigin,
      createdAt: now,
    });
  });

  afterAll(async () => {
    await connection.db.delete(site).where(eq(site.id, DEMO_SITE_ID));
    await connection.db.delete(site).where(eq(site.id, sentinelSiteId));
    await connection.db.delete(user).where(eq(user.email, ownerEmail));
    await connection.close();
  });

  it("provisions the demo, preserves an existing rerun, and preserves another tenant", async () => {
    const sentinelBefore = await sentinelSnapshot();

    const first = await provisionDemoEnvironment(connection.db, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      owner: ownerInput,
      publicUrl,
    });
    const firstSnapshot = await demoSnapshot();

    expect(first.owner.created).toBe(true);
    expect(first.owner.userId).toBeTruthy();
    expect(first.siteId).toBe(DEMO_SITE_ID);
    expect(first.reset).toMatchObject({
      siteId: DEMO_SITE_ID,
      datasetVersion: "block7-demo-v1",
      result: "RESET",
      counts: { groups: 5, members: 10, messages: 1 },
    });
    expect(firstSnapshot.site).toMatchObject([
      {
        id: DEMO_SITE_ID,
        repositorySlug: "demo-wedding",
        provisioningKey: "repo:demo-wedding",
        displayName: "Marina & Caio",
        partnerOneName: "Marina",
        partnerTwoName: "Caio",
        eventDate: "2027-09-18",
        lifecycle: "ACTIVE",
        publicationState: "PUBLISHED",
        isDemo: true,
        publicUrl,
        muralEnabled: true,
      },
    ]);
    expect(firstSnapshot.origins).toEqual([
      { origin: "https://demo-dev.entrelacos.workers.dev" },
    ]);
    expect(firstSnapshot.groups).toMatchObject([
      { id: "b7-group-confirmed", name: "Família Confirmada" },
      { id: "b7-group-declined", name: "Família Ausente" },
      { id: "b7-group-foreign", name: "Família Estrangeira" },
      { id: "b7-group-partial", name: "Família Parcial" },
      { id: "b7-group-pending", name: "Família Pendente" },
    ]);
    expect(firstSnapshot.members).toHaveLength(10);
    expect(firstSnapshot.messages).toEqual([
      {
        id: "b7-message",
        siteId: DEMO_SITE_ID,
        groupId: "b7-group-pending",
        authorMemberId: "b7-member-pending-1",
        authorName: "Paula Pending",
        groupName: "Família Pendente",
        text: "Que alegria celebrar este momento com vocês!",
        revision: 1,
      },
    ]);

    const ownerRows = await connection.db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        role: user.role,
        state: user.state,
      })
      .from(user)
      .where(eq(user.email, ownerEmail));
    const accountRows = await connection.db
      .select({ providerId: account.providerId, hasPassword: account.password })
      .from(account)
      .where(eq(account.userId, first.owner.userId));
    expect(ownerRows).toEqual([
      {
        id: first.owner.userId,
        name: "Integration Owner",
        email: ownerEmail,
        emailVerified: true,
        role: "OWNER",
        state: "ACTIVE",
      },
    ]);
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]).toMatchObject({ providerId: "credential" });
    expect(accountRows[0]?.hasPassword).toEqual(expect.any(String));

    await connection.db
      .update(familyMessage)
      .set({ text: "Mensagem preservada do primeiro provisionamento" })
      .where(eq(familyMessage.id, "b7-message"));
    const preservedSnapshot = await demoSnapshot();

    const second = await provisionDemoEnvironment(connection.db, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      owner: ownerInput,
      publicUrl,
    });
    expect(second.owner).toEqual({
      created: false,
      userId: first.owner.userId,
    });
    expect(await demoSnapshot()).toEqual(preservedSnapshot);
    expect(await sentinelSnapshot()).toEqual(sentinelBefore);
  });
});
