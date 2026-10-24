import { siteAccessSchema } from "@entrelacos/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  getAdministrativeMemberships,
  requireSiteCapability,
  resolveSiteAccess,
  SiteAccessDeniedError,
} from "./siteAccess";

const actor = { userId: "user-1", role: "SITE_ADMIN" as const };
const input = {
  userId: actor.userId,
  platformRole: actor.role,
  siteId: "site-1",
};
const membership = {
  user_id: actor.userId,
  account_role: actor.role,
  account_state: "ACTIVE",
  site_id: input.siteId,
  membership_id: "membership-1",
  membership_user_id: actor.userId,
  membership_role: "SITE_ADMIN",
  revoked_at: null,
};

function database(rows: unknown[] = [membership]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { db: { execute } as never, execute };
}

describe("fresh site access", () => {
  it("derives administrator capabilities from the exact stored membership", async () => {
    const { db } = database();
    const access = await resolveSiteAccess(db, input);

    expect(access).toEqual({
      siteId: input.siteId,
      userId: actor.userId,
      membershipId: membership.membership_id,
      membershipRole: "SITE_ADMIN",
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: true,
        readFinance: true,
        configureReceiving: true,
        requestWithdrawal: false,
      },
    });
    expect(siteAccessSchema.safeParse(access).success).toBe(true);
  });

  it.each(["SITE_ADMIN", "SITE_ASSISTANT"] as const)(
    "uses assistant permissions for a %s account assigned as assistant",
    async (platformRole) => {
      const { db } = database([
        {
          ...membership,
          account_role: platformRole,
          membership_role: "SITE_ASSISTANT",
        },
      ]);
      const access = await resolveSiteAccess(db, { ...input, platformRole });

      expect(access).toMatchObject({
        membershipRole: "SITE_ASSISTANT",
        capabilities: {
          manageInvitations: true,
          manageMessages: true,
          manageCatalog: true,
          manageTeam: false,
          readFinance: false,
          configureReceiving: false,
          requestWithdrawal: false,
        },
      });
    },
  );

  it("allows OWNER support and financial consultation without membership or recipient authority", async () => {
    const { db } = database([
      {
        ...membership,
        account_role: "OWNER",
        membership_id: null,
        membership_user_id: null,
        membership_role: null,
      },
    ]);

    await expect(
      resolveSiteAccess(db, { ...input, platformRole: "OWNER" }),
    ).resolves.toEqual({
      siteId: input.siteId,
      userId: actor.userId,
      membershipId: null,
      membershipRole: "OWNER",
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: true,
        readFinance: true,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    });
  });

  it.each([
    ["pending account", { account_state: "PENDING" }],
    ["disabled account", { account_state: "DISABLED" }],
    ["wrong global role", { account_role: "SITE_ASSISTANT" }],
    ["different account", { user_id: "other-user" }],
    ["different wedding", { site_id: "other-site" }],
    ["different membership account", { membership_user_id: "other-user" }],
    [
      "revoked membership",
      { revoked_at: new Date("2026-10-12T12:00:00.000Z") },
    ],
    ["missing membership", { membership_id: null }],
    ["unknown membership role", { membership_role: "OWNER" }],
  ])("denies %s", async (_label, changes) => {
    const { db } = database([{ ...membership, ...changes }]);
    await expect(resolveSiteAccess(db, input)).resolves.toBeNull();
  });

  it("denies missing accounts, weddings and memberships without fallback", async () => {
    const { db } = database([]);
    await expect(resolveSiteAccess(db, input)).resolves.toBeNull();
  });

  it.each([
    { userId: "" },
    { siteId: "../other" },
    { platformRole: "SUPER_ADMIN" },
  ])("rejects invalid identity input before querying", async (changes) => {
    const { db, execute } = database();
    await expect(
      resolveSiteAccess(db, { ...input, ...changes } as never),
    ).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("queries active account and exact non-revoked membership with bound parameters", async () => {
    const { db, execute } = database();
    await resolveSiteAccess(db, input);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);

    expect(query.params).toContain(actor.userId);
    expect(query.params).toContain(actor.role);
    expect(query.params).toContain(input.siteId);
    expect(query.sql).toMatch(/sm\.user_id\s*=\s*u\.id/);
    expect(query.sql).toMatch(/sm\.site_id\s*=\s*s\.id/);
    expect(query.sql).toMatch(/sm\.revoked_at\s+IS NULL/i);
    expect(query.sql).toMatch(/u\.state\s*=\s*'ACTIVE'/);
    expect(query.sql).toMatch(/u\.role\s*=\s*\$\d+/);
    expect(query.sql).not.toContain(actor.userId);
  });

  it("rechecks revocation on every call instead of caching access", async () => {
    const { db, execute } = database();
    execute.mockResolvedValueOnce({ rows: [membership] });
    execute.mockResolvedValueOnce({ rows: [] });

    await expect(resolveSiteAccess(db, input)).resolves.not.toBeNull();
    await expect(resolveSiteAccess(db, input)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("propagates storage failures without granting access", async () => {
    const { db, execute } = database();
    execute.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(resolveSiteAccess(db, input)).rejects.toThrow(
      "storage unavailable",
    );
  });
});

describe("site capability enforcement", () => {
  it("returns the fresh access projection for an allowed capability", async () => {
    const { db } = database();
    await expect(
      requireSiteCapability(db, actor, input.siteId, "manageTeam"),
    ).resolves.toMatchObject({ membershipRole: "SITE_ADMIN" });
  });

  it("allows freshly resolved OWNER financial consultation without membership", async () => {
    const { db } = database([
      { ...membership, account_role: "OWNER", membership_id: null },
    ]);
    await expect(
      requireSiteCapability(
        db,
        { ...actor, role: "OWNER" },
        input.siteId,
        "readFinance",
      ),
    ).resolves.toMatchObject({
      membershipId: null,
      membershipRole: "OWNER",
      capabilities: {
        readFinance: true,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    });
  });

  it.each(["configureReceiving", "requestWithdrawal"] as const)(
    "denies OWNER %s without explicit financial authority",
    async (capability) => {
      const { db } = database([
        { ...membership, account_role: "OWNER", membership_id: null },
      ]);
      await expect(
        requireSiteCapability(
          db,
          { ...actor, role: "OWNER" },
          input.siteId,
          capability,
        ),
      ).rejects.toMatchObject({ status: 403, code: "MEMBERSHIP_DENIED" });
    },
  );

  it("ignores claimed capabilities and denies assistant team management", async () => {
    const { db } = database([
      { ...membership, membership_role: "SITE_ASSISTANT" },
    ]);
    const claimedActor = {
      ...actor,
      capabilities: { manageTeam: true },
      recipient: true,
    };

    await expect(
      requireSiteCapability(db, claimedActor, input.siteId, "manageTeam"),
    ).rejects.toBeInstanceOf(SiteAccessDeniedError);
  });

  it("rejects unknown capability names rather than inherited object properties", async () => {
    const { db } = database();
    await expect(
      requireSiteCapability(db, actor, input.siteId, "toString" as never),
    ).rejects.toMatchObject({ status: 403, code: "MEMBERSHIP_DENIED" });
  });
});

describe("administrative membership listing", () => {
  it("returns no operational assignments when an account has no memberships", async () => {
    const { db } = database([]);
    await expect(
      getAdministrativeMemberships(db, actor.userId),
    ).resolves.toEqual([]);
  });

  it("returns active site projections with membership-specific permissions", async () => {
    const { db, execute } = database([
      membership,
      {
        ...membership,
        site_id: "site-2",
        membership_id: "membership-2",
        membership_role: "SITE_ASSISTANT",
      },
      {
        ...membership,
        site_id: "site-3",
        revoked_at: new Date("2026-10-12T12:00:00.000Z"),
      },
      { ...membership, site_id: "site-4", account_state: "DISABLED" },
    ]);
    const accesses = await getAdministrativeMemberships(db, actor.userId);

    expect(accesses.map((access) => access.siteId)).toEqual([
      "site-1",
      "site-2",
    ]);
    expect(accesses.map((access) => access.capabilities.manageTeam)).toEqual([
      true,
      false,
    ]);
    expect(
      accesses.every((access) => !access.capabilities.requestWithdrawal),
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(accesses[0]).not.toHaveProperty("account_role");
    expect(accesses[0]).not.toHaveProperty("account_state");
  });

  it("does not return another account's membership or invent OWNER assignments", async () => {
    const { db } = database([
      { ...membership, user_id: "other-user" },
      { ...membership, account_role: "OWNER" },
    ]);
    await expect(
      getAdministrativeMemberships(db, actor.userId),
    ).resolves.toEqual([]);
  });
});
