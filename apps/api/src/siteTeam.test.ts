import { createHash } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCredential } from "./adminAccess";
import { requireSiteCapability, SiteAccessDeniedError } from "./siteAccess";
import {
  acceptSiteAssessorInvitation,
  issueSiteAssessorInvitation,
  listSiteTeam,
  revokeSiteAssessorInvitation,
  revokeSiteAssessorMembership,
} from "./siteTeam";

const randomness = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: vi.fn((size: number) =>
    Buffer.alloc(size, ++randomness.sequence),
  ),
  randomUUID: vi.fn(() => `generated-${++randomness.sequence}`),
}));
vi.mock("./adminAccess", () => ({ setCredential: vi.fn() }));
vi.mock("./siteAccess", async (original) => ({
  ...(await original<typeof import("./siteAccess")>()),
  requireSiteCapability: vi.fn(),
}));

const now = new Date("2026-10-12T12:00:00.000Z");
const siteId = "site-1";
const token = "t".repeat(43);
const actor = { userId: "admin-1", role: "SITE_ADMIN" as const };
const email = "assistant@example.test";
const invitation = {
  id: "invitation-1",
  siteId,
  email,
  inviteeName: "Invited Helper",
  role: "SITE_ASSISTANT",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  expiresAt: new Date(now.getTime() + 86_400_000),
  consumedAt: null as Date | null,
  revokedAt: null as Date | null,
  invitedByUserId: actor.userId,
  createdAt: now,
};
const existingUser = {
  id: "assistant-1",
  name: "Existing Name",
  email,
  role: "SITE_ADMIN",
  state: "ACTIVE",
};

function fixture(
  options: {
    invitation?: Record<string, unknown> | null;
    existingUser?: Record<string, unknown> | null;
    membership?: Record<string, unknown> | null;
    issuer?: Record<string, unknown> | null;
    consumeSucceeds?: boolean;
    membershipUpdateSucceeds?: boolean;
    siteExists?: boolean;
  } = {},
) {
  const invite =
    options.invitation === undefined ? { ...invitation } : options.invitation;
  const currentUser =
    options.existingUser === undefined
      ? { ...existingUser }
      : options.existingUser;
  const currentMembership = options.membership ?? null;
  const issuer =
    options.issuer === undefined
      ? { id: actor.userId, role: actor.role, state: "ACTIVE" }
      : options.issuer;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const inserted: Array<{ table: string; value: Record<string, unknown> }> = [];
  const execute = vi.fn(async (query) => {
    const compiled = new PgDialect().sqlToQuery(query);
    queries.push(compiled);
    const text = compiled.sql;
    if (/FROM site WHERE/i.test(text)) {
      return { rows: options.siteExists === false ? [] : [{ id: siteId }] };
    }
    if (/FROM site_assessor_invitation/i.test(text)) {
      if (/token_hash\s*=/i.test(text)) {
        return {
          rows: invite?.tokenHash === compiled.params[0] ? [invite] : [],
        };
      }
      if (/WHERE id\s*=/i.test(text)) {
        return {
          rows:
            invite?.id === compiled.params[0] &&
            invite?.siteId === compiled.params[1]
              ? [invite]
              : [],
        };
      }
      return { rows: invite ? [invite] : [] };
    }
    if (/FROM "user"/i.test(text)) {
      if (/WHERE id\s*=/i.test(text)) return { rows: issuer ? [issuer] : [] };
      return { rows: currentUser ? [currentUser] : [] };
    }
    if (/FROM site_membership/i.test(text)) {
      return { rows: currentMembership ? [currentMembership] : [] };
    }
    if (/UPDATE site_assessor_invitation[\s\S]*SET consumed_at/i.test(text)) {
      if (options.consumeSucceeds === false) return { rows: [] };
      return { rows: [{ id: invitation.id }] };
    }
    if (/^\s*UPDATE[\s\S]*RETURNING id/i.test(text)) {
      if (
        /UPDATE site_membership/i.test(text) &&
        options.membershipUpdateSucceeds === false
      )
        return { rows: [] };
      return { rows: [{ id: currentMembership?.id ?? invite?.id }] };
    }
    return { rows: [] };
  });
  const db = {
    execute,
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const initialInsertCount = inserted.length;
      try {
        return await callback(db);
      } catch (error) {
        inserted.splice(initialInsertCount);
        throw error;
      }
    }),
    insert: vi.fn((table) => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        inserted.push({ table: getTableName(table), value });
      }),
    })),
  };
  return {
    db: db as never,
    queries,
    inserted,
    execute,
    transaction: db.transaction,
  };
}

function existingActor() {
  return { userId: existingUser.id, role: "SITE_ADMIN" as const };
}

beforeEach(() => {
  vi.clearAllMocks();
  randomness.sequence = 0;
  vi.mocked(requireSiteCapability)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(setCredential).mockReset().mockResolvedValue(undefined);
});

describe("assessor invitation issuance", () => {
  it("issues a normalized site-bound invitation and stores only its SHA256 hash", async () => {
    const { db, inserted, queries } = fixture();
    const result = await issueSiteAssessorInvitation(
      db,
      actor,
      siteId,
      {
        name: " Helper ",
        email: " ASSISTANT@EXAMPLE.TEST ",
      },
      now,
    );

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.invitation).toMatchObject({
      siteId,
      email,
      inviteeName: "Helper",
      expiresAt: "2026-10-13T12:00:00.000Z",
    });
    const stored = inserted.find(
      (row) => row.table === "site_assessor_invitation",
    )?.value;
    expect(stored).toMatchObject({
      siteId,
      email,
      role: "SITE_ASSISTANT",
      invitedByUserId: actor.userId,
    });
    expect(stored?.tokenHash).toBe(
      createHash("sha256").update(result.token).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(result.invitation).not.toHaveProperty("tokenHash");
    const revocation = queries.find((query) =>
      /UPDATE site_assessor_invitation/i.test(query.sql),
    );
    expect(revocation?.params).toContain(siteId);
    expect(revocation?.params).toContain(email);
    expect(revocation?.sql).toMatch(/consumed_at IS NULL/i);
    expect(revocation?.sql).toMatch(/revoked_at IS NULL/i);
    expect(requireSiteCapability).toHaveBeenCalledTimes(2);
  });

  it.each([null, now])(
    "never invites or demotes an existing site admin, even if revoked",
    async (revokedAt) => {
      const { db, inserted } = fixture({
        membership: { id: "admin-membership", role: "SITE_ADMIN", revokedAt },
      });
      await expect(
        issueSiteAssessorInvitation(
          db,
          actor,
          siteId,
          { name: "Helper", email },
          now,
        ),
      ).rejects.toMatchObject({ status: 409, code: "TEAM_MEMBER_CONFLICT" });
      expect(inserted).toEqual([]);
    },
  );

  it("rechecks manager authority after acquiring the site lock", async () => {
    vi.mocked(requireSiteCapability)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new SiteAccessDeniedError());
    const { db, inserted, queries } = fixture();
    await expect(
      issueSiteAssessorInvitation(
        db,
        actor,
        siteId,
        { name: "Helper", email },
        now,
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED" });
    expect(queries[0].sql).toMatch(/FROM site[\s\S]*FOR UPDATE/i);
    expect(inserted).toEqual([]);
  });

  it.each([
    { role: "SITE_ADMIN" },
    { siteId: "other-site" },
    { recipient: true },
  ])("rejects privilege fields before any database work", async (extra) => {
    const { db, execute, transaction } = fixture();
    await expect(
      issueSiteAssessorInvitation(
        db,
        actor,
        siteId,
        { name: "Helper", email, ...extra } as never,
        now,
      ),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("assessor invitation acceptance", () => {
  it("adds an existing SITE_ADMIN account as assistant without changing identity, credentials or sessions", async () => {
    const { db, queries, inserted } = fixture();
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).resolves.toEqual({ siteId });
    expect(inserted).toEqual([
      {
        table: "site_membership",
        value: expect.objectContaining({
          siteId,
          userId: existingUser.id,
          role: "SITE_ASSISTANT",
          invitedByUserId: actor.userId,
        }),
      },
    ]);
    expect(setCredential).not.toHaveBeenCalled();
    expect(
      queries.some((query) =>
        /UPDATE "user"|DELETE FROM session|UPDATE account/i.test(query.sql),
      ),
    ).toBe(false);
    const credentialLock = queries.findIndex((query) =>
      /pg_advisory_xact_lock/i.test(query.sql),
    );
    const siteLock = queries.findIndex((query) =>
      /FROM site WHERE/i.test(query.sql),
    );
    const tokenLock = queries.findIndex((query) =>
      /FROM site_assessor_invitation[\s\S]*FOR UPDATE/i.test(query.sql),
    );
    expect(credentialLock).toBeGreaterThan(-1);
    expect(queries[credentialLock].params).toEqual([email]);
    expect(siteLock).toBeGreaterThan(credentialLock);
    expect(tokenLock).toBeGreaterThan(siteLock);
  });

  it("creates only a new assistant account with the issuer-provided name and an explicit credential", async () => {
    const { db, inserted } = fixture({ existingUser: null });
    await expect(
      acceptSiteAssessorInvitation(
        db,
        { token, password: "password10" },
        null,
        now,
      ),
    ).resolves.toEqual({ siteId });
    const created = inserted.find((row) => row.table === "user")?.value;
    expect(created).toMatchObject({
      name: invitation.inviteeName,
      email,
      role: "SITE_ASSISTANT",
      state: "ACTIVE",
      emailVerified: true,
    });
    expect(setCredential).toHaveBeenCalledWith(
      expect.anything(),
      created?.id,
      "password10",
      now,
    );
    expect(
      inserted.find((row) => row.table === "site_membership")?.value,
    ).toMatchObject({ userId: created?.id, role: "SITE_ASSISTANT" });
  });

  it("reactivates only an existing assistant membership", async () => {
    const { db, inserted, queries } = fixture({
      membership: {
        id: "membership-existing",
        role: "SITE_ASSISTANT",
        revokedAt: now,
      },
    });
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).resolves.toEqual({ siteId });
    expect(inserted).toEqual([]);
    const update = queries.find((query) =>
      /UPDATE site_membership/i.test(query.sql),
    );
    expect(update?.sql).toMatch(/revoked_at = NULL/i);
    expect(update?.sql).toMatch(/role = 'SITE_ASSISTANT'/i);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("does not consume a token when membership reactivation fails", async () => {
    const { db, queries } = fixture({
      membership: {
        id: "membership-existing",
        role: "SITE_ASSISTANT",
        revokedAt: now,
      },
      membershipUpdateSucceeds: false,
    });
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).rejects.toMatchObject({ code: "TEAM_MEMBER_CONFLICT" });
    expect(queries.some((query) => /SET consumed_at/i.test(query.sql))).toBe(
      false,
    );
  });

  it("requires logout before activating a new account under a different identity", async () => {
    const { db, inserted } = fixture({ existingUser: null });
    await expect(
      acceptSiteAssessorInvitation(
        db,
        { token, password: "password10" },
        existingActor(),
        now,
      ),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_ACCOUNT_REQUIRED" });
    expect(inserted).toEqual([]);
  });

  it.each([
    ["wrong email", { email: "other@example.test" }],
    ["disabled account", { state: "DISABLED" }],
    ["pending account", { state: "PENDING" }],
    ["different account", { id: "other-user" }],
    ["changed global role", { role: "SITE_ASSISTANT" }],
  ])("requires the active invited account for %s", async (_label, changes) => {
    const { db, inserted } = fixture({
      existingUser: { ...existingUser, ...changes },
    });
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_ACCOUNT_REQUIRED" });
    expect(inserted).toEqual([]);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("requires authentication when an invited email already has an account", async () => {
    const { db } = fixture();
    await expect(
      acceptSiteAssessorInvitation(db, { token }, null, now),
    ).rejects.toMatchObject({
      status: 409,
      code: "TEAM_INVITATION_ACCOUNT_REQUIRED",
    });
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("rejects any supplied password for an existing account", async () => {
    const { db, inserted } = fixture();
    await expect(
      acceptSiteAssessorInvitation(
        db,
        { token, password: "password10" },
        existingActor(),
        now,
      ),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
    expect(inserted).toEqual([]);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it.each([undefined, "short", "password-too-long"])(
    "requires a valid activation password for a new account",
    async (password) => {
      const { db, inserted } = fixture({ existingUser: null });
      await expect(
        acceptSiteAssessorInvitation(
          db,
          { token, ...(password === undefined ? {} : { password }) },
          null,
          now,
        ),
      ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
      expect(inserted).toEqual([]);
    },
  );

  it.each([
    ["expired", { expiresAt: now }],
    ["consumed", { consumedAt: now }],
    ["revoked", { revokedAt: now }],
    ["promoted role", { role: "SITE_ADMIN" }],
    ["wrong token", { tokenHash: "a".repeat(64) }],
  ])(
    "rejects an %s invitation before membership or account writes",
    async (_label, changes) => {
      const { db, inserted } = fixture({
        invitation: { ...invitation, ...changes },
      });
      await expect(
        acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
      ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
      expect(inserted).toEqual([]);
      expect(setCredential).not.toHaveBeenCalled();
    },
  );

  it.each([null, now])(
    "never demotes an existing administrator membership during acceptance",
    async (revokedAt) => {
      const { db, inserted } = fixture({
        membership: { id: "membership-admin", role: "SITE_ADMIN", revokedAt },
      });
      await expect(
        acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
      ).rejects.toMatchObject({ code: "TEAM_MEMBER_CONFLICT" });
      expect(inserted).toEqual([]);
    },
  );

  it("rejects an invitation after its issuer loses management authority", async () => {
    vi.mocked(requireSiteCapability).mockRejectedValue(
      new SiteAccessDeniedError(),
    );
    const { db, inserted } = fixture();
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
    expect(inserted).toEqual([]);
  });

  it.each([null, { id: actor.userId, role: actor.role, state: "DISABLED" }])(
    "rejects a missing or disabled issuer even before capability resolution",
    async (issuer) => {
      const { db, inserted } = fixture({ issuer });
      await expect(
        acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
      ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
      expect(inserted).toEqual([]);
      expect(requireSiteCapability).not.toHaveBeenCalled();
    },
  );

  it("fails the transaction if conditional consumption loses a race", async () => {
    const { db, inserted } = fixture({ consumeSucceeds: false });
    await expect(
      acceptSiteAssessorInvitation(db, { token }, existingActor(), now),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
    expect(inserted).toEqual([]);
  });

  it("does not accept a site, role or account identity supplied in the body", async () => {
    const { db, execute } = fixture();
    await expect(
      acceptSiteAssessorInvitation(
        db,
        {
          token,
          siteId: "other",
          role: "SITE_ADMIN",
          userId: "other",
        } as never,
        existingActor(),
        now,
      ),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("site-scoped team revocation and listing", () => {
  it("revokes only the assistant membership and pending same-site/email invitations", async () => {
    const { db, queries, inserted } = fixture({
      membership: {
        id: "membership-1",
        userId: existingUser.id,
        role: "SITE_ASSISTANT",
        email,
      },
    });
    await expect(
      revokeSiteAssessorMembership(db, actor, siteId, existingUser.id, now),
    ).resolves.toEqual({ ok: true });
    const updates = queries.filter((query) => /^\s*UPDATE/i.test(query.sql));
    expect(updates).toHaveLength(2);
    expect(updates[0].params).toContain(siteId);
    expect(updates[0].params).toContain(existingUser.id);
    expect(updates[0].sql).toMatch(/role = 'SITE_ASSISTANT'/i);
    expect(updates[1].params).toContain(siteId);
    expect(updates[1].params).toContain(email);
    expect(
      queries.some((query) => /DELETE|UPDATE "user"/i.test(query.sql)),
    ).toBe(false);
    expect(inserted).toEqual([]);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("rejects administrator membership removal", async () => {
    const { db, queries } = fixture({
      membership: { role: "SITE_ADMIN", email },
    });
    await expect(
      revokeSiteAssessorMembership(db, actor, siteId, existingUser.id, now),
    ).rejects.toMatchObject({ code: "TEAM_MEMBER_CONFLICT" });
    expect(queries.some((query) => /^\s*UPDATE/i.test(query.sql))).toBe(false);
  });

  it("revokes an invitation only by its bound ID and site", async () => {
    const { db, queries } = fixture();
    await expect(
      revokeSiteAssessorInvitation(db, actor, siteId, invitation.id, now),
    ).resolves.toEqual({ ok: true });
    const update = queries.find((query) =>
      /UPDATE site_assessor_invitation/i.test(query.sql),
    );
    expect(update?.params).toContain(invitation.id);
    expect(update?.params).toContain(siteId);
    expect(setCredential).not.toHaveBeenCalled();
    await expect(
      revokeSiteAssessorInvitation(db, actor, "other-site", invitation.id, now),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_INVALID" });
  });

  it("lists public-safe team DTOs without token hashes or administrators", async () => {
    const { db, queries } = fixture({
      membership: {
        userId: existingUser.id,
        siteId,
        name: existingUser.name,
        email,
        membershipRole: "SITE_ASSISTANT",
        revokedAt: null,
      },
    });
    const result = await listSiteTeam(db, actor, siteId);
    expect(result.members).toEqual([
      {
        userId: existingUser.id,
        siteId,
        name: existingUser.name,
        email,
        membershipRole: "SITE_ASSISTANT",
        revokedAt: null,
      },
    ]);
    expect(result.invitations[0]).toMatchObject({
      id: invitation.id,
      siteId,
      inviteeName: invitation.inviteeName,
    });
    expect(result.invitations[0]).not.toHaveProperty("tokenHash");
    const memberQuery = queries.find((query) =>
      /FROM site_membership/i.test(query.sql),
    );
    expect(memberQuery?.sql).toMatch(/role = 'SITE_ASSISTANT'/i);
    expect(memberQuery?.params).toContain(siteId);
  });
});
