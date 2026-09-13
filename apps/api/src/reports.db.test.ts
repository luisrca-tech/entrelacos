import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  guestGroup,
  guestMember,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRsvpReport } from "./reports";

const fixturePrefix = `b5-reports-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2029-01-10T12:00:00.000Z");
const ownerId = `${fixturePrefix}-owner`;
const siteAdminId = `${fixturePrefix}-admin`;
let connection: DatabaseConnection;
let siteId = "";
let inactiveSiteId = "";
let foreignSiteId = "";
let groupId = "";
let foreignGroupId = "";

async function insertGroup(
  targetSiteId: string,
  id: string,
  name: string,
  phone: string | null,
  isForeign: boolean,
  members: Array<{
    id: string;
    name: string;
    state: "PENDING" | "CONFIRMED" | "DECLINED";
  }>,
) {
  await connection.db.transaction(async (tx) => {
    await tx.insert(guestGroup).values({
      id,
      siteId: targetSiteId,
      name,
      normalizedName: name.toLocaleLowerCase("pt-BR"),
      isForeign,
      phoneE164: phone,
      representativeMemberId: members[0]?.id ?? `${id}-representative`,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await tx.insert(guestMember).values(
      members.map((member) => ({
        id: member.id,
        siteId: targetSiteId,
        groupId: id,
        fullName: member.name,
        normalizedName: member.name.toLocaleLowerCase("pt-BR"),
        rsvpState: member.state,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      })),
    );
  });
}

describe("RSVP reports PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
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
        id: siteAdminId,
        name: "Report Admin",
        email: `${siteAdminId}@example.test`,
        emailVerified: true,
        role: "SITE_ADMIN",
        state: "ACTIVE",
      },
    ]);

    siteId = randomUUID();
    inactiveSiteId = randomUUID();
    foreignSiteId = randomUUID();
    await connection.db.insert(site).values([
      {
        id: siteId,
        repositorySlug: `${fixturePrefix}-active`,
        provisioningKey: `${fixturePrefix}-active:key`,
        displayName: "Relatório de Ana & João",
        partnerOneName: "Ana",
        partnerTwoName: "João",
        eventDate: "2030-06-10",
        lifecycle: "ACTIVE",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
      {
        id: inactiveSiteId,
        repositorySlug: `${fixturePrefix}-inactive`,
        provisioningKey: `${fixturePrefix}-inactive:key`,
        displayName: "Relatório Inativo",
        partnerOneName: "Ana",
        partnerTwoName: "João",
        eventDate: "2030-06-10",
        lifecycle: "INACTIVE",
        previousLifecycle: "ACTIVE",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
      {
        id: foreignSiteId,
        repositorySlug: `${fixturePrefix}-foreign`,
        provisioningKey: `${fixturePrefix}-foreign:key`,
        displayName: "Outro Site",
        partnerOneName: "Outra",
        partnerTwoName: "Pessoa",
        eventDate: "2030-06-10",
        lifecycle: "ACTIVE",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ]);
    await connection.db.insert(siteMembership).values({
      id: `${fixturePrefix}-membership`,
      siteId,
      userId: siteAdminId,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });

    groupId = `${fixturePrefix}-group-a`;
    await insertGroup(
      siteId,
      groupId,
      "Família Silva",
      "+5511999999999",
      false,
      [
        {
          id: `${fixturePrefix}-member-a`,
          name: "João Silva",
          state: "CONFIRMED",
        },
        {
          id: `${fixturePrefix}-member-b`,
          name: "Lívia Silva",
          state: "PENDING",
        },
      ],
    );
    await insertGroup(
      siteId,
      `${fixturePrefix}-group-b`,
      "Grupo externo",
      null,
      true,
      [{ id: `${fixturePrefix}-member-c`, name: "José 外", state: "DECLINED" }],
    );
    foreignGroupId = `${fixturePrefix}-foreign-group`;
    await insertGroup(
      foreignSiteId,
      foreignGroupId,
      "Tenant externo",
      "+5511988888888",
      false,
      [
        {
          id: `${fixturePrefix}-foreign-member`,
          name: "Não expor",
          state: "CONFIRMED",
        },
      ],
    );
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    if (inactiveSiteId)
      await connection.db.delete(site).where(eq(site.id, inactiveSiteId));
    if (foreignSiteId)
      await connection.db.delete(site).where(eq(site.id, foreignSiteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.db.delete(user).where(eq(user.id, siteAdminId));
    await connection.close();
  });

  it("reads one tenant snapshot with whole-site and selected totals", async () => {
    const report = await readRsvpReport(
      connection.db,
      { userId: ownerId, role: "OWNER" },
      siteId,
      { requestId: randomUUID(), includePhone: true, state: "CONFIRMED" },
      fixedNow,
    );
    expect(report).toMatchObject({
      siteId,
      reportTitle: "Relatório de Ana & João",
      generatedAt: fixedNow.toISOString(),
      timezone: "America/Sao_Paulo",
      stateFilter: "CONFIRMED",
      totals: { pending: 1, confirmed: 1, declined: 1 },
      selectedTotals: { pending: 0, confirmed: 1, declined: 0 },
    });
    expect(report.rows).toEqual([
      {
        groupName: "Família Silva",
        memberName: "João Silva",
        rsvpState: "CONFIRMED",
        representativePhone: "+5511999999999",
      },
    ]);
  });

  it("includes an empty foreign representative phone and can omit all phones", async () => {
    const withPhone = await readRsvpReport(
      connection.db,
      { userId: siteAdminId, role: "SITE_ADMIN" },
      siteId,
      { requestId: randomUUID(), includePhone: true },
      fixedNow,
    );
    expect(withPhone.rows.at(-1)?.representativePhone).toBe("");

    const withoutPhone = await readRsvpReport(
      connection.db,
      { userId: siteAdminId, role: "SITE_ADMIN" },
      siteId,
      { requestId: randomUUID(), includePhone: false },
      fixedNow,
    );
    expect(
      withoutPhone.rows.every(
        (row) => !Object.hasOwn(row, "representativePhone"),
      ),
    ).toBe(true);
  });

  it("allows inactive reads and denies a site admin another tenant", async () => {
    await expect(
      readRsvpReport(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        inactiveSiteId,
        { requestId: randomUUID(), includePhone: false },
        fixedNow,
      ),
    ).resolves.toMatchObject({ siteId: inactiveSiteId, rows: [] });
    await expect(
      readRsvpReport(
        connection.db,
        { userId: siteAdminId, role: "SITE_ADMIN" },
        foreignSiteId,
        { requestId: randomUUID(), includePhone: false },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(
      readRsvpReport(
        connection.db,
        { userId: ownerId, role: "OWNER" },
        siteId,
        {
          requestId: randomUUID(),
          includePhone: false,
          groupId: foreignGroupId,
        },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
