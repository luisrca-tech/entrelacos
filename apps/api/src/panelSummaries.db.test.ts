import { randomUUID } from "node:crypto";
import { invitationGroupStatus } from "@entrelacos/contracts";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  giftItem,
  invitationGuest,
  muralMessage,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSiteAdmins } from "./adminAccess";
import { createInvitation, listInvitationPage } from "./invitations";
import { createDefaultReceivingReadiness } from "./receivingReadiness";
import { resolveSiteAccess } from "./siteAccess";
import { readSiteHomeSummary } from "./siteHomeSummary";
import { listSites } from "./sites";
import { listSiteTeam } from "./siteTeam";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";

const fixture = `panel-${randomUUID()}`;
const siteId = `${fixture}-site`;
const userId = `${fixture}-admin`;
const actor = { userId, role: "SITE_ADMIN" as const };
const connection = createDatabaseConnection({ target: "test" });

describe("panel summary and pagination queries", () => {
  beforeAll(async () => {
    await verifyDatabaseConnection(connection);
    await connection.db.insert(site).values({
      id: siteId,
      repositorySlug: siteId,
      provisioningKey: `${fixture}-key`,
      displayName: "Panel query fixture",
      partnerOneName: "Ana",
      partnerTwoName: "João",
      eventDate: "2027-05-22",
    });
    await connection.db.insert(user).values({
      id: userId,
      name: "Fixture Admin",
      email: `${userId}@example.test`,
      emailVerified: true,
      state: "ACTIVE",
      role: "SITE_ADMIN",
    });
    await connection.db.insert(siteMembership).values({
      id: `${fixture}-member`,
      siteId,
      userId,
      role: "SITE_ADMIN",
    });
    const [first, , mixed] = await Promise.all([
      createInvitation(connection.db, actor, siteId, {
        name: "Família Silva",
        phone: "+5511999990001",
        guests: [{ fullName: "Ana Silva", guestType: "ADULT" }],
      }),
      createInvitation(connection.db, actor, siteId, {
        name: "Familia Silva",
        phone: "+5511999990002",
        guests: [{ fullName: "João Silva", guestType: "ADULT" }],
      }),
      createInvitation(connection.db, actor, siteId, {
        name: "Primos Costa",
        phone: "+5511999990003",
        guests: [
          { fullName: "Bia Costa", guestType: "ADULT" },
          { fullName: "Léo Costa", guestType: "CHILD" },
        ],
      }),
    ]);
    await connection.db
      .update(invitationGuest)
      .set({ rsvpState: "CONFIRMED" })
      .where(eq(invitationGuest.invitationId, first.id));
    await connection.db
      .update(invitationGuest)
      .set({ rsvpState: "DECLINED" })
      .where(
        and(
          eq(invitationGuest.invitationId, mixed.id),
          eq(invitationGuest.guestType, "CHILD"),
        ),
      );
    await connection.db.insert(muralMessage).values({
      id: `${fixture}-message`,
      siteId,
      authorName: "Visitante",
      text: "Parabéns!",
    });
    await connection.db.insert(giftItem).values([
      {
        id: `${fixture}-published`,
        siteId,
        title: "Presente",
        nominalCents: 500,
        publicationState: "PUBLISHED",
      },
      { id: `${fixture}-draft`, siteId, title: "Rascunho", nominalCents: 500 },
    ]);
  });
  afterAll(async () => {
    await connection.db.delete(giftItem).where(eq(giftItem.siteId, siteId));
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, userId));
    await connection.close();
  });

  it("uses the id to break name ties and does not cross sites", async () => {
    const filter = { search: "Família", limit: 1 };
    const first = await listInvitationPage(
      connection.db,
      actor,
      siteId,
      filter,
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = await listInvitationPage(connection.db, actor, siteId, {
      ...filter,
      cursor: first.nextCursor,
    });
    expect(next.nextCursor).toBeNull();
    const ids = [...first.invitations, ...next.invitations].map(
      (invitation) => invitation.id,
    );
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...new Set(ids)].sort());
    expect(
      await listInvitationPage(connection.db, actor, siteId, {
        search: "missing",
      }),
    ).toEqual({ invitations: [], nextCursor: null });
    const confirmed = await listInvitationPage(connection.db, actor, siteId, {
      status: "CONFIRMED",
      guestType: "ADULT",
    });
    expect(
      confirmed.invitations.map((item) => invitationGroupStatus(item.guests)),
    ).toEqual(["CONFIRMED"]);
    expect(
      (
        await listInvitationPage(connection.db, actor, siteId, {
          status: "PARTIAL",
        })
      ).invitations.map((item) => item.name),
    ).toEqual(["Primos Costa"]);
    await expect(
      listInvitationPage(
        connection.db,
        { ...actor, userId: "outsider" },
        siteId,
        filter,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("aggregates the wedding once and keeps its plan explainable", async () => {
    const access = await resolveSiteAccess(connection.db, {
      siteId,
      userId,
      platformRole: actor.role,
    });
    if (!access) throw new Error("Expected fixture membership");
    const statements: Array<{ query: string; params: unknown[] }> = [];
    const logged = drizzle(connection.pool, {
      logger: {
        logQuery: (query, params) => statements.push({ query, params }),
      },
    });
    const summary = await readSiteHomeSummary(logged, access, async (id) =>
      createDefaultReceivingReadiness(id),
    );
    expect(summary).toMatchObject({
      invitations: {
        total: 3,
        confirmed: 1,
        pending: 2,
        declined: 1,
        adults: 3,
        children: 1,
        byStatus: { confirmed: 1, pending: 1, declined: 0, partial: 1 },
      },
      messages: 1,
      publishedGifts: 1,
      peopleWithAccess: 1,
      receiving: { state: "NOT_CONFIGURED" },
    });
    expect(summary).not.toHaveProperty("balance");
    expect(statements).toHaveLength(1);
    await listInvitationPage(logged, actor, siteId, {
      limit: 1,
      status: "CONFIRMED",
    });
    await listSiteAdmins(logged, siteId);
    const ownerPage = await listSites(logged, {
      limit: 1,
      lifecycle: "DRAFT",
      search: siteId,
    });
    expect(ownerPage.sites[0]?.coupleAccess).toEqual({
      people: 1,
      active: true,
      pending: false,
    });
    const team = await listSiteTeam(logged, actor, siteId);
    expect(team.members).toMatchObject([
      { userId, membershipRole: "SITE_ADMIN" },
    ]);
    const withdrawals = await createWithdrawalHistoryRepository(logged, {
      mode: "sandbox",
    }).listWithdrawalPage(siteId, {
      limit: 20,
      cursor: "2026-01-01T00:00:00.000Z~existing",
    });
    expect(withdrawals).toEqual({ withdrawals: [], nextCursor: null });
    expect(statements).toHaveLength(12);
    for (const { query, params } of statements) {
      const plan = await connection.pool.query(
        `EXPLAIN (FORMAT JSON) ${query}`,
        params,
      );
      expect(plan.rows).toHaveLength(1);
    }
  });
});
