import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { ReceivingPixDestinationSave } from "./receivingPixDestinationSetup";
import { createReceivingPixDestinationSetupRepository } from "./receivingPixDestinationSetupRepository";

const at = new Date("2026-10-16T22:00:00Z");
const actor = {
  userId: "holder-one",
  siteId: "site-one",
  sessionId: "session-one",
};
function fixture() {
  const scope = {
    provider: "ASAAS" as const,
    siteId: actor.siteId,
    accountId: "account-one",
    accountReference: "provider-one",
    recipientReference: "wallet-one",
    operatorUserId: actor.userId,
    environment: "sandbox" as const,
    destinationVersion: 1,
    membershipId: "membership-one",
    holderId: "holder-custody-one",
    consentId: "consent-one",
  };
  const configuration = {
    version: 1 as const,
    reviewId: "review-one",
    key: {
      version: 1 as const,
      keyId: "key-one",
      nonce: "bm9uY2U",
      ciphertext: "Y2lwaGVy",
      tag: "dGFn",
    },
    review: {
      siteId: actor.siteId,
      mode: "sandbox" as const,
      keyType: "PHONE" as const,
      maskedKey: "***5839",
      ownerName: "External Recipient",
      maskedCpfCnpj: "***.123.456-**",
      bankName: "Test Bank",
      identity: "MISMATCH" as const,
      observedAt: at.toISOString(),
      destinationSaved: false as const,
      withdrawalEnabled: false as const,
    },
    actor,
    authenticatedAt: at.toISOString(),
    proofKind: "PASSWORD_REAUTHENTICATION" as const,
    confirmRecipient: true as const,
    acceptThirdParty: true,
  };
  const command: ReceivingPixDestinationSave = {
    actor,
    recentAuth: {
      ...actor,
      proofKind: "PASSWORD_REAUTHENTICATION",
      verification: "verified",
      provenance: "backend",
      authenticatedAt: at,
      expiresAt: new Date(at.getTime() + 300000),
    },
    scope,
    expiresAt: new Date(at.getTime() + 300000),
    configuration,
  };
  const state = {
    role: "SITE_ADMIN",
    active: true,
    session: true,
    membership: true,
    membershipId: "membership-one",
    holderId: "holder-custody-one",
    expireAfterDeactivate: false,
    expireAfterInsert: false,
    expireAfterRead: false,
    holder: true,
    accountId: scope.accountId,
    clock: at,
    current: {
      id: "destination-one",
      version: 1,
      isCurrent: true,
      configuration: {
        ...configuration,
        reviewId: "previous-review",
      } as unknown,
      state: "PENDING",
    },
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  const execute = vi.fn(
    async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      const text = compiled.sql;
      if (text.startsWith("SELECT clock_timestamp"))
        return { rows: [{ currentTime: state.clock }] };
      if (text.includes("LEFT JOIN site_membership"))
        return {
          rows: [
            {
              user_id: actor.userId,
              account_role: state.role,
              account_state: "ACTIVE",
              site_id: actor.siteId,
              membership_id: state.role === "OWNER" ? null : state.membershipId,
              membership_user_id: state.role === "OWNER" ? null : actor.userId,
              membership_role: state.role === "OWNER" ? null : "SITE_ADMIN",
              revoked_at: null,
            },
          ],
        };
      if (text.includes("FROM site "))
        return { rows: [{ id: actor.siteId, isDemo: true }] };
      if (text.includes('FROM "user"'))
        return {
          rows: state.active
            ? [{ userId: actor.userId, role: state.role, state: "ACTIVE" }]
            : [],
        };
      if (text.includes('FROM "session"'))
        return {
          rows: state.session
            ? [
                {
                  userId: actor.userId,
                  sessionId: actor.sessionId,
                  createdAt: new Date(at.getTime() - 3600000),
                  expiresAt: new Date(at.getTime() + 3600000),
                  lastActiveAt: at,
                },
              ]
            : [],
        };
      if (text.includes("FROM site_membership"))
        return { rows: state.membership ? [{ id: state.membershipId }] : [] };
      if (text.includes("FROM receiving_setup_holder"))
        return {
          rows: state.holder
            ? [
                {
                  id: state.holderId,
                  holderUserId: actor.userId,
                  consentId: "consent-one",
                  consentVersion: "asaas-receiving-v1",
                },
              ]
            : [],
        };
      if (text.includes("FROM receiving_account"))
        return {
          rows: [
            {
              accountId: state.accountId,
              accountReference: scope.accountReference,
              recipientReference: scope.recipientReference,
              operatorUserId: actor.userId,
              state: "SUCCEEDED",
            },
          ],
        };
      if (text.includes("FROM receiving_pix_destination")) {
        if (state.expireAfterRead)
          state.clock = new Date(at.getTime() + 3600000);
        return { rows: [state.current] };
      }
      if (text.startsWith("UPDATE receiving_pix_destination")) {
        state.current.isCurrent = false;
        if (state.expireAfterDeactivate)
          state.clock = new Date(at.getTime() + 300000);
        return { rows: [{ id: state.current.id }] };
      }
      if (text.startsWith("INSERT INTO receiving_pix_destination")) {
        const payload = compiled.params.find(
          (value) =>
            typeof value === "string" && value.startsWith('{"version":1'),
        ) as string;
        state.current = {
          id: compiled.params[0] as string,
          version: 2,
          isCurrent: true,
          state: "PENDING",
          configuration: JSON.parse(payload),
        };
        if (state.expireAfterInsert)
          state.clock = new Date(at.getTime() + 300000);
        return { rows: [{ id: state.current.id }] };
      }
      throw new Error("Unexpected Pix setup query");
    },
  );
  let serial = Promise.resolve();
  const transaction = vi.fn(
    async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => {
      const wait = serial;
      let release!: () => void;
      serial = new Promise<void>((resolve) => {
        release = resolve;
      });
      await wait;
      const before = structuredClone(state.current);
      try {
        return await callback({ execute });
      } catch (error) {
        state.current = before;
        throw error;
      } finally {
        release();
      }
    },
  );
  const repository = createReceivingPixDestinationSetupRepository(
    { execute, transaction } as never,
    {
      mode: "sandbox",
      applicationEnvironment: "development",
      now: () => at,
      generateId: () => "destination-two",
    },
  );
  return { repository, state, command, queries, transaction };
}
describe("locked Pix destination configuration", () => {
  it("stores payout configuration without writing any receiving-readiness destination", async () => {
    const v = fixture();
    await v.repository.save(v.command);
    expect(
      v.queries.some((query) => /\breceiving_destination\b/.test(query.sql)),
    ).toBe(false);
    expect(
      v.queries.some((query) =>
        query.sql.startsWith("INSERT INTO receiving_pix_destination"),
      ),
    ).toBe(true);
  });
  it("binds the receipt scope to actual membership and consent custody", async () => {
    const v = fixture();
    const state = await v.repository.snapshot(actor);
    expect(state.scope).toMatchObject({
      membershipId: "membership-one",
      holderId: "holder-custody-one",
      consentId: "consent-one",
    });
  });
  it("revalidates holder authority and saves one pending version, then treats replay idempotently", async () => {
    const v = fixture();
    const saved = await v.repository.save(v.command);
    expect(saved).toMatchObject({
      id: "destination-two",
      version: 2,
      configuration: { reviewId: "review-one" },
    });
    expect(
      v.queries.find((query) => query.sql.startsWith("INSERT"))?.sql,
    ).toContain("'PENDING'");
    expect(
      v.queries.filter((query) => query.sql.startsWith("INSERT")),
    ).toHaveLength(1);
    expect(await v.repository.save(v.command)).toEqual(saved);
    expect(
      v.queries.filter((query) => query.sql.startsWith("INSERT")),
    ).toHaveLength(1);
  });
  it("serializes concurrent confirmation of one receipt into one destination version", async () => {
    const v = fixture();
    const results = await Promise.all([
      v.repository.save(v.command),
      v.repository.save(v.command),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      v.queries.filter((query) => query.sql.startsWith("INSERT")),
    ).toHaveLength(1);
    expect(v.queries[0].sql).toContain("FOR UPDATE");
  });
  it.each(["deactivate", "insert"])(
    "rolls back destination changes if review expires after %s",
    async (stage) => {
      const v = fixture();
      if (stage === "deactivate") v.state.expireAfterDeactivate = true;
      else v.state.expireAfterInsert = true;
      await expect(v.repository.save(v.command)).rejects.toMatchObject({
        code: "PIX_DESTINATION_REVIEW_EXPIRED",
      });
      expect(v.state.current).toMatchObject({
        id: "destination-one",
        version: 1,
        isCurrent: true,
      });
    },
  );
  it.each([
    "session",
    "membership",
    "membership-replaced",
    "holder-replaced",
    "holder",
    "account",
    "version",
    "expiry",
    "session-proof",
  ])("denies changed %s without persistence", async (change) => {
    const v = fixture();
    if (change === "session") v.state.session = false;
    if (change === "membership") v.state.membership = false;
    if (change === "membership-replaced")
      v.state.membershipId = "membership-two";
    if (change === "holder-replaced") v.state.holderId = "holder-custody-two";
    if (change === "holder") v.state.holder = false;
    if (change === "account") v.state.accountId = "other-account";
    if (change === "version") v.state.current.version = 2;
    if (change === "expiry") v.command.expiresAt = at;
    if (change === "session-proof")
      v.command.recentAuth.proofKind = "SESSION_AUTHENTICATION" as never;
    await expect(v.repository.save(v.command)).rejects.toThrow();
    expect(
      v.queries.some(
        (query) =>
          query.sql.startsWith("UPDATE") || query.sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  });
  it("does not return masked account data after the actual session expires during a read", async () => {
    const v = fixture();
    v.state.expireAfterRead = true;
    await expect(v.repository.snapshot(actor, true)).rejects.toMatchObject({
      code: "MEMBERSHIP_DENIED",
    });
  });
  it("allows freshly verified OWNER read without granting holder mutation", async () => {
    const v = fixture();
    v.state.role = "OWNER";
    v.state.membership = false;
    await expect(v.repository.snapshot(actor, true)).resolves.toMatchObject({
      scope: { accountId: "account-one" },
    });
    await expect(v.repository.save(v.command)).rejects.toThrow();
  });
});
