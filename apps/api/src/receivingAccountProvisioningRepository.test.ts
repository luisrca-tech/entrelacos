import { createHash } from "node:crypto";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDatabaseTimestamp } from "./databaseTimestamp";
import {
  createReceivingAccountProvisioning,
  deriveReceivingProvisioningContext,
} from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  type ReceivingNominationCurrentAuthorization,
  type ReceivingProvisioningRecord,
  readReceivingNominationSnapshot,
} from "./receivingNomination";
import { createReceivingSetupService } from "./receivingSetup";

const nonceState = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, ++nonceState.value),
}));
beforeEach(() => {
  nonceState.value = 0;
});

// Emulates the provider/kind filters of the locked scope reads so rows of the
// previous provider reach the repository exactly as the database returns them.
function scopedAccount(text: string) {
  const pagarmeOnly = /provider='PAGARME'/.test(text);
  return (row: Record<string, unknown>) =>
    !pagarmeOnly || row.provider === "PAGARME";
}
function scopedOperation(
  text: string,
  accounts: ReadonlyArray<Record<string, unknown>>,
) {
  const accountCreateOnly = /kind='ACCOUNT_CREATE'/.test(text);
  const withoutPreviousProvider = /NOT EXISTS/.test(text);
  return (row: Record<string, unknown>) =>
    (!accountCreateOnly || row.kind === "ACCOUNT_CREATE") &&
    (!withoutPreviousProvider ||
      !accounts.some(
        (account) =>
          account.id === row.account_id && account.provider !== "PAGARME",
      ));
}
function previousProviderRows(mode: "sandbox" | "live") {
  const at = "2026-03-01T12:00:00.000Z";
  const operation = (id: string, kind: string, target: object) => ({
    id,
    site_id: "site-one",
    account_id: "a-previous-account",
    environment: mode,
    kind,
    state: "SUCCEEDED",
    request_id: `request-${id}`,
    request_hash: "a".repeat(64),
    request_snapshot: { legacy: true },
    attempts: 1,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    provider_operation_reference: `ref-${id}`,
    order_id: null,
    payment_id: null,
    withdrawal_intent_id: null,
    next_attempt_at: at,
    last_error_code: null,
    created_at: at,
    updated_at: at,
    ...target,
  });
  return {
    account: {
      // Sorts before the Pagar.me rows, as a random older id may in production.
      id: "a-previous-account",
      site_id: "site-one",
      environment: mode,
      provider: "ASAAS",
      operator_user_id: "operator-one",
      is_current: false,
      provider_account_state: "APPROVED",
      receiving_capability: true,
      withdrawal_capability: true,
      commercial_enabled: true,
      operator_reference: null,
      observed_at: at,
      account_reference: "acc_previous",
      recipient_reference: null,
      created_at: at,
      updated_at: at,
    },
    operations: [
      operation("a-previous-create", "ACCOUNT_CREATE", {}),
      operation("a-previous-checkout", "CHECKOUT_CREATE", {
        order_id: "order-previous",
      }),
      operation("a-previous-withdrawal", "WITHDRAWAL", {
        withdrawal_intent_id: "withdrawal-previous",
      }),
    ],
  };
}
function withPreviousProvider(tables: {
  accounts: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
}) {
  const mode = tables.accounts[0].environment as "sandbox" | "live";
  const previous = previousProviderRows(mode);
  tables.accounts.unshift(previous.account);
  tables.operations.unshift(...previous.operations);
}

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
    name: "MARIA DA SILVA",
    email: "maria@example.test",
    cpf: "12345678909",
    mobilePhone: "21994647568",
    birthDate: "1990-04-12",
    monthlyIncomeCents: 500000,
    professionalOccupation: "Professora",
    address: {
      street: "Av. General Justo",
      streetNumber: "375",
      neighborhood: "Centro",
      city: "Rio de Janeiro",
      state: "RJ",
      zipCode: "20021130",
      referencePoint: "Ao lado da banca",
    },
    bankAccount: {
      bank: "341",
      branchNumber: "1234",
      accountNumber: "12345",
      accountCheckDigit: "6",
      holderName: "MARIA DA SILVA",
      type: "checking" as const,
    },
  };
  const provision = deriveReceivingProvisioningContext(
    nomination,
    "rp_platformRecipient",
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
        provider: "PAGARME",
        operator_user_id: "operator-one",
        is_current: true,
        provider_account_state: "UNVERIFIED",
        receiving_capability: false,
        withdrawal_capability: false,
        commercial_enabled: false,
        operator_reference: null,
        observed_at: null,
        account_reference: null,
        recipient_reference: null,
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
          rows: tables.accounts.filter(scopedAccount(text)).map((row) => ({
            account: structuredClone(row),
          })),
        };
      if (/SELECT to_jsonb\(op\)/.test(text))
        return {
          rows: tables.operations
            .filter(scopedOperation(text, tables.accounts))
            .map((row) => ({
              operation: structuredClone(row),
            })),
        };
      if (/^UPDATE /i.test(text)) {
        const operation = /UPDATE "financial_operation"/.test(text);
        if (operation && state.failOperationUpdate)
          throw new Error("fictional operation update");
        const where = text.slice(text.indexOf("WHERE"));
        const id = /\bid\s*=\s*\$(\d+)/.exec(where);
        const target = id ? params[Number(id[1]) - 1] : undefined;
        const row = (operation ? tables.operations : tables.accounts).find(
          (value) => value.id === target,
        );
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
    accountReference: "rp_fixtureRecipient01",
    recipientReference: "rp_fixtureRecipient01",
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
    input,
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
    async (liveDemoSiteIds) => {
      const v = fixture("live");
      v.state.demo = true;
      const repository = createReceivingAccountProvisioningRepository(v.db, {
        ...v.options,
        liveDemoSiteIds:
          liveDemoSiteIds === undefined ? undefined : [liveDemoSiteIds],
      });
      const claim = repository.claimOriginal(v.claimInput, v.authorization);
      if (liveDemoSiteIds === "site-one")
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
    expect(values.tables.accounts[0].recipient_reference).toBeNull();
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
      expect(values.tables.accounts[0].recipient_reference).toBeNull();
    },
  );
  it.each(["history", "orphan", "foreign", "partial-binding", "binding"])(
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
      if (caseName === "partial-binding")
        values.tables.accounts[0].recipient_reference = "rp_foreign";
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
    expect(values.tables.accounts[0].recipient_reference).toBeNull();
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
  it("a conflicting recipient never overwrites original custody", async () => {
    const values = fixture();
    const claim = await values.arm();
    await values.repository.quarantineOriginal(claim, values.result);
    const conflicting = {
      accountReference: "rp_conflictingRecipient",
      recipientReference: "rp_conflictingRecipient",
    };
    await expect(
      values.repository.quarantineOriginal(claim, conflicting),
    ).rejects.toThrow();
    expect(
      (await values.repository.consultOriginal(claim, values.result))?.result,
    ).toEqual(values.result);
  });
  it("fresh-authorized attachment settles an expired original lease atomically with the recipient id", async () => {
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
      account_reference: "rp_fixtureRecipient01",
      recipient_reference: "rp_fixtureRecipient01",
      provider_account_state: "UNVERIFIED",
      receiving_capability: false,
      withdrawal_capability: false,
      commercial_enabled: false,
      operator_reference: null,
    });
    expect(values.tables.operations[0]).toMatchObject({
      state: "SUCCEEDED",
      provider_operation_reference: "rp_fixtureRecipient01",
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
  it("an operation failure rolls back the recipient binding and capsule removal", async () => {
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
    expect(values.tables.accounts[0].recipient_reference).toBeNull();
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
        accountReference: "rp_foreign",
        recipientReference: "rp_foreign",
      }),
    ).rejects.toThrow();
  });
});

describe("provisioning next to a previous provider's history", () => {
  const PII = [
    "MARIA",
    "maria@example.test",
    "12345678909",
    "21994647568",
    "General Justo",
    "20021130",
    "12345",
    "token-one",
  ];

  it("claims, arms, quarantines, attaches and consults only the Pagar.me intent", async () => {
    const values = fixture("live");
    values.state.demo = true;
    const repository = createReceivingAccountProvisioningRepository(values.db, {
      ...values.options,
      liveDemoSiteIds: ["site-one"],
    });
    withPreviousProvider(values.tables);
    const history = structuredClone({
      account: values.tables.accounts[0],
      operations: values.tables.operations.slice(0, 3),
    });
    const claim = values.armed(
      await repository.claimOriginal(values.claimInput, values.authorization),
    );
    await repository.armOriginal(claim, values.authorization);
    await repository.quarantineOriginal(claim, values.result);
    await repository.attachOriginal(claim, values.result, values.authorization);
    const observed = await repository.consultOriginal(claim, values.result);
    expect(observed?.state).toBe("SUCCEEDED");
    expect(observed?.result).toEqual(values.result);
    expect(values.tables.accounts[1]).toMatchObject({
      id: "account-one",
      recipient_reference: values.result.recipientReference,
    });
    expect(values.tables.operations[3]).toMatchObject({
      id: "operation-one",
      state: "SUCCEEDED",
    });
    expect(values.tables.accounts[0]).toEqual(history.account);
    expect(values.tables.operations.slice(0, 3)).toEqual(history.operations);
  });

  it.each(["second-account", "second-create"])(
    "a %s of Pagar.me still refuses the claim and reports why",
    async (caseName) => {
      const observe = vi.fn();
      const values = fixture();
      const repository = createReceivingAccountProvisioningRepository(
        values.db,
        { ...values.options, observe },
      );
      withPreviousProvider(values.tables);
      if (caseName === "second-account")
        values.tables.accounts.push({
          ...values.tables.accounts[1],
          id: "account-two",
          is_current: false,
        });
      else
        values.tables.operations.push({
          ...values.tables.operations[3],
          id: "operation-two",
          request_id: "request-two",
        });
      await expect(
        repository.claimOriginal(values.claimInput, values.authorization),
      ).rejects.toThrow();
      expect(values.tables.operations[3].state).toBe("REQUESTED");
      expect(observe).toHaveBeenCalledWith({
        level: "warn",
        event: "receiving.provisioning.refused",
        operation: "scope",
        result:
          caseName === "second-account" ? "account_count" : "operation_count",
        siteId: "site-one",
        count: 2,
      });
      const logged = JSON.stringify(observe.mock.calls);
      for (const value of PII) expect(logged).not.toContain(value);
    },
  );
});

describe("resubmitting a stuck setup next to a previous provider's history", () => {
  it("reuses the REQUESTED nomination, claims it and creates exactly one recipient", async () => {
    const values = fixture();
    withPreviousProvider(values.tables);
    const history = structuredClone({
      account: values.tables.accounts[0],
      operations: values.tables.operations.slice(0, 3),
    });
    const createRecipient = vi.fn(async (code: string) => ({
      id: values.result.recipientReference,
      code,
    }));
    const provisioning = createReceivingAccountProvisioning({
      repository: values.repository,
      readProvider: async () => ({
        approved: true as const,
        environment: "sandbox" as const,
        parentAccountReference: "rp_platformRecipient",
        policyVersion: values.nomination.policyVersion,
        recipients: { createRecipient } as never,
      }),
      fingerprintKeys: new Map([["fp-v1", new Uint8Array(32).fill(8)]]),
      activeFingerprintKeyId: "fp-v1",
      now: () => new Date(values.state.clock),
      generateId: (kind) => `${kind}-one`,
      observe: vi.fn(),
    });
    const nominate = vi.fn();
    const setup = createReceivingSetupService({
      repository: {
        mode: "sandbox",
        policyVersion: values.nomination.policyVersion,
        requireHolder: vi.fn(async () => {}),
        designate: vi.fn(async () => {}),
        readSessionAuthentication: vi.fn(
          async () => values.authorization.recentAuth,
        ),
        consent: vi.fn(async () => {}),
        // The stuck production row: REQUESTED, never claimed or dispatched.
        readAccount: vi.fn(async () => ({
          accountId: values.nomination.accountId,
          operatorUserId: values.nomination.operatorUserId,
          state: "REQUESTED" as const,
          nomination: values.nomination,
          record: null,
          result: null,
        })),
      } as never,
      nomination: { nominate },
      provisioning,
    });
    const outcome = await setup.submit(
      {
        policyVersion: values.nomination.policyVersion,
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account: values.input,
      },
      { actor: values.authorization.actor } as never,
    );
    await provisioning.close();
    expect(outcome).toEqual({ state: "STORED" });
    expect(nominate).not.toHaveBeenCalled();
    // The first dispatch keeps the original idempotency key (attempt 1).
    expect(createRecipient).toHaveBeenCalledExactlyOnceWith(
      "account-one",
      values.input,
      1,
    );
    expect(values.tables.accounts[1]).toMatchObject({
      id: "account-one",
      account_reference: values.result.accountReference,
      recipient_reference: values.result.recipientReference,
    });
    expect(values.tables.operations[3]).toMatchObject({
      id: "operation-one",
      state: "SUCCEEDED",
      attempts: 1,
    });
    expect(values.tables.accounts[0]).toEqual(history.account);
    expect(values.tables.operations.slice(0, 3)).toEqual(history.operations);
  });
});
