import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDatabaseTimestamp } from "./databaseTimestamp";
import { encryptProviderCredential } from "./providerCredentials";
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  type ReceivingNominationCurrentAuthorization,
  type ReceivingProvisioningRecord,
  readReceivingNominationSnapshot,
} from "./receivingNomination";

const nonceState = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, ++nonceState.value),
}));
beforeEach(() => {
  nonceState.value = 0;
});

function fixture(mode: "sandbox" | "live" = "sandbox") {
  const now = "2026-10-13T00:00:00.000123Z";
  const nomination = readReceivingNominationSnapshot({
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    operatorUserId: "operator-one",
    environment: mode,
    requestId: "request-one",
    policyVersion: "policy-one",
    accountId: "account-one",
    operationId: "operation-one",
    createdAt: "2026-10-13T00:00:00.000Z",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "request-one",
          "operator-one",
          mode,
          "policy-one",
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      userId: "operator-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T23:59:30.000Z",
      expiresAt: "2026-10-13T00:04:30.000Z",
    },
  });
  const authorization: ReceivingNominationCurrentAuthorization = {
    actor: {
      userId: "operator-one",
      siteId: "site-one",
      sessionId: "session-one",
    },
    recentAuth: {
      userId: "operator-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION" as const,
      provenance: "backend" as const,
      verification: "verified" as const,
      authenticatedAt: new Date(nomination.authentication.authenticatedAt),
      expiresAt: new Date(nomination.authentication.expiresAt),
    },
  };
  const input = {
    name: "Fictional Operator",
    email: "fictional@example.test",
    cpfCnpj: "12345678909",
    mobilePhone: "11999999999",
    incomeValue: 1000,
    address: "Fictional Street",
    addressNumber: "1",
    province: "Fictional District",
    postalCode: "12345678",
    birthDate: "1990-01-01",
  };
  const provision = deriveReceivingProvisioningContext(
    nomination,
    "fictional-parent",
    "fp-v1",
    input,
    new Map([["fp-v1", new Uint8Array(32).fill(8)]]),
  );
  const claimInput = {
    nomination,
    provision,
    leaseOwner: "owner-one",
    leaseToken: "token-one",
  };
  const tables = {
    accounts: [
      {
        id: "account-one",
        site_id: "site-one",
        environment: mode,
        provider: "ASAAS",
        operator_user_id: "operator-one",
        is_current: true,
        provider_account_state: "UNVERIFIED",
        receiving_capability: false,
        withdrawal_capability: false,
        commercial_enabled: false,
        operator_reference: null,
        webhook_token_hash: null,
        observed_at: null,
        account_reference: null,
        recipient_reference: null,
        credential_version: null,
        credential_key_id: null,
        credential_nonce: null,
        credential_ciphertext: null,
        credential_tag: null,
        created_at: nomination.createdAt,
        updated_at: nomination.createdAt,
      },
    ] as Array<Record<string, unknown>>,
    operations: [
      {
        id: "operation-one",
        site_id: "site-one",
        account_id: "account-one",
        environment: mode,
        kind: "ACCOUNT_CREATE",
        state: "REQUESTED",
        request_id: "request-one",
        request_hash: nomination.requestHash,
        request_snapshot: nomination,
        attempts: 0,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        provider_operation_reference: null,
        order_id: null,
        payment_id: null,
        withdrawal_intent_id: null,
        next_attempt_at: nomination.createdAt,
        last_error_code: null,
        created_at: nomination.createdAt,
        updated_at: nomination.createdAt,
      },
    ] as Array<Record<string, unknown>>,
  };
  const state = {
    demo: false,
    clock: now,
    active: true,
    role: "SITE_ADMIN",
    session: true,
    sessionCreatedAt: "2026-10-12T23:00:00.123456Z",
    membership: true,
    policy: true,
    expireDuringPolicy: false,
    lostCommit: false,
    failOperationUpdate: false,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let previous: typeof tables | undefined;
  let serial = Promise.resolve();
  let unlock: (() => void) | undefined;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (/^begin/i.test(text)) {
        const wait = serial;
        let release!: () => void;
        serial = new Promise<void>((resolve) => {
          release = resolve;
        });
        await wait;
        unlock = release;
        previous = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        previous = undefined;
        unlock?.();
        if (state.lostCommit) {
          state.lostCommit = false;
          throw new Error("fictional lost commit acknowledgement");
        }
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (previous) {
          tables.accounts = previous.accounts;
          tables.operations = previous.operations;
        }
        previous = undefined;
        unlock?.();
        return { rows: [] };
      }
      if (/clock_timestamp/.test(text))
        return { rows: [{ currentTime: state.clock }] };
      if (/FOR UPDATE OF st/.test(text))
        return { rows: [{ siteId: "site-one", isDemo: state.demo }] };
      if (/FOR SHARE OF u/.test(text))
        return {
          rows: state.active
            ? [{ userId: "operator-one", state: "ACTIVE", role: state.role }]
            : [],
        };
      if (/FOR SHARE OF se/.test(text))
        return {
          rows: state.session
            ? [
                {
                  userId: "operator-one",
                  sessionId: "session-one",
                  sessionExpiresAt: "2026-10-14T00:00:00.000Z",
                  lastActiveAt: nomination.createdAt,
                  sessionCreatedAt: state.sessionCreatedAt,
                },
              ]
            : [],
        };
      if (/FOR SHARE OF m/.test(text))
        return { rows: state.membership ? [{ id: "membership-one" }] : [] };
      if (/LEFT JOIN site_membership/.test(text))
        return {
          rows: [
            {
              user_id: "operator-one",
              account_role: state.role,
              account_state: state.active ? "ACTIVE" : "DISABLED",
              site_id: "site-one",
              membership_id: state.membership ? "membership-one" : null,
              membership_user_id: "operator-one",
              membership_role: "SITE_ADMIN",
              revoked_at: null,
            },
          ],
        };
      if (/SELECT to_jsonb\(a\)/.test(text))
        return {
          rows: tables.accounts.map((row) => ({
            account: structuredClone(row),
          })),
        };
      if (/SELECT to_jsonb\(op\)/.test(text))
        return {
          rows: tables.operations.map((row) => ({
            operation: structuredClone(row),
          })),
        };
      if (/^UPDATE /i.test(text)) {
        const operation = /UPDATE "financial_operation"/.test(text);
        if (operation && state.failOperationUpdate)
          throw new Error("fictional operation update");
        const row = (operation ? tables.operations : tables.accounts)[0];
        if (!row) return { rows: [] };
        const set = text.slice(text.indexOf("SET") + 3, text.indexOf("WHERE"));
        for (const match of set.matchAll(/"?([a-z_]+)"?\s*=\s*\$(\d+)/g)) {
          const value = params[Number(match[2]) - 1];
          row[match[1]] =
            match[1] === "request_snapshot"
              ? JSON.parse(value as string)
              : value;
        }
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`Unsupported synthetic SQL: ${text}`);
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  const options = {
    mode,
    applicationEnvironment:
      mode === "live" ? ("production" as const) : ("test" as const),
    maxAuthAgeMs: 300000,
    now: () => new Date(state.clock),
    readCurrentPolicy: vi.fn(async () => {
      if (state.expireDuringPolicy)
        state.clock = nomination.authentication.expiresAt;
      return state.policy;
    }),
  };
  const repository = createReceivingAccountProvisioningRepository(db, options);
  const result = {
    accountReference: "fictional-child",
    recipientReference: "fictional-wallet",
    credential: encryptProviderCredential(
      "fictional-child-key",
      {
        provider: "ASAAS",
        siteId: nomination.siteId,
        accountBindingId: nomination.accountId,
        environment: mode,
      },
      new Map([["credential-v1", new Uint8Array(32).fill(21)]]),
      "credential-v1",
    ),
  };
  const armed = (
    claim: ReceivingProvisioningRecord,
  ): ReceivingProvisioningRecord => ({
    ...claim,
    provision: {
      ...claim.provision,
      dispatch: { ...claim.provision.dispatch, possibleDispatch: true },
    },
  });
  async function arm() {
    const claim = armed(
      await repository.claimOriginal(claimInput, authorization),
    );
    await repository.armOriginal(claim, authorization);
    return claim;
  }
  return {
    nomination,
    authorization,
    claimInput,
    tables,
    state,
    queries,
    db,
    options,
    repository,
    result,
    armed,
    arm,
  };
}
describe("locked original account provisioning repository", () => {
  it.each([false, true])(
    "requires exact locked session timestamps for initial session authorization (mismatch %s)",
    async (mismatch) => {
      const values = fixture();
      Object.assign(values.authorization.recentAuth, {
        proofKind: "SESSION_AUTHENTICATION",
        authenticatedAt: readDatabaseTimestamp(
          mismatch
            ? "2026-10-12T23:00:00.123457Z"
            : values.state.sessionCreatedAt,
        ),
        expiresAt: readDatabaseTimestamp("2026-10-14T00:00:00.000Z"),
      });
      const operation = values.repository.claimOriginal(
        values.claimInput,
        values.authorization,
      );
      if (mismatch) {
        await expect(operation).rejects.toThrow();
        expect(values.tables.operations[0].state).toBe("REQUESTED");
      } else await expect(operation).resolves.toBeTruthy();
    },
  );
  it.each(["site-one", "other-site"])(
    "claims original live showcase provisioning only under exact policy (%s)",
    async (liveDemoSiteId) => {
      const v = fixture("live");
      v.state.demo = true;
      const repository = createReceivingAccountProvisioningRepository(v.db, {
        ...v.options,
        liveDemoSiteId,
      });
      const claim = repository.claimOriginal(v.claimInput, v.authorization);
      if (liveDemoSiteId === "site-one")
        await expect(claim).resolves.toMatchObject({
          nomination: { environment: "live" },
        });
      else await expect(claim).rejects.toThrow();
      expect(v.tables.accounts).toHaveLength(1);
    },
  );

  it("serial competing transactions cannot claim the same legacy operation twice", async () => {
    const values = fixture();
    const outcomes = await Promise.allSettled([
      values.repository.claimOriginal(values.claimInput, values.authorization),
      values.repository.claimOriginal(
        {
          ...values.claimInput,
          leaseOwner: "other-owner",
          leaseToken: "other-token",
        },
        values.authorization,
      ),
    ]);
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(values.tables.operations[0].state).toBe("CLAIMED");
  });
  it("missing current policy evidence cannot claim or mutate", async () => {
    const values = fixture();
    const repository = createReceivingAccountProvisioningRepository(values.db, {
      ...values.options,
      readCurrentPolicy: undefined,
    });
    await expect(
      repository.claimOriginal(values.claimInput, values.authorization),
    ).rejects.toThrow();
    expect(values.tables.operations[0].state).toBe("REQUESTED");
  });
  it("claims only the existing intent with complete lock order and exact database microseconds", async () => {
    const values = fixture();
    const claim = await values.repository.claimOriginal(
      values.claimInput,
      values.authorization,
    );
    expect(claim.nomination).toEqual(values.nomination);
    expect(claim.provision.dispatch.leaseExpiresAtMicroseconds).toBe(
      "1791849660000123",
    );
    expect(values.tables.operations[0].state).toBe("CLAIMED");
    expect(values.tables.accounts).toHaveLength(1);
    expect(values.tables.operations).toHaveLength(1);
    expect(
      values.queries.some((entry) => /INSERT|DELETE/.test(entry.sql)),
    ).toBe(false);
    const order = [
      "FOR UPDATE OF st",
      "FOR SHARE OF u",
      "FOR SHARE OF se",
      "FOR SHARE OF m",
      "FOR UPDATE OF a",
      "FOR UPDATE OF op",
    ].map((term) =>
      values.queries.findIndex((entry) => entry.sql.includes(term)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("arming is irreversible UNKNOWN and never renews or creates again", async () => {
    const values = fixture();
    const claim = await values.arm();
    expect(values.tables.operations[0].state).toBe("UNKNOWN");
    expect(values.tables.operations[0].attempts).toBe(1);
    expect(values.tables.accounts[0].credential_version).toBeNull();
    await expect(
      values.repository.armOriginal(claim, values.authorization),
    ).rejects.toThrow();
    await expect(
      values.repository.claimOriginal(values.claimInput, values.authorization),
    ).rejects.toThrow();
    expect(values.tables.operations[0].lease_token).toBe("token-one");
  });
  it.each(["ARM", "CONFIRM"])(
    "%s cannot accept an already sealed caller record before provider dispatch",
    async (action) => {
      const values = fixture();
      const claim =
        action === "ARM"
          ? values.armed(
              await values.repository.claimOriginal(
                values.claimInput,
                values.authorization,
              ),
            )
          : await values.arm();
      const poisoned = { ...claim, sealedResult: values.result };
      await expect(
        action === "ARM"
          ? values.repository.armOriginal(poisoned, values.authorization)
          : values.repository.confirmOriginalArmForDispatch(
              poisoned,
              values.authorization,
            ),
      ).rejects.toThrow();
      expect(
        (
          values.tables.operations[0]
            .request_snapshot as ReceivingProvisioningRecord
        ).sealedResult,
      ).toBeNull();
    },
  );
  it("positive lost-arm-ACK confirmation rechecks current authority and lease without writing", async () => {
    const values = fixture();
    const claim = await values.arm();
    const count = values.queries.length;
    await values.repository.confirmOriginalArmForDispatch(
      claim,
      values.authorization,
    );
    expect(
      values.queries
        .slice(count)
        .some(
          (entry) =>
            /UPDATE|INSERT|DELETE/.test(entry.sql) &&
            !/FOR UPDATE/.test(entry.sql),
        ),
    ).toBe(false);
    values.state.clock = "2026-10-13T00:01:00.000123Z";
    await expect(
      values.repository.confirmOriginalArmForDispatch(
        claim,
        values.authorization,
      ),
    ).rejects.toThrow();
  });
  it.each([
    "active",
    "session",
    "membership",
    "policy",
    "owner-role",
    "proof",
    "wait-expiry",
  ])(
    "current %s denial prevents arm confirmation and attachment",
    async (caseName) => {
      const values = fixture();
      const claim = await values.arm();
      await values.repository.quarantineOriginal(claim, values.result);
      if (["active", "session", "membership", "policy"].includes(caseName))
        Object.assign(values.state, { [caseName]: false });
      if (caseName === "owner-role") values.state.role = "OWNER";
      if (caseName === "proof")
        values.authorization.recentAuth.verification = "unverified" as never;
      if (caseName === "wait-expiry") values.state.expireDuringPolicy = true;
      await expect(
        values.repository.confirmOriginalArmForDispatch(
          claim,
          values.authorization,
        ),
      ).rejects.toThrow();
      await expect(
        values.repository.attachOriginal(
          claim,
          values.result,
          values.authorization,
        ),
      ).rejects.toThrow();
      expect(values.tables.accounts[0].credential_version).toBeNull();
    },
  );
  it.each(["history", "orphan", "foreign", "partial-key", "binding"])(
    "unfiltered %s topology cannot become an initial claim",
    async (caseName) => {
      const values = fixture();
      if (caseName === "history")
        values.tables.accounts.push({
          ...values.tables.accounts[0],
          id: "historical",
          is_current: false,
        });
      if (caseName === "orphan") values.tables.accounts = [];
      if (caseName === "foreign")
        values.tables.operations[0].account_id = "foreign";
      if (caseName === "partial-key")
        values.tables.accounts[0].credential_key_id = "foreign";
      if (caseName === "binding")
        values.tables.accounts[0].account_reference = "foreign";
      await expect(
        values.repository.claimOriginal(
          values.claimInput,
          values.authorization,
        ),
      ).rejects.toThrow();
      expect(values.tables.operations[0].state).toBe("REQUESTED");
    },
  );
  it("expired/revoked custody preserves the original encrypted result and grants no attachment", async () => {
    const values = fixture();
    const claim = await values.arm();
    values.state.clock = "2026-10-13T01:00:00.000Z";
    values.state.active = false;
    values.state.membership = false;
    values.state.policy = false;
    await values.repository.quarantineOriginal(claim, values.result);
    expect(
      (await values.repository.consultOriginal(claim, values.result))?.result,
    ).toEqual(values.result);
    expect(values.tables.accounts[0].credential_version).toBeNull();
    await expect(
      values.repository.attachOriginal(
        claim,
        values.result,
        values.authorization,
      ),
    ).rejects.toThrow();
  });
  it("renewed expiry by one microsecond rejects the old custody callback", async () => {
    const values = fixture();
    const claim = await values.arm();
    values.tables.operations[0].lease_expires_at =
      "2026-10-13T00:01:00.000124Z";
    await expect(
      values.repository.quarantineOriginal(claim, values.result),
    ).rejects.toThrow();
    expect(
      (
        values.tables.operations[0]
          .request_snapshot as ReceivingProvisioningRecord
      ).sealedResult,
    ).toBeNull();
  });
  it("a conflicting random-nonce envelope never overwrites original custody", async () => {
    const values = fixture();
    const claim = await values.arm();
    await values.repository.quarantineOriginal(claim, values.result);
    const conflicting = {
      ...values.result,
      credential: {
        ...values.result.credential,
        nonce: Buffer.alloc(12, 7).toString("base64url"),
      },
    };
    await expect(
      values.repository.quarantineOriginal(claim, conflicting),
    ).rejects.toThrow();
    expect(
      (await values.repository.consultOriginal(claim, values.result))?.result,
    ).toEqual(values.result);
  });
  it("fresh-authorized attachment settles an expired original lease atomically with all five fields", async () => {
    const values = fixture();
    const claim = await values.arm();
    await values.repository.quarantineOriginal(claim, values.result);
    values.state.clock = "2026-10-13T00:02:00.000123Z";
    await values.repository.attachOriginal(
      claim,
      values.result,
      values.authorization,
    );
    expect(values.tables.accounts[0]).toMatchObject({
      account_reference: "fictional-child",
      recipient_reference: "fictional-wallet",
      credential_version: 1,
      credential_key_id: "credential-v1",
      credential_nonce: values.result.credential.nonce,
      credential_ciphertext: values.result.credential.ciphertext,
      credential_tag: values.result.credential.tag,
      provider_account_state: "UNVERIFIED",
      receiving_capability: false,
      withdrawal_capability: false,
      commercial_enabled: false,
      operator_reference: null,
    });
    expect(values.tables.operations[0]).toMatchObject({
      state: "SUCCEEDED",
      provider_operation_reference: "fictional-child",
      request_hash: values.nomination.requestHash,
    });
    expect(
      (
        values.tables.operations[0]
          .request_snapshot as ReceivingProvisioningRecord
      ).sealedResult,
    ).toBeNull();
    expect(
      (await values.repository.consultOriginal(claim, values.result))?.result,
    ).toEqual(values.result);
  });
  it("an operation failure rolls back all canonical credential writes and capsule removal", async () => {
    const values = fixture();
    const claim = await values.arm();
    await values.repository.quarantineOriginal(claim, values.result);
    values.state.failOperationUpdate = true;
    await expect(
      values.repository.attachOriginal(
        claim,
        values.result,
        values.authorization,
      ),
    ).rejects.toThrow();
    expect(values.tables.accounts[0].credential_version).toBeNull();
    expect(
      (
        values.tables.operations[0]
          .request_snapshot as ReceivingProvisioningRecord
      ).sealedResult,
    ).toEqual(values.result);
    expect(values.tables.operations[0].state).toBe("UNKNOWN");
  });
  it("lost commit acknowledgement can only consult the original prepared canonical envelope", async () => {
    const values = fixture();
    const claim = await values.arm();
    await values.repository.quarantineOriginal(claim, values.result);
    values.state.lostCommit = true;
    await expect(
      values.repository.attachOriginal(
        claim,
        values.result,
        values.authorization,
      ),
    ).rejects.toThrow();
    const observed = await values.repository.consultOriginal(
      claim,
      values.result,
    );
    expect(observed?.state).toBe("SUCCEEDED");
    expect(observed?.result).toEqual(values.result);
    await expect(
      values.repository.consultOriginal(claim, {
        ...values.result,
        accountReference: "foreign",
      }),
    ).rejects.toThrow();
  });
});
