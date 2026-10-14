import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import type {
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
        before = null;
        if (state.commitLost) throw new Error("private database commit");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
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
  };
  return {
    snapshot,
    authorization,
    tables,
    state,
    queries,
    db,
    options,
    repository: createReceivingNominationRepository(db, options),
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
