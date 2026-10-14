import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import type {
  ReceivingNominationAdmissionAuthority,
  ReceivingNominationAdmissionContext,
  ReceivingNominationAdmissionFrame,
  ReceivingNominationCurrentAuthorization,
  ReceivingNominationLockedState,
  ReceivingNominationSnapshot,
} from "./receivingNomination";
import { createReceivingNominationRepository } from "./receivingNominationRepository";

const currentTime = new Date("2026-10-12T18:20:00.000Z");
const canonicalRequestId = `nr1_${createHash("sha256")
  .update(
    JSON.stringify([
      "receiving.self-nomination.request.v1",
      "site-one",
      "user-one",
      "ASAAS",
      "sandbox",
    ]),
    "utf8",
  )
  .digest("base64url")}`;
function fixture(rawTimestamps = false) {
  const snapshot: ReceivingNominationSnapshot = {
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: canonicalRequestId,
    operatorUserId: "user-one",
    environment: "sandbox",
    policyVersion: "intent-v1",
    accountId: "account-one",
    operationId: "operation-one",
    createdAt: currentTime.toISOString(),
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          canonicalRequestId,
          "user-one",
          "sandbox",
          "intent-v1",
          true,
        ]),
        "utf8",
      )
      .digest("hex"),
    authentication: {
      userId: "user-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T18:19:30.000Z",
      expiresAt: "2026-10-12T18:24:30.000Z",
    },
  };
  const authorization: ReceivingNominationCurrentAuthorization = {
    actor: { userId: "user-one", siteId: "site-one", sessionId: "session-one" },
    recentAuth: {
      userId: "user-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      verification: "verified",
      provenance: "backend",
      authenticatedAt: new Date(snapshot.authentication.authenticatedAt),
      expiresAt: new Date(snapshot.authentication.expiresAt),
    },
  };
  const tables: {
    accounts: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
  } = { accounts: [], operations: [] };
  const state = {
    clock: new Date(currentTime),
    sitePresent: true,
    isDemo: false,
    userState: "ACTIVE",
    userRole: "SITE_ADMIN",
    membershipRole: "SITE_ADMIN",
    revokedAt: null as Date | null,
    sessionExpiresAt: new Date("2026-10-13T18:20:00.000Z"),
    lastActiveAt: new Date(currentTime),
    sessionCreatedAt: new Date(currentTime),
    sessionId: "session-one",
    commitLost: false,
    failOperation: false,
    expireAfterInsert: false,
    failRead: false,
  };
  const custody = {
    authority: {
      version: "receiving.new-admission.v1",
      issuerId: "fixture-issuer",
      issuerVersion: "issuer-v1",
      disclosureId: "fixture-disclosure",
      disclosureVersion: "disclosure-v1",
      holderUserId: "user-one",
      authorityId: "fixture-authority",
      authorityVersion: "authority-v1",
      consentId: "fixture-consent",
      consentVersion: "consent-v1",
      custodyId: "fixture-custody",
      custodyVersion: "custody-v1",
      issuedAt: "2026-10-12T18:19:30.000Z",
      expiresAt: "2026-10-12T18:24:30.000Z",
      context: {
        draft: structuredClone(snapshot),
        actor: {
          userId: "user-one",
          siteId: "site-one",
          sessionId: "session-one",
        },
        input: {
          requestId: canonicalRequestId,
          confirmSelfAsRecipient: true,
          policyVersion: "intent-v1",
        },
        applicationEnvironment: "test",
      },
    } as ReceivingNominationAdmissionAuthority | null,
    locked: false,
    transaction: null as unknown,
    events: [] as string[],
    beforeLockedRead: null as (() => Promise<void>) | null,
    beforeCommit: null as (() => Promise<void>) | null,
    beforeRollback: null as (() => Promise<void>) | null,
    afterInsert: null as (() => void) | null,
    mutate: (change: Partial<ReceivingNominationAdmissionAuthority>) => {
      if (custody.locked) return false;
      if (custody.authority) Object.assign(custody.authority, change);
      return true;
    },
  };
  const frame: ReceivingNominationAdmissionFrame = structuredClone({
    context: custody.authority!.context,
    authority: custody.authority!,
  });
  const lockAuthority = vi.fn(
    async (
      transaction: unknown,
      _context: ReceivingNominationAdmissionContext,
      _original: ReceivingNominationAdmissionAuthority,
    ): Promise<unknown> => {
      if (custody.beforeLockedRead) await custody.beforeLockedRead();
      // This is the fixture's actual transaction lifetime, independently stored custody.
      if (
        before === null ||
        !transaction ||
        typeof (transaction as { execute?: unknown }).execute !== "function"
      )
        throw new Error("No active fixture transaction");
      custody.transaction = transaction;
      custody.locked = true;
      custody.events.push("lock");
      return structuredClone(custody.authority);
    },
  );
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let before: typeof tables | null = null;
  const query = vi.fn(
    async (
      statement: string | { text: string; rowMode?: string },
      params: unknown[] = [],
    ) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (/^begin/i.test(text)) {
        before = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        if (custody.beforeCommit) await custody.beforeCommit();
        custody.events.push(
          custody.locked ? "commit-locked" : "commit-unlocked",
        );
        before = null;
        custody.locked = false;
        if (state.commitLost) throw new Error("private database commit");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (custody.beforeRollback) await custody.beforeRollback();
        custody.events.push(
          custody.locked ? "rollback-locked" : "rollback-unlocked",
        );
        custody.locked = false;
        if (before) {
          tables.accounts = before.accounts;
          tables.operations = before.operations;
        }
        return { rows: [] };
      }
      if (/FULL OUTER JOIN "financial_operation" op/.test(text)) {
        if (state.failRead) throw new Error("private scope query");
        const accounts = tables.accounts.filter(
          (a) => a.siteId === params[0] && a.environment === params[1],
        );
        const operations = tables.operations.filter(
          (op) => op.siteId === params[0] && op.environment === params[1],
        );
        const joined: Array<{
          a: Record<string, unknown> | null;
          op: Record<string, unknown> | null;
        }> = [];
        for (const a of accounts) {
          const matching = operations.filter(
            (op) =>
              op.accountId === a.id &&
              op.siteId === a.siteId &&
              op.environment === a.environment,
          );
          if (matching.length === 0) joined.push({ a, op: null });
          else for (const op of matching) joined.push({ a, op });
        }
        for (const op of operations)
          if (
            !accounts.some(
              (a) =>
                a.id === op.accountId &&
                a.siteId === op.siteId &&
                a.environment === op.environment,
            )
          )
            joined.push({ a: null, op });
        const projection = text
          .split(/FROM/i)[0]
          .replace(/^SELECT\s+/i, "")
          .split(/,\s*(?=[a-z]+\.)/);
        return {
          rows: joined.map((source) =>
            Object.fromEntries(
              projection.map((part) => {
                if (part.trim().endsWith('AS "hasProviderBinding"'))
                  return [
                    "hasProviderBinding",
                    source.a === null
                      ? null
                      : [
                          "operatorReference",
                          "webhookTokenHash",
                          "accountReference",
                          "recipientReference",
                          "credentialVersion",
                          "credentialKeyId",
                          "credentialNonce",
                          "credentialCiphertext",
                          "credentialTag",
                          "observedAt",
                        ].some((key) => source.a?.[key] !== null) ||
                        source.a.providerAccountState !== "UNVERIFIED" ||
                        source.a.receivingCapability !== false ||
                        source.a.withdrawalCapability !== false ||
                        source.a.commercialEnabled !== false,
                  ];
                const field = part
                  .trim()
                  .match(/^(a|op)\.([a-z_]+) AS "([^"]+)"$/);
                if (!field) throw new Error("Unexpected scope projection");
                const key = field[2].replace(/_([a-z])/g, (_, c: string) =>
                  c.toUpperCase(),
                );
                return [
                  field[3],
                  source[field[1] as "a" | "op"]?.[key] ?? null,
                ];
              }),
            ),
          ),
        };
      }
      if (/FROM "site" st/.test(text))
        return {
          rows:
            state.sitePresent && params[0] === "site-one"
              ? [
                  {
                    siteId: "site-one",
                    isDemo: state.isDemo,
                    currentTime: new Date(state.clock),
                  },
                ]
              : [],
        };
      if (/FROM "session" se/.test(text))
        return {
          rows: [
            {
              userId: "user-one",
              sessionId: state.sessionId,
              sessionExpiresAt: state.sessionExpiresAt,
              lastActiveAt: state.lastActiveAt,
              sessionCreatedAt: state.sessionCreatedAt,
            },
          ],
        };
      if (/FROM "user" u/.test(text) && /FOR SHARE OF u/.test(text))
        return {
          rows: [
            {
              userId: "user-one",
              role: state.userRole,
              state: state.userState,
            },
          ],
        };
      if (/FROM "user" u/.test(text))
        return {
          rows: [
            {
              user_id: "user-one",
              account_role: state.userRole,
              account_state: state.userState,
              site_id: "site-one",
              membership_id: "membership-one",
              membership_user_id: "user-one",
              membership_role: state.membershipRole,
              revoked_at: state.revokedAt,
            },
          ],
        };
      if (/FROM "site_membership" m/.test(text))
        return {
          rows:
            state.revokedAt === null && state.membershipRole === "SITE_ADMIN"
              ? [{ id: "membership-one" }]
              : [],
        };
      if (/FROM "receiving_account" a/.test(text))
        return {
          rows: tables.accounts.map((a) => ({
            ...a,
            hasProviderBinding:
              a.accountReference !== null ||
              a.operatorReference !== null ||
              a.webhookTokenHash !== null ||
              a.credentialVersion !== null ||
              a.providerAccountState !== "UNVERIFIED",
          })),
        };
      if (/FROM "financial_operation" op/.test(text))
        return {
          rows: tables.operations
            .filter(
              (op) =>
                op.siteId === params[0] &&
                op.requestId === params[1] &&
                op.kind === "ACCOUNT_CREATE",
            )
            .map((op) => ({
              ...op,
              accountOperatorUserId: tables.accounts.find(
                (a) => a.id === op.accountId,
              )?.operatorUserId,
              accountSiteId: "site-one",
              accountEnvironment: "sandbox",
              accountProvider: "ASAAS",
            })),
        };
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
      const insert = text.match(
        /^insert into "([a-z_]+)" \((.*?)\) values \((.*?)\)/i,
      );
      if (insert) {
        if (insert[1] === "financial_operation" && state.failOperation)
          throw new Error("private operation insert");
        const cols = [...insert[2].matchAll(/"([a-z_]+)"/g)].map((v) =>
          v[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        );
        const values = insert[3].split(",").map((v) => {
          const p = v.trim().match(/^\$(\d+)$/);
          return p ? params[Number(p[1]) - 1] : null;
        });
        const row = Object.fromEntries(
          cols.map((c, i) => [
            c,
            c === "requestSnapshot" && typeof values[i] === "string"
              ? JSON.parse(values[i] as string)
              : values[i],
          ]),
        );
        (insert[1] === "receiving_account"
          ? tables.accounts
          : tables.operations
        ).push(row);
        if (custody.afterInsert) custody.afterInsert();
        if (state.expireAfterInsert)
          state.clock = new Date("2026-10-12T18:24:30.000Z");
        return {
          rows:
            typeof statement !== "string" && statement.rowMode === "array"
              ? [[row.id]]
              : [{ id: row.id }],
        };
      }
      if (/SELECT clock_timestamp/.test(text))
        return { rows: [{ currentTime: new Date(state.clock) }] };
      throw new Error("Unexpected nomination query");
    },
  );
  const db = drizzle({
    query: async (...args: Parameters<typeof query>) => {
      const result = await query(...args);
      if (!rawTimestamps) return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          Array.isArray(row)
            ? row
            : Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  value instanceof Date
                    ? value.toISOString().replace("T", " ").replace("Z", "+00")
                    : value,
                ]),
              ),
        ),
      };
    },
  } as unknown as NodePgClient);
  const options = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    maxAuthAgeMs: 300000,
    now: () => new Date(state.clock),
    admission: {
      issuerId: "fixture-issuer",
      issuerVersion: "issuer-v1",
      disclosureId: "fixture-disclosure",
      disclosureVersion: "disclosure-v1",
      lockAuthority,
    },
  };
  const rawRepository = createReceivingNominationRepository(db, options);
  return {
    snapshot,
    authorization,
    tables,
    state,
    queries,
    db,
    options,
    custody,
    frame,
    lockAuthority,
    rawRepository,
    // Original NEW-success fixtures gain only a transient independently pinned frame.
    repository: {
      ...rawRepository,
      reserveNomination: (
        draft: ReceivingNominationSnapshot,
        authorize: (state: ReceivingNominationLockedState) => Promise<void>,
        authorization: ReceivingNominationCurrentAuthorization,
        suppliedFrame: ReceivingNominationAdmissionFrame | undefined = frame,
      ) =>
        rawRepository.reserveNomination(
          draft,
          authorize,
          authorization,
          suppliedFrame,
        ),
    },
    authorize: vi.fn(async (_state: ReceivingNominationLockedState) => {}),
  };
}
describe("durable initial receiving nomination", () => {
  it.each(["CLAIMED", "UNKNOWN", "SUCCEEDED"])(
    "keeps private provisioning %s history unavailable to nomination replay",
    async (operationState) => {
      const values = fixture();
      await values.repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      );
      const original = values.snapshot;
      values.tables.operations[0].state = operationState;
      values.tables.operations[0].requestSnapshot = {
        version: "receiving.account-provisioning.v1",
        nomination: original,
        provision: {
          provider: "ASAAS",
          siteId: original.siteId,
          accountId: original.accountId,
          operationId: original.operationId,
          requestId: original.requestId,
          operatorUserId: original.operatorUserId,
          environment: original.environment,
          policyVersion: original.policyVersion,
          parentAccountReference: "fictional-parent",
          fingerprintVersion: "hkdf-hmac-sha256-v1",
          fingerprintKeyId: "fingerprint-v1",
          inputFingerprint: "a".repeat(64),
          dispatch: {
            leaseOwner: "owner-one",
            leaseToken: "token-one",
            leaseExpiresAtMicroseconds: (
              BigInt(currentTime.getTime()) * 1000n +
              60000000n
            ).toString(),
            possibleDispatch: operationState !== "CLAIMED",
          },
        },
        sealedResult: null,
      };
      await expect(
        values.repository.findByRequest(original.siteId, original.requestId),
      ).rejects.toMatchObject({
        status: 409,
        code: "RECEIVING_BINDING_EXISTS",
      });
      await expect(
        values.repository.readNominationScope({
          siteId: original.siteId,
          operatorUserId: original.operatorUserId,
          environment: original.environment,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "RECEIVING_BINDING_EXISTS",
      });
      expect(values.tables.accounts).toHaveLength(1);
      expect(values.tables.operations).toHaveLength(1);
    },
  );
  it("rejects a noncanonical first request inside the empty locked scope without writes", async () => {
    const v = fixture();
    const legacy = withRequest(v.snapshot, "request-one");
    await expect(
      v.repository.reserveNomination(legacy, v.authorize, v.authorization),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    expect(v.tables.accounts).toHaveLength(0);
    expect(v.tables.operations).toHaveLength(0);
    expect(v.queries.some((q) => /FOR UPDATE OF st/.test(q.sql))).toBe(true);
    expect(v.authorize).toHaveBeenCalledOnce();
  });
  it("preserves a valid legacy request on locked replay", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    const legacy = withRequest(v.snapshot, "legacy.request:one");
    Object.assign(v.tables.operations[0], {
      requestId: legacy.requestId,
      requestHash: legacy.requestHash,
      requestSnapshot: legacy,
    });
    expect(
      await v.repository.reserveNomination(
        legacy,
        v.authorize,
        v.authorization,
      ),
    ).toEqual(legacy);
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.operations).toHaveLength(1);
  });
  it("normalizes raw Drizzle database clock and session timestamps before creating only an unverified candidate", async () => {
    const v = fixture(true);
    expect(
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      ),
    ).toEqual(v.snapshot);
    expect(v.tables.accounts[0].providerAccountState).toBe("UNVERIFIED");
    expect(
      await v.repository.findByRequest(v.snapshot.siteId, v.snapshot.requestId),
    ).toEqual(v.snapshot);
  });

  it("retains the Date-only backend authentication clock requirement", async () => {
    const v = fixture(true);
    v.options.now = () => currentTime.toISOString() as unknown as Date;
    const repository = createReceivingNominationRepository(v.db, v.options);
    await expect(
      repository.reserveNomination(v.snapshot, v.authorize, v.authorization),
    ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
    expect(v.tables.accounts).toHaveLength(0);
  });
  it.each(["operatorReference", "webhookTokenHash"])(
    "rejects a candidate with a stored provider marker %s",
    async (field) => {
      const v = fixture();
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      );
      v.tables.accounts[0][field] =
        field === "webhookTokenHash" ? "a".repeat(64) : "provider-operator";
      await expect(
        v.repository.reserveNomination(
          v.snapshot,
          v.authorize,
          v.authorization,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "RECEIVING_BINDING_EXISTS",
      });
      expect(
        v.queries.some(
          (q) =>
            /a\.operator_reference IS NOT NULL/.test(q.sql) &&
            /a\.webhook_token_hash IS NOT NULL/.test(q.sql),
        ),
      ).toBe(true);
    },
  );
  it("locks the user before the session to match account revocation order", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    const userLock = v.queries.findIndex((q) =>
      /FROM "user" u[\s\S]*FOR SHARE OF u/.test(q.sql),
    );
    const sessionLock = v.queries.findIndex((q) =>
      /FROM "session" se[\s\S]*FOR SHARE OF se/.test(q.sql),
    );
    expect(userLock).toBeGreaterThan(-1);
    expect(sessionLock).toBeGreaterThan(userLock);
  });
  it.each(["foreign-operator", "self-new-request", "provider-binding"])(
    "never substitutes an existing receiving candidate: %s",
    async (variant) => {
      const v = fixture();
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      );
      if (variant === "foreign-operator")
        v.tables.accounts[0].operatorUserId = "another-user";
      if (variant === "provider-binding")
        v.tables.accounts[0].accountReference = "provider-account";
      let next = v.snapshot;
      if (variant === "self-new-request")
        next = {
          ...v.snapshot,
          requestId: "request-two",
          accountId: "account-two",
          operationId: "operation-two",
          requestHash: createHash("sha256")
            .update(
              JSON.stringify([
                "receiving.self-nomination.v1",
                "site-one",
                "request-two",
                "user-one",
                "sandbox",
                "intent-v1",
                true,
              ]),
              "utf8",
            )
            .digest("hex"),
        };
      await expect(
        v.repository.reserveNomination(next, v.authorize, v.authorization),
      ).rejects.toMatchObject({ status: 409 });
      expect(v.tables.accounts).toHaveLength(1);
      expect(v.tables.operations).toHaveLength(1);
    },
  );
  it.each(["hash", "snapshot", "account", "operation-state"])(
    "fails closed on inconsistent persisted intent %s",
    async (variant) => {
      const v = fixture();
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      );
      if (variant === "hash")
        v.tables.operations[0].requestHash = "a".repeat(64);
      if (variant === "snapshot")
        v.tables.operations[0].requestSnapshot = {
          ...v.snapshot,
          providerAccount: "private",
        };
      if (variant === "account")
        v.tables.operations[0].accountId = "another-account";
      if (variant === "operation-state")
        v.tables.operations[0].state = "UNKNOWN";
      await expect(
        v.repository.findByRequest("site-one", v.snapshot.requestId),
      ).rejects.toMatchObject({
        status: variant === "operation-state" ? 409 : 503,
      });
    },
  );
  it("does not expose a cross-request intent or fake a missing one", async () => {
    const v = fixture();
    expect(
      await v.repository.findByRequest("site-one", v.snapshot.requestId),
    ).toBeNull();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    expect(
      await v.repository.findByRequest("site-one", "request-two"),
    ).toBeNull();
    expect(
      await v.repository.findByRequest("site-one", v.snapshot.requestId),
    ).toEqual(v.snapshot);
  });
  it.each(["session", "subject", "provenance", "unverified", "expired"])(
    "rejects false current proof before writing %s",
    async (variant) => {
      const v = fixture();
      if (variant === "session")
        v.authorization.recentAuth.sessionId = "other-session";
      if (variant === "subject") v.authorization.actor.userId = "other-user";
      if (variant === "provenance")
        v.authorization.recentAuth.provenance = "client" as never;
      if (variant === "unverified")
        v.authorization.recentAuth.verification = "unverified";
      if (variant === "expired")
        v.authorization.recentAuth.expiresAt = currentTime;
      await expect(
        v.repository.reserveNomination(
          v.snapshot,
          v.authorize,
          v.authorization,
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(v.tables.accounts).toHaveLength(0);
    },
  );
  it("rolls back when proof expires during asynchronous inserts", async () => {
    const v = fixture();
    v.state.expireAfterInsert = true;
    await expect(
      v.repository.reserveNomination(v.snapshot, v.authorize, v.authorization),
    ).rejects.toMatchObject({ status: 403 });
    expect(v.tables.accounts).toHaveLength(0);
    expect(v.tables.operations).toHaveLength(0);
  });
  it("commits only an unverified local candidate and account-create intent", async () => {
    const v = fixture();
    const result = await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    expect(result).toEqual(v.snapshot);
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.accounts[0]).toMatchObject({
      id: "account-one",
      operatorUserId: "user-one",
      provider: "ASAAS",
      environment: "sandbox",
      providerAccountState: "UNVERIFIED",
      isCurrent: true,
      receivingCapability: false,
      withdrawalCapability: false,
      commercialEnabled: false,
    });
    expect(v.tables.accounts[0].accountReference).toBeNull();
    expect(v.tables.accounts[0].credentialVersion).toBeNull();
    expect(v.tables.operations[0]).toMatchObject({
      kind: "ACCOUNT_CREATE",
      state: "REQUESTED",
      attempts: 0,
      requestHash: v.snapshot.requestHash,
      requestSnapshot: v.snapshot,
    });
    expect(v.authorize).toHaveBeenCalledOnce();
    expect(v.queries.at(-1)?.sql).toBe("commit");
  });
  it("revalidates a new current session while preserving the original replay audit", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.state.sessionId = "session-two";
    v.state.clock = new Date("2026-10-12T18:21:00.000Z");
    v.authorization.actor.sessionId = "session-two";
    v.authorization.recentAuth.sessionId = "session-two";
    const result = await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    expect(result.authentication.sessionId).toBe("session-one");
    expect(v.authorize.mock.lastCall?.[0]).toMatchObject({
      currentSession: { sessionId: "session-two" },
    });
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.operations).toHaveLength(1);
  });
  it.each(["revoked", "assistant", "owner", "disabled", "expired", "idle"])(
    "denies current auth even if the callback allows it: %s",
    async (variant) => {
      const v = fixture();
      if (variant === "revoked") v.state.revokedAt = currentTime;
      if (variant === "assistant") v.state.membershipRole = "SITE_ASSISTANT";
      if (variant === "owner") v.state.userRole = "OWNER";
      if (variant === "disabled") v.state.userState = "DISABLED";
      if (variant === "expired") v.state.sessionExpiresAt = currentTime;
      if (variant === "idle")
        v.state.lastActiveAt = new Date("2026-10-11T18:20:00.000Z");
      await expect(
        v.repository.reserveNomination(
          v.snapshot,
          v.authorize,
          v.authorization,
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(v.tables.accounts).toHaveLength(0);
      expect(v.tables.operations).toHaveLength(0);
    },
  );
  it("rolls back candidate insertion when the intent cannot commit", async () => {
    const v = fixture();
    v.state.failOperation = true;
    await expect(
      v.repository.reserveNomination(v.snapshot, v.authorize, v.authorization),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.tables.accounts).toHaveLength(0);
    expect(v.tables.operations).toHaveLength(0);
  });
  it("keeps a committed nomination after lost acknowledgment and recovers without duplicate intent", async () => {
    const v = fixture();
    v.state.commitLost = true;
    await expect(
      v.repository.reserveNomination(v.snapshot, v.authorize, v.authorization),
    ).rejects.toMatchObject({ status: 503 });
    v.state.commitLost = false;
    expect(
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      ),
    ).toEqual(v.snapshot);
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.operations).toHaveLength(1);
  });
  it("writes nothing if locked authorization rejects", async () => {
    const v = fixture();
    v.authorize.mockRejectedValue(new Error("private proof"));
    const e = await v.repository
      .reserveNomination(v.snapshot, v.authorize, v.authorization)
      .catch((e) => e);
    expect(e.status).toBe(503);
    expect(e.message).not.toContain("private");
    expect(v.tables.accounts).toHaveLength(0);
  });
  it("checks actual database proof time again after asynchronous authorization", async () => {
    const v = fixture();
    v.authorize.mockImplementation(async () => {
      v.state.clock = new Date("2026-10-12T18:24:30.000Z");
    });
    await expect(
      v.repository.reserveNomination(v.snapshot, v.authorize, v.authorization),
    ).rejects.toMatchObject({ status: 403 });
    expect(v.tables.accounts).toHaveLength(0);
  });
});

function withRequest(
  snapshot: ReceivingNominationSnapshot,
  requestId: string,
): ReceivingNominationSnapshot {
  return {
    ...snapshot,
    requestId,
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          snapshot.siteId,
          requestId,
          snapshot.operatorUserId,
          snapshot.environment,
          snapshot.policyVersion,
          true,
        ]),
        "utf8",
      )
      .digest("hex"),
  };
}
function scope(v: ReturnType<typeof fixture>) {
  return {
    siteId: v.snapshot.siteId,
    operatorUserId: v.snapshot.operatorUserId,
    environment: v.snapshot.environment,
  };
}
describe("authoritative nomination scope recovery", () => {
  it("returns null only for a proved empty existing site/environment snapshot", async () => {
    const v = fixture();
    expect(await v.repository.readNominationScope(scope(v))).toBeNull();
    expect(v.queries[0].sql).toMatch(
      /begin isolation level repeatable read read only/i,
    );
    expect(v.queries.filter((q) => /^SELECT/i.test(q.sql))).toHaveLength(2);
    expect(v.queries.at(-1)?.sql).toBe("commit");
    expect(
      v.queries.every(
        (q) =>
          !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE)/i.test(
            q.sql,
          ),
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    "recovers the original candidate using driver timestamp mode %s without writes",
    async (raw) => {
      const v = fixture(raw);
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      );
      v.queries.length = 0;
      expect(await v.repository.readNominationScope(scope(v))).toEqual(
        v.snapshot,
      );
      expect(
        v.queries.every(
          (q) =>
            !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE)/i.test(
              q.sql,
            ),
        ),
      ).toBe(true);
      const query = v.queries.find((q) => /FULL OUTER JOIN/.test(q.sql));
      expect(query?.sql).toContain('"financial_operation"');
      expect(query?.sql.split("WHERE")[1]).not.toMatch(
        /operator_user_id|is_current|kind/,
      );
    },
  );
  it("returns a valid legacy arbitrary request as the original identity", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    const legacy = withRequest(v.snapshot, "legacy.request:one");
    Object.assign(v.tables.operations[0], {
      requestId: legacy.requestId,
      requestHash: legacy.requestHash,
      requestSnapshot: legacy,
    });
    expect(await v.repository.readNominationScope(scope(v))).toEqual(legacy);
  });
  it.each([
    "operatorReference",
    "webhookTokenHash",
    "accountReference",
    "recipientReference",
    "credentialVersion",
    "credentialKeyId",
    "credentialNonce",
    "credentialCiphertext",
    "credentialTag",
    "observedAt",
    "providerAccountState",
    "receivingCapability",
    "withdrawalCapability",
    "commercialEnabled",
  ])("does not treat provider marker %s as empty", async (field) => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.tables.accounts[0][field] =
      field.endsWith("Capability") || field === "commercialEnabled"
        ? true
        : field === "observedAt"
          ? currentTime
          : "provider-bound";
    await expect(
      v.repository.readNominationScope(scope(v)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each([
    "foreign-operator",
    "noncurrent",
    "unsupported-provider",
    "multiple-accounts",
    "multiple-operations",
    "orphan-account",
    "orphan-operation",
    "other-operation-kind",
    "operation-state",
    "attempted",
    "lease",
    "provider-reference",
    "hash",
    "snapshot",
    "target",
  ])("fails closed instead of erasing %s", async (variant) => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    const a = v.tables.accounts[0],
      op = v.tables.operations[0];
    if (variant === "foreign-operator") a.operatorUserId = "other-user";
    if (variant === "noncurrent") a.isCurrent = false;
    if (variant === "unsupported-provider") a.provider = "OTHER";
    if (variant === "multiple-accounts")
      v.tables.accounts.push({ ...a, id: "history-account", isCurrent: false });
    if (variant === "multiple-operations")
      v.tables.operations.push({ ...op, id: "history-operation" });
    if (variant === "orphan-account") v.tables.operations.length = 0;
    if (variant === "orphan-operation") v.tables.accounts.length = 0;
    if (variant === "other-operation-kind") op.kind = "WITHDRAWAL";
    if (variant === "operation-state") op.state = "UNKNOWN";
    if (variant === "attempted") op.attempts = 1;
    if (variant === "lease") op.leaseToken = "old-lease";
    if (variant === "provider-reference")
      op.providerOperationReference = "remote-created";
    if (variant === "hash") op.requestHash = "a".repeat(64);
    if (variant === "snapshot")
      op.requestSnapshot = { ...v.snapshot, extra: "private" };
    if (variant === "target") op.orderId = "unexpected-order";
    await expect(
      v.repository.readNominationScope(scope(v)),
    ).rejects.toHaveProperty("status");
  });
  it.each([
    "account-created",
    "account-updated",
    "operation-created",
    "operation-updated",
    "next-attempt",
  ])(
    "rejects %s one microsecond away from the immutable creation timestamp",
    async (field) => {
      const v = fixture(true);
      await v.repository.reserveNomination(
        v.snapshot,
        v.authorize,
        v.authorization,
      );
      const target = field.startsWith("account")
        ? v.tables.accounts[0]
        : v.tables.operations[0];
      target[
        field === "next-attempt"
          ? "nextAttemptAt"
          : field.endsWith("created")
            ? "createdAt"
            : "updatedAt"
      ] = "2026-10-12 18:20:00.000001+00";
      v.state.clock = new Date("2026-10-12T18:20:01.000Z");
      await expect(
        v.repository.readNominationScope(scope(v)),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
  it("ignores facts from another site/environment while proving the exact scope", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.tables.accounts.push({
      ...v.tables.accounts[0],
      id: "other-account",
      siteId: "other-site",
      environment: "live",
    });
    v.tables.operations.push({
      ...v.tables.operations[0],
      id: "other-operation",
      accountId: "other-account",
      siteId: "other-site",
      environment: "live",
    });
    expect(await v.repository.readNominationScope(scope(v))).toEqual(
      v.snapshot,
    );
  });
  it("does not turn an unknown site or invalid scope into empty success", async () => {
    const v = fixture();
    v.state.sitePresent = false;
    await expect(
      v.repository.readNominationScope(scope(v)),
    ).rejects.toMatchObject({ status: 503 });
    v.queries.length = 0;
    await expect(
      v.repository.readNominationScope({ ...scope(v), siteId: "site.one" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.queries).toHaveLength(0);
  });
  it("does not accept mismatched mode or additional scope fields", async () => {
    const v = fixture();
    await expect(
      v.repository.readNominationScope({ ...scope(v), environment: "live" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      v.repository.readNominationScope({
        ...scope(v),
        extra: "untrusted",
      } as never),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.queries).toHaveLength(0);
  });
  it("sanitizes read failures and preserves stored intent", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.state.failRead = true;
    const error = await v.repository
      .readNominationScope(scope(v))
      .catch((e) => e);
    expect(error).toMatchObject({
      status: 503,
      message: "Receiving nomination cannot be recorded",
    });
    expect(error.message).not.toContain("private");
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.operations).toHaveLength(1);
  });
  it("reads the original immutable audit after its proof expires without requiring nomination activity", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.state.clock = new Date("2026-10-12T20:00:00.000Z");
    v.authorize.mockClear();
    expect(await v.repository.readNominationScope(scope(v))).toEqual(
      v.snapshot,
    );
    expect(v.authorize).not.toHaveBeenCalled();
  });
  it("keeps the injected read clock Date-only and copies the scope before awaiting", async () => {
    const v = fixture();
    const selected = scope(v);
    const pending = v.repository.readNominationScope(selected);
    selected.operatorUserId = "other-user";
    expect(await pending).toBeNull();
    v.options.now = () => currentTime.toISOString() as unknown as Date;
    const repository = createReceivingNominationRepository(v.db, v.options);
    v.queries.length = 0;
    await expect(
      repository.readNominationScope(scope(v)),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.queries).toHaveLength(0);
  });
  it("does not claim a successful read after a lost commit acknowledgement", async () => {
    const v = fixture();
    await v.repository.reserveNomination(
      v.snapshot,
      v.authorize,
      v.authorization,
    );
    v.state.commitLost = true;
    await expect(
      v.repository.readNominationScope(scope(v)),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.tables.accounts).toHaveLength(1);
    expect(v.tables.operations).toHaveLength(1);
  });
});

describe("transaction-bound independent NEW admission", () => {
  it("denies authoritative NEW without a captured authority and independent custody lock port", async () => {
    const values = fixture();
    const { admission: _admission, ...legacyOptions } = values.options;
    const repository = createReceivingNominationRepository(
      values.db,
      legacyOptions,
    );
    await expect(
      repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "RECEIVING_NOMINATION_UNAVAILABLE",
    });
    expect(values.tables.accounts).toHaveLength(0);
    expect(values.tables.operations).toHaveLength(0);
    expect(values.queries.some((entry) => /^insert/i.test(entry.sql))).toBe(
      false,
    );
  });
});

function deferredAdmission() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
async function repositoryTick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("locked original custody invariants", () => {
  it("locks independently stored custody through actual COMMIT and blocks substitution", async () => {
    const values = fixture();
    const pending = deferredAdmission();
    values.custody.beforeCommit = () => pending.promise;
    let settled = false;
    const action = values.repository
      .reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      )
      .finally(() => {
        settled = true;
      });
    await repositoryTick();
    try {
      expect(values.lockAuthority).toHaveBeenCalledOnce();
      expect(values.lockAuthority.mock.calls[0][0]).toBe(
        values.custody.transaction,
      );
      expect(values.custody.locked).toBe(true);
      expect(values.custody.mutate({ holderUserId: "planner" })).toBe(false);
      expect(settled).toBe(false);
      expect(values.tables.operations).toHaveLength(1);
    } finally {
      pending.resolve();
      await action.catch(() => {});
    }
    expect(await action).toEqual(values.snapshot);
    expect(values.custody.events).toEqual(["lock", "commit-locked"]);
    expect(values.custody.locked).toBe(false);
  });
  it.each([
    "revoked",
    "holder",
    "authority",
    "authority-version",
    "consent",
    "consent-version",
    "custody",
    "custody-version",
    "issuer",
    "disclosure",
    "expiry",
  ])(
    "rejects %s substitution in the independent transaction read",
    async (variant) => {
      const values = fixture();
      values.custody.beforeLockedRead = async () => {
        if (variant === "revoked") values.custody.authority = null;
        else {
          const fields = {
            holder: "holderUserId",
            authority: "authorityId",
            "authority-version": "authorityVersion",
            consent: "consentId",
            "consent-version": "consentVersion",
            custody: "custodyId",
            "custody-version": "custodyVersion",
            issuer: "issuerId",
            disclosure: "disclosureId",
            expiry: "expiresAt",
          } as const;
          const field = fields[variant as keyof typeof fields];
          values.custody.mutate({
            [field]:
              variant === "expiry" ? "2026-10-12T18:24:00.000Z" : "foreign",
          });
        }
      };
      await expect(
        values.repository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
        ),
      ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
      expect(values.tables.accounts).toHaveLength(0);
      expect(values.tables.operations).toHaveLength(0);
      expect(values.queries.some((entry) => /^insert/i.test(entry.sql))).toBe(
        false,
      );
      expect(values.queries.at(-1)?.sql).toBe("rollback");
    },
  );
  it.each([
    "site",
    "account",
    "operation",
    "request",
    "hash",
    "environment",
    "input",
    "policy",
    "session",
    "server-environment",
  ])(
    "rejects a captured frame for another %s before custody activation",
    async (variant) => {
      const values = fixture();
      const frame = structuredClone(values.frame);
      if (variant === "site")
        Object.assign(frame.context.draft, { siteId: "foreign" });
      if (variant === "account")
        Object.assign(frame.context.draft, { accountId: "foreign" });
      if (variant === "operation")
        Object.assign(frame.context.draft, { operationId: "foreign" });
      if (variant === "request")
        Object.assign(frame.context.draft, { requestId: "foreign" });
      if (variant === "hash")
        Object.assign(frame.context.draft, { requestHash: "0".repeat(64) });
      if (variant === "environment")
        Object.assign(frame.context.draft, { environment: "live" });
      if (variant === "input")
        Object.assign(frame.context.input, { confirmSelfAsRecipient: false });
      if (variant === "policy")
        Object.assign(frame.context.draft, { policyVersion: "foreign" });
      if (variant === "session")
        Object.assign(frame.context.actor, { sessionId: "foreign" });
      if (variant === "server-environment")
        Object.assign(frame.context, { applicationEnvironment: "production" });
      Object.assign(frame.authority, {
        context: structuredClone(frame.context),
      });
      await expect(
        values.rawRepository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
          frame,
        ),
      ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
      expect(values.lockAuthority).not.toHaveBeenCalled();
      expect(values.tables.accounts).toHaveLength(0);
      expect(values.tables.operations).toHaveLength(0);
    },
  );
  it.each(["locked-read", "precommit"])(
    "rejects authority expiry after %s and rolls back all inserts",
    async (stage) => {
      const values = fixture();
      Object.assign(values.custody.authority!, {
        expiresAt: "2026-10-12T18:20:01.000Z",
      });
      Object.assign(values.frame.authority, {
        expiresAt: "2026-10-12T18:20:01.000Z",
      });
      const expire = () => {
        values.state.clock = new Date("2026-10-12T18:20:01.000Z");
      };
      if (stage === "locked-read")
        values.custody.beforeLockedRead = async () => {
          expire();
        };
      else {
        let inserted = 0;
        values.custody.afterInsert = () => {
          if (++inserted === 2) expire();
        };
      }
      await expect(
        values.repository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
        ),
      ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
      expect(values.tables.accounts).toHaveLength(0);
      expect(values.tables.operations).toHaveLength(0);
      expect(values.custody.locked).toBe(false);
      expect(values.custody.events).toEqual(["lock", "rollback-locked"]);
      expect(
        values.queries.filter((entry) => /^insert/i.test(entry.sql)),
      ).toHaveLength(stage === "precommit" ? 2 : 0);
    },
  );
  it.each(["proof-expiry", "clock-rewind"])(
    "rechecks %s after a pending independent locked read",
    async (variant) => {
      const values = fixture();
      const pending = deferredAdmission();
      values.custody.beforeLockedRead = () => pending.promise;
      const action = values.repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      );
      await repositoryTick();
      values.state.clock = new Date(
        variant === "proof-expiry"
          ? "2026-10-12T18:24:30.000Z"
          : "2026-10-12T18:19:59.999Z",
      );
      pending.resolve();
      await expect(action).rejects.toMatchObject({
        code:
          variant === "proof-expiry"
            ? "RECENT_AUTH_REQUIRED"
            : "RECEIVING_NOMINATION_UNAVAILABLE",
      });
      expect(values.tables.accounts).toHaveLength(0);
      expect(values.tables.operations).toHaveLength(0);
    },
  );
  it("captures the original frame, actor proof and lock callable before transaction callbacks mutate them", async () => {
    const values = fixture();
    const substitute = vi.fn().mockResolvedValue(null);
    values.authorize.mockImplementation(async () => {
      Object.assign(values.snapshot, { accountId: "foreign" });
      Object.assign(values.authorization.actor, { sessionId: "foreign" });
      values.authorization.recentAuth.expiresAt!.setTime(0);
      Object.assign(values.frame.authority, { holderUserId: "foreign" });
      Object.assign(values.options.admission, {
        issuerId: "foreign",
        lockAuthority: substitute,
      });
    });
    const result = await values.repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
    );
    expect(result).toEqual(values.custody.authority!.context.draft);
    expect(values.lockAuthority).toHaveBeenCalledOnce();
    expect(substitute).not.toHaveBeenCalled();
  });
  it("retains pending lock ownership despite hostile metadata and reentrant frame mutation", async () => {
    const values = fixture();
    const pending = deferredAdmission();
    const metadata = vi.fn(() => {
      throw new Error("metadata is not settlement");
    });
    Object.defineProperty(pending.promise, "status", { get: metadata });
    values.custody.beforeLockedRead = () => pending.promise;
    let settled = false;
    const action = values.repository
      .reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      )
      .finally(() => {
        settled = true;
      });
    await repositoryTick();
    try {
      expect(values.lockAuthority).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(values.tables.accounts).toHaveLength(0);
      Object.assign(values.frame.authority, { consentId: "foreign" });
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await action.catch(() => {});
    }
    expect(await action).toEqual(values.custody.authority!.context.draft);
    expect(values.custody.events).toEqual(["lock", "commit-locked"]);
  });
  it("keeps exact winner replay without adapters, including an expired original audit and fresh actor proof", async () => {
    const values = fixture();
    const original = await values.repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
    );
    values.state.clock = new Date("2026-10-12T18:30:00.000Z");
    values.state.lastActiveAt = new Date(values.state.clock);
    values.authorization.recentAuth.authenticatedAt = new Date(
      "2026-10-12T18:29:30.000Z",
    );
    values.authorization.recentAuth.expiresAt = new Date(
      "2026-10-12T18:34:30.000Z",
    );
    const { admission: _admission, ...legacyOptions } = values.options;
    const repository = createReceivingNominationRepository(
      values.db,
      legacyOptions,
    );
    values.lockAuthority.mockClear();
    expect(
      await repository.reserveNomination(
        original,
        values.authorize,
        values.authorization,
      ),
    ).toEqual(original);
    expect(values.lockAuthority).not.toHaveBeenCalled();
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
  });
  it("does not adopt an original winner under a different generated draft's authority", async () => {
    const values = fixture();
    await values.repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
    );
    const other = {
      ...values.snapshot,
      accountId: "other-account",
      operationId: "other-operation",
    };
    const frame = structuredClone(values.frame);
    Object.assign(frame.context.draft, other);
    Object.assign(frame.authority, { context: structuredClone(frame.context) });
    values.lockAuthority.mockClear();
    await expect(
      values.rawRepository.reserveNomination(
        other,
        values.authorize,
        values.authorization,
        frame,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
    expect(values.lockAuthority).not.toHaveBeenCalled();
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
  });
  it("recovers lost acknowledgment with the exact committed original and no NEW adapter", async () => {
    const values = fixture();
    values.state.commitLost = true;
    await expect(
      values.repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
    values.state.commitLost = false;
    const { admission: _admission, ...legacyOptions } = values.options;
    const repository = createReceivingNominationRepository(
      values.db,
      legacyOptions,
    );
    values.lockAuthority.mockClear();
    expect(
      await repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).toEqual(values.snapshot);
    expect(values.lockAuthority).not.toHaveBeenCalled();
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(values.custody.events[1]).toBe("commit-locked");
  });
  it("rejects a configuration getter before any callback executes", () => {
    const values = fixture();
    const getter = vi.fn(() => "sandbox");
    Object.defineProperty(values.options, "mode", { get: getter });
    expect(() =>
      createReceivingNominationRepository(values.db, values.options),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(values.lockAuthority).not.toHaveBeenCalled();
  });
});

describe("original transaction callable capture", () => {
  it("uses captured transaction callables after a reentrant custody callback replaces the methods", async () => {
    const values = fixture();
    const original = values.lockAuthority.getMockImplementation()!;
    const substitute = vi.fn().mockResolvedValue({ rows: [] });
    values.lockAuthority.mockImplementation(
      async (transaction, context, authority) => {
        const result = await original(transaction, context, authority);
        Object.assign(transaction as object, { execute: substitute });
        return result;
      },
    );
    await expect(
      values.repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
    expect(substitute).not.toHaveBeenCalled();
    expect(values.tables.accounts).toHaveLength(0);
    expect(values.tables.operations).toHaveLength(0);
    expect(values.custody.events).toEqual(["lock", "rollback-locked"]);
    expect(values.queries.at(-1)?.sql).toBe("rollback");
  });
});

describe("native backend proof and final acknowledgment", () => {
  it.each(["proof", "clock"])(
    "captures native %s Date scalars without invoking shadowed getTime",
    async (variant) => {
      const values = fixture();
      const getter = vi.fn(() => {
        throw new Error("shadowed native date");
      });
      if (variant === "proof")
        Object.defineProperty(
          values.authorization.recentAuth.authenticatedAt!,
          "getTime",
          { value: getter },
        );
      else {
        const clock = new Date(currentTime);
        Object.defineProperty(clock, "getTime", { value: getter });
        values.options.now = () => clock;
      }
      const repository = createReceivingNominationRepository(
        values.db,
        values.options,
      );
      expect(
        await repository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
          values.frame,
        ),
      ).toEqual(values.snapshot);
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("waits for pending native COMMIT then refuses expired acknowledgment without claiming rollback", async () => {
    const values = fixture();
    Object.assign(values.custody.authority!, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    Object.assign(values.frame.authority, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    const pending = deferredAdmission();
    values.custody.beforeCommit = () => pending.promise;
    const action = values.repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
    );
    await repositoryTick();
    values.state.clock = new Date("2026-10-12T18:20:01.000Z");
    pending.resolve();
    await expect(action).rejects.toMatchObject({
      code: "RECEIVING_NOMINATION_UNAVAILABLE",
    });
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(values.custody.events).toEqual(["lock", "commit-locked"]);
    const { admission: _admission, ...legacyOptions } = values.options;
    expect(
      await createReceivingNominationRepository(
        values.db,
        legacyOptions,
      ).reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).toEqual(values.snapshot);
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
  });
  it.each(["missing-frame", "missing-lock"])(
    "denies authoritative NEW with %s before inserts",
    async (variant) => {
      const values = fixture();
      const { admission: _admission, ...legacyOptions } = values.options;
      const repository =
        variant === "missing-lock"
          ? createReceivingNominationRepository(values.db, legacyOptions)
          : values.rawRepository;
      await expect(
        repository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
          variant === "missing-frame" ? undefined : values.frame,
        ),
      ).rejects.toMatchObject({ code: "RECEIVING_NOMINATION_UNAVAILABLE" });
      expect(values.tables.accounts).toHaveLength(0);
      expect(values.tables.operations).toHaveLength(0);
      expect(values.lockAuthority).not.toHaveBeenCalled();
    },
  );
});

describe("optional private custody preserves authoritative replay", () => {
  it.each(["missing-callable", "missing-policy", "accessor-policy"])(
    "keeps exact known replay when private NEW configuration has %s",
    async (variant) => {
      const values = fixture();
      await values.repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
      );
      const configuration: Record<string, unknown> =
        variant === "missing-policy"
          ? { lockAuthority: values.lockAuthority }
          : {
              issuerId: "fixture-issuer",
              issuerVersion: "issuer-v1",
              disclosureId: "fixture-disclosure",
              disclosureVersion: "disclosure-v1",
            };
      const getter = vi.fn(() => "fixture-issuer");
      if (variant === "accessor-policy")
        Object.defineProperty(configuration, "issuerId", { get: getter });
      Object.assign(values.options, { admission: configuration });
      const repository = createReceivingNominationRepository(
        values.db,
        values.options,
      );
      values.lockAuthority.mockClear();
      expect(
        await repository.reserveNomination(
          values.snapshot,
          values.authorize,
          values.authorization,
        ),
      ).toEqual(values.snapshot);
      expect(values.lockAuthority).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    },
  );
});

const repositorySettlementThen = Promise.prototype.then;
function originalRepositoryGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  const state = { settled: false };
  const observed = Reflect.apply(repositorySettlementThen, promise, [
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  ]) as Promise<void>;
  return { promise, resolve, reject, state, observed };
}
function poisonRepositoryConstructor(promise: Promise<unknown>) {
  let accesses = 0;
  const getter = () => {
    accesses++;
    throw new Error("private native constructor metadata");
  };
  Object.defineProperty(promise, "constructor", { get: getter });
  return {
    accesses: () => accesses,
    descriptor: Object.getOwnPropertyDescriptor(promise, "constructor"),
  };
}
function observeRepositoryOutcome(action: Promise<unknown>) {
  const state = { settled: false, error: null as unknown };
  Reflect.apply(repositorySettlementThen, action, [
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  ]);
  return state;
}

describe("genuine native custody and transaction settlement", () => {
  it("keeps the actual transaction and authority lock owned while the exact native custody promise is unobservable", async () => {
    const values = fixture();
    const gate = originalRepositoryGate<unknown>();
    const decoration = poisonRepositoryConstructor(gate.promise);
    let delivered: Promise<unknown> | null = null;
    let lockCalls = 0;
    let actualTransaction: unknown = null;
    Object.assign(values.options.admission, {
      lockAuthority: (transaction: unknown) => {
        lockCalls++;
        actualTransaction = transaction;
        values.custody.transaction = transaction;
        values.custody.locked = true;
        values.custody.events.push("lock");
        delivered = gate.promise;
        return gate.promise;
      },
    });
    const repository = createReceivingNominationRepository(
      values.db,
      values.options,
    );
    const action = repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.frame,
    );
    const outcome = observeRepositoryOutcome(action);
    await repositoryTick();
    try {
      expect(lockCalls).toBe(1);
      expect(delivered).toBe(gate.promise);
      expect(actualTransaction).toBe(values.custody.transaction);
      expect(gate.state.settled).toBe(false);
      expect(decoration.accesses()).toBeGreaterThan(0);
      expect(outcome.settled).toBe(false);
      expect(values.custody.locked).toBe(true);
      expect(values.custody.mutate({ consentId: "foreign" })).toBe(false);
      expect(
        values.queries.some((entry) => /^(commit|rollback)/i.test(entry.sql)),
      ).toBe(false);
      expect(values.tables.accounts).toHaveLength(0);
    } finally {
      gate.resolve(structuredClone(values.custody.authority));
      await gate.observed;
    }
    await repositoryTick();
    expect(gate.state.settled).toBe(true);
    expect(outcome.settled).toBe(false);
    expect(values.custody.locked).toBe(true);
    expect(
      values.queries.some((entry) => /^(commit|rollback)/i.test(entry.sql)),
    ).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(gate.promise, "constructor"),
    ).toEqual(decoration.descriptor);
    // The unobservable synthetic transaction remains held; no finite drain is claimed.
  });
  it.each(["commit", "rollback"] as const)(
    "waits for original native %s despite decorated outer transaction metadata",
    async (settlement) => {
      const values = fixture();
      const gate = originalRepositoryGate<void>();
      if (settlement === "commit")
        values.custody.beforeCommit = () => gate.promise;
      else {
        values.state.failOperation = true;
        values.custody.beforeRollback = () => gate.promise;
      }
      const nativeTransaction = values.db.transaction.bind(values.db);
      let calls = 0;
      let delivered: Promise<unknown> | null = null;
      let originalSettled = false;
      let decoration: ReturnType<typeof poisonRepositoryConstructor> | null =
        null;
      let nativeObserved: Promise<void> | null = null;
      Object.assign(values.db, {
        transaction: (...args: Parameters<typeof nativeTransaction>) => {
          calls++;
          const operation = nativeTransaction(...args);
          nativeObserved = Reflect.apply(repositorySettlementThen, operation, [
            () => {
              originalSettled = true;
            },
            () => {
              originalSettled = true;
            },
          ]) as Promise<void>;
          decoration = poisonRepositoryConstructor(operation);
          delivered = operation;
          return operation;
        },
      });
      const repository = createReceivingNominationRepository(
        values.db,
        values.options,
      );
      const action = repository.reserveNomination(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.frame,
      );
      const outcome = observeRepositoryOutcome(action);
      await repositoryTick();
      try {
        expect(calls).toBe(1);
        expect(delivered).not.toBeNull();
        expect(decoration!.accesses()).toBeGreaterThan(0);
        expect(originalSettled).toBe(false);
        expect(values.custody.locked).toBe(true);
        expect(values.queries.at(-1)?.sql).toBe(settlement);
        expect(outcome.settled).toBe(false);
      } finally {
        gate.resolve();
        await gate.observed;
        if (nativeObserved) await nativeObserved;
      }
      await repositoryTick();
      expect(originalSettled).toBe(true);
      expect(outcome.settled).toBe(false);
      expect(values.custody.locked).toBe(false);
      expect(values.queries.at(-1)?.sql).toBe(settlement);
      expect(values.tables.accounts).toHaveLength(
        settlement === "commit" ? 1 : 0,
      );
      expect(values.tables.operations).toHaveLength(
        settlement === "commit" ? 1 : 0,
      );
      expect(
        Object.getOwnPropertyDescriptor(delivered!, "constructor"),
      ).toEqual(decoration!.descriptor);
    },
  );
});

function poisonRepositoryThen(promise: Promise<unknown>) {
  let accesses = 0;
  Object.defineProperty(promise, "constructor", { value: undefined });
  // biome-ignore lint/suspicious/noThenProperty: The own then getter is the exact hostile native promise fixture under test.
  Object.defineProperty(promise, "then", {
    get: () => {
      accesses++;
      throw new Error("private poisoned then");
    },
  });
  return { accesses: () => accesses };
}
describe("expiry after genuine observable transaction work", () => {
  it("waits for native custody completion before denying expiry and genuinely rolling back", async () => {
    const values = fixture();
    Object.assign(values.custody.authority!, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    Object.assign(values.frame.authority, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    const gate = originalRepositoryGate<unknown>();
    const decoration = poisonRepositoryThen(gate.promise);
    let delivered: Promise<unknown> | null = null;
    Object.assign(values.options.admission, {
      lockAuthority: (transaction: unknown) => {
        values.custody.transaction = transaction;
        values.custody.locked = true;
        values.custody.events.push("lock");
        delivered = gate.promise;
        return gate.promise;
      },
    });
    const repository = createReceivingNominationRepository(
      values.db,
      values.options,
    );
    const action = repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.frame,
    );
    const outcome = observeRepositoryOutcome(action);
    await repositoryTick();
    values.state.clock = new Date("2026-10-12T18:20:01.000Z");
    expect(delivered).toBe(gate.promise);
    expect(gate.state.settled).toBe(false);
    expect(outcome.settled).toBe(false);
    expect(values.custody.locked).toBe(true);
    expect(
      values.queries.some((entry) => /^(commit|rollback)/i.test(entry.sql)),
    ).toBe(false);
    gate.resolve(structuredClone(values.custody.authority));
    await gate.observed;
    await expect(action).rejects.toMatchObject({
      code: "RECEIVING_NOMINATION_UNAVAILABLE",
    });
    expect(values.custody.events).toEqual(["lock", "rollback-locked"]);
    expect(values.tables.accounts).toHaveLength(0);
    expect(values.tables.operations).toHaveLength(0);
    expect(decoration.accesses()).toBe(0);
  });
  it("waits for genuine COMMIT before unavailable expiry acknowledgment and exact recovery", async () => {
    const values = fixture();
    Object.assign(values.custody.authority!, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    Object.assign(values.frame.authority, {
      expiresAt: "2026-10-12T18:20:01.000Z",
    });
    const gate = originalRepositoryGate<void>();
    values.custody.beforeCommit = () => gate.promise;
    const nativeTransaction = values.db.transaction.bind(values.db);
    let delivered: Promise<unknown> | null = null;
    let originalSettled = false;
    const decorations: Array<ReturnType<typeof poisonRepositoryThen>> = [];
    Object.assign(values.db, {
      transaction: (...args: Parameters<typeof nativeTransaction>) => {
        const operation = nativeTransaction(...args);
        Reflect.apply(repositorySettlementThen, operation, [
          () => {
            originalSettled = true;
          },
          () => {
            originalSettled = true;
          },
        ]);
        decorations.push(poisonRepositoryThen(operation));
        delivered = operation;
        return operation;
      },
    });
    const repository = createReceivingNominationRepository(
      values.db,
      values.options,
    );
    const action = repository.reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.frame,
    );
    const outcome = observeRepositoryOutcome(action);
    await repositoryTick();
    expect(delivered).not.toBeNull();
    expect(originalSettled).toBe(false);
    expect(outcome.settled).toBe(false);
    expect(values.custody.locked).toBe(true);
    values.state.clock = new Date("2026-10-12T18:20:01.000Z");
    gate.resolve();
    await gate.observed;
    await expect(action).rejects.toMatchObject({
      code: "RECEIVING_NOMINATION_UNAVAILABLE",
    });
    expect(originalSettled).toBe(true);
    expect(values.custody.events).toEqual(["lock", "commit-locked"]);
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(values.queries.at(-1)?.sql).toBe("commit");
    const { admission: _admission, ...legacyOptions } = values.options;
    const recovered = await createReceivingNominationRepository(
      values.db,
      legacyOptions,
    ).reserveNomination(
      values.snapshot,
      values.authorize,
      values.authorization,
    );
    expect(recovered).toEqual(values.snapshot);
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(decorations).toHaveLength(2);
    expect(decorations.every((decoration) => decoration.accesses() === 0)).toBe(
      true,
    );
  });
});
