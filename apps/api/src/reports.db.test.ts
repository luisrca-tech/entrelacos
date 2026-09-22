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
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readInvitationReport } from "./reports";

const prefix = `invitation-reports-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2029-01-10T12:00:00.000Z");
const ownerId = `${prefix}-owner`;
const adminId = `${prefix}-admin`;
const siteId = randomUUID();
const foreignSiteId = randomUUID();
let connection: DatabaseConnection;

describe("invitation reports PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db.insert(user).values([
      {
        id: ownerId,
        name: "Report Owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: "OWNER",
        state: "ACTIVE",
      },
      {
        id: adminId,
        name: "Report Admin",
        email: `${adminId}@example.test`,
        emailVerified: true,
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    ]);
    await connection.db.insert(site).values([
      {
        id: siteId,
        repositorySlug: `${prefix}-site`,
        provisioningKey: `${prefix}-site:key`,
        displayName: "Relatório de Ana & João",
        partnerOneName: "Ana",
        partnerTwoName: "João",
        eventDate: "2030-06-10",
        lifecycle: "ACTIVE",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
      {
        id: foreignSiteId,
        repositorySlug: `${prefix}-foreign`,
        provisioningKey: `${prefix}-foreign:key`,
        displayName: "Outro site",
        partnerOneName: "Outra",
        partnerTwoName: "Pessoa",
        eventDate: "2030-06-10",
        lifecycle: "ACTIVE",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ]);
    await connection.db.insert(siteMembership).values({
      id: `${prefix}-membership`,
      siteId,
      userId: adminId,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await connection.db.transaction(async (tx) => {
      await tx.insert(invitation).values([
        {
          id: `${prefix}-one`,
          siteId,
          name: "Família Silva",
          normalizedName: "família silva",
          phoneE164: "+5511999999999",
          email: "silva@example.test",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: `${prefix}-two`,
          siteId,
          name: "Outro convite",
          normalizedName: "outro convite",
          phoneE164: "+5511888888888",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: `${prefix}-foreign-invitation`,
          siteId: foreignSiteId,
          name: "Não expor",
          normalizedName: "não expor",
          phoneE164: "+5511777777777",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ]);
      await tx.insert(invitationGuest).values([
        {
          id: `${prefix}-guest-one`,
          siteId,
          invitationId: `${prefix}-one`,
          fullName: "João Silva",
          normalizedName: "joão silva",
          guestType: "ADULT",
          rsvpState: "CONFIRMED",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: `${prefix}-guest-two`,
          siteId,
          invitationId: `${prefix}-one`,
          fullName: "Lívia Silva",
          normalizedName: "lívia silva",
          guestType: "CHILD",
          rsvpState: "PENDING",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: `${prefix}-guest-three`,
          siteId,
          invitationId: `${prefix}-two`,
          fullName: "José 外",
          normalizedName: "josé 外",
          guestType: "ADULT",
          rsvpState: "DECLINED",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: `${prefix}-foreign-guest`,
          siteId: foreignSiteId,
          invitationId: `${prefix}-foreign-invitation`,
          fullName: "Não expor",
          normalizedName: "não expor",
          guestType: "ADULT",
          rsvpState: "CONFIRMED",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ]);
    });
  });

  afterAll(async () => {
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(site).where(eq(site.id, foreignSiteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.db.delete(user).where(eq(user.id, adminId));
    await connection.close();
  });

  it("returns tenant-scoped totals and only guests matching all filters", async () => {
    const report = await readInvitationReport(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      {
        requestId: randomUUID(),
        search: "familia",
        status: "CONFIRMED",
        guestType: "ADULT",
        includePhone: true,
        includeEmail: true,
      },
      fixedNow,
    );
    expect(report).toMatchObject({
      siteId,
      reportTitle: "Relatório de Ana & João",
      generatedAt: fixedNow.toISOString(),
      totals: {
        invitations: 2,
        guests: 3,
        adults: 2,
        children: 1,
        pending: 1,
        confirmed: 1,
        declined: 1,
      },
      selectedTotals: {
        invitations: 1,
        guests: 1,
        adults: 1,
        children: 0,
        pending: 0,
        confirmed: 1,
        declined: 0,
      },
      rows: [
        {
          invitationName: "Família Silva",
          guestName: "João Silva",
          guestType: "ADULT",
          rsvpState: "CONFIRMED",
          phone: "+5511999999999",
          email: "silva@example.test",
        },
      ],
    });
    expect(report.rows).toHaveLength(1);
  });

  it("omits both contact fields by default", async () => {
    const report = await readInvitationReport(
      connection.db,
      { userId: adminId, role: "SITE_ADMIN" },
      siteId,
      { requestId: randomUUID() },
      fixedNow,
    );
    expect(report.rows).toHaveLength(3);
    expect(
      report.rows.every(
        (row) => !Object.hasOwn(row, "phone") && !Object.hasOwn(row, "email"),
      ),
    ).toBe(true);
  });

  it("denies an admin access to another site", async () => {
    await expect(
      readInvitationReport(
        connection.db,
        { userId: adminId, role: "SITE_ADMIN" },
        foreignSiteId,
        { requestId: randomUUID() },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
