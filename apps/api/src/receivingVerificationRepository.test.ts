import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import {
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";
import { evaluateReceivingReadiness } from "./receivingReadiness";
import {
  prepareReceivingVerificationObservation,
  type ReceivingVerificationObservation,
  type ReceivingVerificationScope,
} from "./receivingVerification";
import { createReceivingVerificationRepository } from "./receivingVerificationRepository";

function fixture(mode: "sandbox" | "live" = "sandbox") {
  const createdAt = "2026-10-13T00:00:00.000Z";
  const immutable = {
    siteId: "site-one",
    operatorUserId: "operator-one",
    environment: mode,
    policyVersion: "policy-one",
    requestId: "request-one",
  };
  const nomination = readReceivingNominationSnapshot({
    state: "AWAITING_PROVIDER_VERIFICATION",
    ...immutable,
    accountId: "account-one",
    operationId: "operation-one",
    createdAt,
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          immutable.siteId,
          immutable.requestId,
          immutable.operatorUserId,
          immutable.environment,
          immutable.policyVersion,
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
      expiresAt: "2026-10-13T00:04:00.000Z",
    },
  });
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
    "fingerprint-one",
    input,
    new Map([["fingerprint-one", new Uint8Array(32).fill(12)]]),
  );
  const privateRecord = readReceivingProvisioningRecord({
    version: "receiving.account-provisioning.v1",
    nomination,
    provision: {
      ...provision,
      dispatch: {
        leaseOwner: "owner-one",
        leaseToken: "token-one",
        leaseExpiresAtMicroseconds: (
          BigInt(Date.parse("2026-10-13T00:01:00.000Z")) * 1000n +
          123n
        ).toString(),
        possibleDispatch: true,
      },
    },
    sealedResult: null,
  });
  const tables = {
    accounts: [
      {
        id: "account-one",
        site_id: "site-one",
        environment: mode,
        provider: "ASAAS",
        operator_user_id: "operator-one",
        operator_reference: null,
        account_reference: "native-account",
        recipient_reference: "native-wallet",
        is_current: true,
        provider_account_state: "UNVERIFIED",
        receiving_capability: false,
        withdrawal_capability: false,
        commercial_enabled: false,
        credential_version: 1,
        credential_key_id: "fictional-key",
        credential_nonce: Buffer.alloc(12, 1).toString("base64url"),
        credential_ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        credential_tag: Buffer.alloc(16, 3).toString("base64url"),
        webhook_token_hash: null,
        observed_at: null,
        created_at: createdAt,
        updated_at: "2026-10-13T00:00:00.000123Z",
      },
    ] as Array<Record<string, unknown>>,
    operations: [
      {
        id: "operation-one",
        site_id: "site-one",
        account_id: "account-one",
        environment: mode,
        kind: "ACCOUNT_CREATE",
        state: "SUCCEEDED",
        request_id: "request-one",
        request_hash: nomination.requestHash,
        request_snapshot: privateRecord,
        attempts: 1,
        lease_owner: "owner-one",
        lease_token: "token-one",
        lease_expires_at: "2026-10-13T00:01:00.000123Z",
        provider_operation_reference: "native-account",
        order_id: null,
        payment_id: null,
        withdrawal_intent_id: null,
        next_attempt_at: createdAt,
        last_error_code: null,
        created_at: createdAt,
        updated_at: "2026-10-13T00:00:00.000123Z",
      },
    ] as Array<Record<string, unknown>>,
    destinations: [] as Array<Record<string, unknown>>,
    evidence: [] as Array<Record<string, unknown>>,
  };
  const state = {
    clock: "2026-10-13T00:00:03.000123Z",
    active: true,
    demo: false,
    role: "SITE_ADMIN",
    session: true,
    membership: true,
    policy: true,
    release: true,
    expireDuringPolicy: false,
    lostCommit: false,
    failEvidence: false,
    revokeReleaseOnInsert: false,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let previous: typeof tables | undefined;
  let serial = Promise.resolve();
  let unlock: (() => void) | undefined;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (/^begin/i.test(sql)) {
        const wait = serial;
        let release!: () => void;
        serial = new Promise<void>((yes) => {
          release = yes;
        });
        await wait;
        unlock = release;
        previous = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(sql)) {
        previous = undefined;
        unlock?.();
        if (state.lostCommit) {
          state.lostCommit = false;
          throw new Error("fictional lost ACK");
        }
        return { rows: [] };
      }
      if (/^rollback/i.test(sql)) {
        if (previous) Object.assign(tables, previous);
        previous = undefined;
        unlock?.();
        return { rows: [] };
      }
      if (/clock_timestamp/.test(sql))
        return { rows: [{ currentTime: state.clock }] };
      if (/FOR UPDATE OF st/.test(sql))
        return { rows: [{ siteId: "site-one", isDemo: state.demo }] };
      if (/FOR SHARE OF u/.test(sql))
        return {
          rows: state.active
            ? [{ userId: "operator-one", role: state.role, state: "ACTIVE" }]
            : [],
        };
      if (/FOR SHARE OF se/.test(sql))
        return {
          rows: state.session
            ? [
                {
                  userId: "operator-one",
                  sessionId: "session-one",
                  sessionExpiresAt: "2026-10-14T00:00:00.000Z",
                  lastActiveAt: createdAt,
                  sessionCreatedAt: createdAt,
                },
              ]
            : [],
        };
      if (/FOR SHARE OF m/.test(sql))
        return { rows: state.membership ? [{ id: "membership-one" }] : [] };
      if (/LEFT JOIN site_membership/.test(sql))
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
      if (/SELECT to_jsonb\(a\)/.test(sql))
        return {
          rows: tables.accounts.map((account) => ({
            account: structuredClone(account),
          })),
        };
      if (/SELECT to_jsonb\(op\)/.test(sql))
        return {
          rows: tables.operations.map((operation) => ({
            operation: structuredClone(operation),
          })),
        };
      if (/SELECT to_jsonb\(d\)/.test(sql))
        return {
          rows: tables.destinations.map((destination) => ({
            destination: structuredClone(destination),
          })),
        };
      if (/SELECT to_jsonb\(ev\)/.test(sql))
        return {
          rows: tables.evidence.map((evidence) => ({
            evidence: structuredClone(evidence),
          })),
        };
      const inserted =
        /^INSERT INTO "?([a-z_]+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(
          sql,
        );
      if (inserted) {
        const table =
          inserted[1] === "receiving_destination"
            ? tables.destinations
            : inserted[1] === "receiving_verification_evidence"
              ? tables.evidence
              : null;
        if (!table) throw new Error("unsupported write");
        if (table === tables.evidence && state.failEvidence)
          throw new Error("fictional evidence failure");
        if (table === tables.evidence && state.revokeReleaseOnInsert)
          state.release = false;
        const columns = inserted[2]
          .split(",")
          .map((name) => name.trim().replaceAll('"', ""));
        const values = inserted[3].split(",");
        const row: Record<string, unknown> = {};
        columns.forEach((name, index) => {
          const match = /\$(\d+)/.exec(values[index]);
          if (!match) throw new Error("unsupported insert value");
          row[name] = params[Number(match[1]) - 1];
        });
        if (table.some((value) => value.id === row.id))
          throw new Error("fictional duplicate");
        table.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE /i.test(sql)) {
        const table = /UPDATE "receiving_account"/.test(sql)
          ? tables.accounts
          : /UPDATE "receiving_destination"/.test(sql)
            ? tables.destinations
            : null;
        if (!table) throw new Error("unsupported update");
        const where = sql.slice(sql.indexOf("WHERE"));
        const id = /\bid\s*=\s*\$(\d+)/.exec(where);
        const target = id ? params[Number(id[1]) - 1] : undefined;
        const row = table.find((value) => value.id === target);
        if (!row) return { rows: [] };
        const set = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
        for (const match of set.matchAll(/"?([a-z_]+)"?\s*=\s*\$(\d+)/g))
          row[match[1]] = params[Number(match[2]) - 1];
        return { rows: [{ id: row.id }] };
      }
      throw new Error("unsupported synthetic SQL");
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  const options = {
    mode,
    applicationEnvironment:
      mode === "live" ? ("production" as const) : ("test" as const),
    maxAuthAgeMs: 300000,
    now: () => new Date(state.clock),
    readCurrentPolicy: vi.fn(async (action: string) => {
      if (state.expireDuringPolicy)
        state.clock = nomination.authentication.expiresAt;
      return state.policy && (!action.includes("RELEASE") || state.release);
    }),
  };
  const repository = createReceivingVerificationRepository(db, options);
  const authorization = {
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
  const scope = (): ReceivingVerificationScope => ({
    provider: "ASAAS",
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "operator-one",
    environment: mode,
    operatorReference: tables.accounts[0].operator_reference as string | null,
    accountReference: "native-account",
    recipientReference: "native-wallet",
  });
  const candidate = () => ({
    kind: "DESTINATION" as const,
    profile: "rv1" as const,
    verifiable: true as const,
    scope: { ...scope(), operatorReference: "native-operator" },
    bankReference: "native-bank",
    maskedDescriptor: "Bank **** 1234",
    mappingReference: "mapping-one",
  });
  const select = async (id = "selection-one") => {
    const fence = await repository.captureSelection(scope(), authorization);
    await repository.selectDestination(fence, id, candidate(), authorization);
    return fence;
  };
  const observation = (
    change: Partial<ReceivingVerificationObservation> = {},
  ) => {
    const current = tables.destinations.find((row) => row.is_current === true);
    const value: ReceivingVerificationObservation = {
      kind: "OBSERVATION",
      profile: "rv1",
      verifiable: true,
      scope: scope(),
      destination: {
        id: String(current?.id),
        version: Number(current?.version),
        bankReference: String(current?.bank_reference),
      },
      account: {
        sourceId: "account-source-one",
        sourceOrder: "9007199254740993",
        state: "APPROVED",
        observedAt: "2026-10-13T00:00:01.000123Z",
        receiving: true,
        withdrawal: true,
        commercial: true,
      },
      bank: {
        sourceId: "bank-source-one",
        sourceOrder: "9007199254740995",
        state: "VERIFIED",
        observedAt: "2026-10-13T00:00:00.000321Z",
      },
      ...change,
    };
    return prepareReceivingVerificationObservation(value);
  };
  const append = async (value = observation()) => {
    const fence = await repository.captureObservation(scope());
    await repository.appendObservation(fence, value);
    return fence;
  };
  return {
    tables,
    state,
    queries,
    db,
    options,
    repository,
    authorization,
    scope,
    candidate,
    select,
    observation,
    append,
  };
}
describe("locked immutable receiving verification repository", () => {
  it("serialized competing original fences admit only one initial selection", async () => {
    const v = fixture();
    const original = await v.repository.captureSelection(
      v.scope(),
      v.authorization,
    );
    const results = await Promise.allSettled([
      v.repository.selectDestination(
        original,
        "selection-one",
        v.candidate(),
        v.authorization,
      ),
      v.repository.selectDestination(
        original,
        "selection-two",
        v.candidate(),
        v.authorization,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(v.tables.destinations).toHaveLength(1);
    expect(v.tables.destinations[0].version).toBe(1);
  });
  it.each([true, false])(
    "setup session selection requires its distinct locked authority port (approved=%s)",
    async (approved) => {
      const v = fixture();
      const authorization = {
        ...v.authorization,
        recentAuth: {
          ...v.authorization.recentAuth,
          proofKind: "SESSION_AUTHENTICATION" as const,
          authenticatedAt: new Date("2026-10-13T00:00:00.000Z"),
          expiresAt: new Date("2026-10-14T00:00:00.000Z"),
        },
      };
      const authorizeSetupSelectionInTransaction = vi.fn(async () => approved);
      const repository = createReceivingVerificationRepository(v.db, {
        ...v.options,
        applicationEnvironment: "development",
        authorizeSetupSelectionInTransaction,
      });
      if (approved)
        await expect(
          repository.captureSelection(v.scope(), authorization),
        ).resolves.toMatchObject({ scope: v.scope() });
      else
        await expect(
          repository.captureSelection(v.scope(), authorization),
        ).rejects.toThrow();
      expect(authorizeSetupSelectionInTransaction).toHaveBeenCalledOnce();
      await expect(
        v.repository.captureSelection(v.scope(), authorization),
      ).rejects.toThrow();
    },
  );
  it.each([true, false])(
    "production setup session selection requires current locked provisioning authority (approved=%s)",
    async (approved) => {
      const v = fixture("live");
      const authorization = {
        ...v.authorization,
        recentAuth: {
          ...v.authorization.recentAuth,
          proofKind: "SESSION_AUTHENTICATION" as const,
          authenticatedAt: new Date("2026-10-13T00:00:00Z"),
          expiresAt: new Date("2026-10-14T00:00:00Z"),
        },
      };
      const authorizeSetupSelectionInTransaction = vi.fn(async () => approved);
      const repository = createReceivingVerificationRepository(v.db, {
        ...v.options,
        authorizeSetupSelectionInTransaction,
      });
      if (approved) {
        const fence = await repository.captureSelection(
          v.scope(),
          authorization,
        );
        await repository.selectDestination(
          fence,
          "live-selection",
          v.candidate(),
          authorization,
        );
        expect(v.tables.destinations).toHaveLength(1);
        expect(v.tables.destinations[0].environment).toBe("live");
      } else
        await expect(
          repository.captureSelection(v.scope(), authorization),
        ).rejects.toThrow();
      expect(authorizeSetupSelectionInTransaction).toHaveBeenCalled();
      await expect(
        v.repository.captureSelection(v.scope(), authorization),
      ).rejects.toThrow();
    },
  );
  it.each(["site-one", "other-site"])(
    "locks native production showcase verification under exact policy (%s)",
    async (liveDemoSiteId) => {
      const v = fixture("live");
      v.state.demo = true;
      const repository = createReceivingVerificationRepository(v.db, {
        ...v.options,
        liveDemoSiteId,
      });
      const capture = repository.captureSelection(v.scope(), v.authorization);
      if (liveDemoSiteId === "site-one") {
        const fence = await capture;
        await repository.selectDestination(
          fence,
          "live-demo-selection",
          v.candidate(),
          v.authorization,
        );
        expect(v.tables.destinations).toHaveLength(1);
      } else await expect(capture).rejects.toThrow();
    },
  );
  it("rejects a forged setup attestation with timestamps different from the actual locked session", async () => {
    const v = fixture();
    const repository = createReceivingVerificationRepository(v.db, {
      ...v.options,
      applicationEnvironment: "development",
      authorizeSetupSelectionInTransaction: async () => true,
    });
    const authorization = {
      ...v.authorization,
      recentAuth: {
        ...v.authorization.recentAuth,
        proofKind: "SESSION_AUTHENTICATION" as const,
        authenticatedAt: new Date("2026-10-12T23:59:59.999Z"),
        expiresAt: new Date("2026-10-14T00:00:00Z"),
      },
    };
    await expect(
      repository.captureSelection(v.scope(), authorization),
    ).rejects.toThrow();
  });
  it("retains Sandbox simulation history without using it as native verification authority", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.demo = true;
    v.tables.evidence[0].provenance = "SIMULATION";
    v.tables.evidence[0].verification_reference =
      "simulation:demo-checkout:v1:fixture-one";
    v.tables.destinations[0].bank_reference =
      "simulation:demo-checkout:account-one";
    v.tables.destinations[0].masked_descriptor =
      "Simulated destination - Sandbox checkout only";
    v.tables.evidence[0].bank_reference =
      v.tables.destinations[0].bank_reference;
    const historical = structuredClone(v.tables.evidence[0]);
    const repository = createReceivingVerificationRepository(v.db, {
      ...v.options,
      applicationEnvironment: "development",
      allowSandboxSimulationHistory: true,
    });
    const fence = await repository.captureSelection(v.scope(), v.authorization);
    await repository.selectDestination(
      fence,
      "native-selection-two",
      { ...v.candidate(), bankReference: "native-bank-two" },
      v.authorization,
    );
    expect(v.tables.evidence[0]).toEqual(historical);
    expect(v.tables.destinations.find((row) => row.is_current)).toMatchObject({
      version: 2,
      bank_state: "PENDING",
    });
    expect(v.tables.evidence).toHaveLength(1);
  });
  it.each([
    "bank",
    "label",
    "proof",
    "scope",
    "foreign",
    "native",
    "environment",
    "disabled",
    "live",
  ] as const)(
    "rejects historical Sandbox destination compatibility with a mismatched %s",
    async (changed) => {
      const v = fixture();
      await v.select();
      await v.append();
      v.state.demo = true;
      Object.assign(v.tables.destinations[0], {
        bank_reference: "simulation:demo-checkout:account-one",
        masked_descriptor: "Simulated destination - Sandbox checkout only",
      });
      Object.assign(v.tables.evidence[0], {
        bank_reference: "simulation:demo-checkout:account-one",
        provenance: "SIMULATION",
        verification_reference: "simulation:demo-checkout:v1:fixture-one",
      });
      if (changed === "bank")
        v.tables.destinations[0].bank_reference = "unrelated-bank";
      if (changed === "label")
        v.tables.destinations[0].masked_descriptor = "Account 123456789012";
      if (changed === "proof") v.tables.evidence[0].provenance = "PROVIDER";
      if (changed === "scope") v.state.demo = false;
      if (changed === "foreign")
        v.tables.evidence[0].account_id = "other-account";
      if (changed === "native") {
        v.tables.destinations[0].bank_reference = "asaas-bank-native";
        v.tables.evidence[0].bank_reference = "asaas-bank-native";
      }
      const repository = createReceivingVerificationRepository(v.db, {
        ...v.options,
        mode: changed === "live" ? "live" : "sandbox",
        applicationEnvironment:
          changed === "live"
            ? "production"
            : changed === "environment"
              ? "test"
              : "development",
        allowSandboxSimulationHistory: changed !== "disabled",
      });
      await expect(
        repository.captureSelection(v.scope(), v.authorization),
      ).rejects.toThrow();
    },
  );
  it("lost initial selection ACK consults the original expected version without allocating again", async () => {
    const v = fixture();
    const fence = await v.repository.captureSelection(
      v.scope(),
      v.authorization,
    );
    v.state.lostCommit = true;
    await expect(
      v.repository.selectDestination(
        fence,
        "selection-one",
        v.candidate(),
        v.authorization,
      ),
    ).rejects.toThrow();
    expect(
      await v.repository.consultSelection(
        fence,
        "selection-one",
        v.candidate(),
      ),
    ).toBe(true);
    v.tables.destinations[0].version = 2;
    expect(
      await v.repository.consultSelection(
        fence,
        "selection-one",
        v.candidate(),
      ),
    ).toBe(false);
    expect(v.tables.destinations).toHaveLength(1);
  });
  it.each(["account", "bank"] as const)(
    "future native %s observation cannot be hidden by the other valid time",
    async (channel) => {
      const v = fixture();
      await v.select();
      const base = v.observation();
      const prepared = v.observation(
        channel === "account"
          ? {
              account: {
                ...base.account,
                observedAt: "2026-10-13T00:00:04.000123Z",
              },
            }
          : {
              bank: { ...base.bank, observedAt: "2026-10-13T00:00:04.000123Z" },
            },
      );
      const original = structuredClone(v.tables);
      await expect(v.append(prepared)).rejects.toThrow();
      expect(v.tables).toEqual(original);
    },
  );
  it("an older bank source order cannot be refreshed by a newer account proof", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    const prepared = v.observation({
      account: {
        ...base.account,
        sourceId: "account-source-two",
        sourceOrder: "9007199254740994",
        observedAt: "2026-10-13T00:00:02.000123Z",
      },
      bank: {
        ...base.bank,
        sourceId: "bank-source-older",
        sourceOrder: "9007199254740994",
      },
    });
    await expect(v.append(prepared)).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("a same-order positive with a new native account ID cannot replace the original", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    await expect(
      v.append(
        v.observation({
          account: {
            ...base.account,
            sourceId: "account-fork",
            observedAt: "2026-10-13T00:00:02.000123Z",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it.each(["account", "capability", "bank"] as const)(
    "retained native %s restrictions require their release policy despite positive current columns",
    async (channel) => {
      const v = fixture();
      await v.select();
      const base = v.observation();
      await v.append(
        v.observation({
          account: {
            ...base.account,
            state: channel === "account" ? "SUSPENDED" : "APPROVED",
            receiving: channel !== "capability",
          },
          bank: {
            ...base.bank,
            state: channel === "bank" ? "REJECTED" : "VERIFIED",
          },
        }),
      );
      Object.assign(v.tables.accounts[0], {
        provider_account_state: "APPROVED",
        receiving_capability: true,
        withdrawal_capability: true,
        commercial_enabled: true,
      });
      v.tables.destinations[0].bank_state = "VERIFIED";
      v.state.clock = "2026-10-13T00:00:03.001123Z";
      const denied =
        channel === "account"
          ? "ACCOUNT_RELEASE"
          : channel === "bank"
            ? "BANK_RELEASE"
            : "CAPABILITY_RELEASE";
      v.options.readCurrentPolicy.mockImplementation(
        async (action) => action !== denied,
      );
      const original = structuredClone(v.tables);
      await expect(
        v.append(
          v.observation({
            account: {
              ...base.account,
              sourceId: "account-release",
              sourceOrder: "9007199254740994",
              observedAt: "2026-10-13T00:00:02.000123Z",
            },
            bank:
              channel === "bank"
                ? {
                    ...base.bank,
                    sourceId: "bank-release",
                    sourceOrder: "9007199254740996",
                    observedAt: "2026-10-13T00:00:01.000321Z",
                  }
                : base.bank,
          }),
        ),
      ).rejects.toThrow();
      expect(v.tables).toEqual(original);
      expect(v.options.readCurrentPolicy).toHaveBeenCalledWith(
        denied,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
    },
  );
  it.each([false, true])(
    "equal-order native restrictions dominate regardless of retained row traversal (reverse=%s)",
    async (reverse) => {
      const v = fixture();
      await v.select();
      await v.append();
      const base = v.observation();
      v.state.clock = "2026-10-13T00:00:03.001123Z";
      await v.append(
        v.observation({
          account: {
            ...base.account,
            sourceId: "account-restriction",
            state: "BLOCKED",
            receiving: false,
          },
        }),
      );
      if (reverse) v.tables.evidence.reverse();
      Object.assign(v.tables.accounts[0], {
        provider_account_state: "APPROVED",
        receiving_capability: true,
      });
      v.state.clock = "2026-10-13T00:00:03.002123Z";
      v.state.release = false;
      const original = structuredClone(v.tables);
      await expect(
        v.append(
          v.observation({
            account: {
              ...base.account,
              sourceId: "account-release",
              sourceOrder: "9007199254740994",
              observedAt: "2026-10-13T00:00:02.000123Z",
            },
          }),
        ),
      ).rejects.toThrow();
      expect(v.tables).toEqual(original);
    },
  );
  it("unsafe masks in any historical destination fail closed before selecting another version", async () => {
    const v = fixture();
    await v.select();
    await v.select("selection-two");
    v.tables.destinations[0].masked_descriptor = "Account 123456789012";
    const original = structuredClone(v.tables);
    await expect(
      v.repository.captureSelection(v.scope(), v.authorization),
    ).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it.each(["PENDING", "UNVERIFIED"] as const)(
    "retained %s without native bank proof requires release before the first verified proof",
    async (state) => {
      const v = fixture();
      await v.select();
      const base = v.observation();
      await v.append(
        v.observation({
          bank: { sourceId: null, sourceOrder: null, observedAt: null, state },
        }),
      );
      v.tables.destinations[0].bank_state = "VERIFIED";
      v.state.clock = "2026-10-13T00:00:03.001123Z";
      v.options.readCurrentPolicy.mockImplementation(
        async (action) => action !== "BANK_RELEASE",
      );
      const firstProof = v.observation({
        bank: { ...base.bank, sourceOrder: "1" },
      });
      const original = structuredClone(v.tables);
      await expect(v.append(firstProof)).rejects.toThrow();
      expect(v.tables).toEqual(original);
      expect(v.options.readCurrentPolicy).toHaveBeenCalledWith(
        "BANK_RELEASE",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
      v.options.readCurrentPolicy.mockImplementation(async () => true);
      await v.append(firstProof);
      v.state.clock = "2026-10-13T00:00:03.002123Z";
      v.options.readCurrentPolicy.mockImplementation(
        async (action) => action !== "BANK_RELEASE",
      );
      await v.append(
        v.observation({
          account: {
            ...base.account,
            sourceId: "account-after-bank-release",
            sourceOrder: "9007199254740994",
            observedAt: "2026-10-13T00:00:02.000123Z",
          },
          bank: firstProof.bank,
        }),
      );
      expect(v.tables.evidence).toHaveLength(3);
    },
  );
  it("a new current fence and explicit strictly newer trusted release can lift the original suspension", async () => {
    const v = fixture();
    await v.select();
    const base = v.observation();
    await v.append(
      v.observation({
        account: {
          ...base.account,
          state: "SUSPENDED",
          receiving: false,
          withdrawal: false,
          commercial: false,
        },
      }),
    );
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    await v.append(
      v.observation({
        account: {
          ...base.account,
          sourceId: "account-release",
          sourceOrder: "9007199254740994",
          observedAt: "2026-10-13T00:00:02.000123Z",
        },
      }),
    );
    expect(v.tables.accounts[0]).toMatchObject({
      provider_account_state: "APPROVED",
      receiving_capability: true,
    });
    expect(v.tables.evidence).toHaveLength(2);
    v.state.clock = "2026-10-13T00:00:03.002123Z";
    v.state.release = false;
    await v.append(
      v.observation({
        account: {
          ...base.account,
          sourceId: "account-after-release",
          sourceOrder: "9007199254740995",
          observedAt: "2026-10-13T00:00:02.001123Z",
        },
      }),
    );
    expect(v.tables.evidence).toHaveLength(3);
  });
  it("a native callback captured before the current destination changed cannot move its proof", async () => {
    const v = fixture();
    await v.select();
    const fence = await v.repository.captureObservation(v.scope());
    const prepared = v.observation();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    await v.select("selection-two");
    const original = structuredClone(v.tables);
    await expect(
      v.repository.appendObservation(fence, prepared),
    ).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it("revoked native release policy during persistence rolls back all new positive projections", async () => {
    const v = fixture();
    await v.select();
    const original = structuredClone(v.tables);
    v.state.revokeReleaseOnInsert = true;
    await expect(v.append()).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it.each(["order", "state", "time", "capability"])(
    "same-account-source %s conflict spans both new bank component and destination version",
    async (change) => {
      const v = fixture();
      await v.select();
      await v.append();
      v.state.clock = "2026-10-13T00:00:03.001123Z";
      await v.select("selection-two");
      const base = v.observation();
      const account = { ...base.account };
      if (change === "order") account.sourceOrder = "9007199254740994";
      if (change === "state") account.state = "BLOCKED";
      if (change === "time") account.observedAt = "2026-10-13T00:00:01.000124Z";
      if (change === "capability") account.receiving = false;
      const prepared = v.observation({
        account,
        bank: {
          ...base.bank,
          sourceId: "bank-source-two",
          sourceOrder: "9007199254740996",
        },
      });
      const original = structuredClone(v.tables);
      await expect(v.append(prepared)).rejects.toThrow();
      expect(v.tables).toEqual(original);
    },
  );
  it.each(["order", "state", "time"])(
    "same-bank-source %s conflict spans new account component and destination version",
    async (change) => {
      const v = fixture();
      await v.select();
      await v.append();
      v.state.clock = "2026-10-13T00:00:03.001123Z";
      await v.select("selection-two");
      const base = v.observation();
      const bank = { ...base.bank };
      if (change === "order") bank.sourceOrder = "9007199254740996";
      if (change === "state") bank.state = "REJECTED";
      if (change === "time") bank.observedAt = "2026-10-13T00:00:00.000322Z";
      const prepared = v.observation({
        account: {
          ...base.account,
          sourceId: "account-source-two",
          sourceOrder: "9007199254740994",
          observedAt: "2026-10-13T00:00:02.000123Z",
        },
        bank,
      });
      const original = structuredClone(v.tables);
      await expect(v.append(prepared)).rejects.toThrow();
      expect(v.tables).toEqual(original);
    },
  );
  it("unknown receipt in a historical destination is not an empty current floor", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    await v.select("selection-two");
    v.tables.evidence[0].verification_reference = "legacy-unknown";
    const original = structuredClone(v.tables);
    await expect(v.repository.captureObservation(v.scope())).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it("nonverifiable caller bundle performs no transaction or evidence write", async () => {
    const v = fixture();
    await v.select();
    const original = structuredClone(v.tables);
    const fence = await v.repository.captureObservation(v.scope());
    const count = v.queries.length;
    await expect(
      v.repository.appendObservation(fence, {
        ...v.observation(),
        verifiable: false,
      } as never),
    ).rejects.toThrow();
    expect(v.queries).toHaveLength(count);
    expect(v.tables).toEqual(original);
  });
  it("missing current policy cannot read or mutate a scope", async () => {
    const v = fixture();
    const repository = createReceivingVerificationRepository(v.db, {
      ...v.options,
      readCurrentPolicy: undefined,
    });
    await expect(
      repository.captureSelection(v.scope(), v.authorization),
    ).rejects.toThrow("Receiving verification unavailable");
    expect(v.queries).toHaveLength(0);
  });
  it("first selection establishes only the trusted operator mapping and genuine pending destination", async () => {
    const v = fixture();
    const original = structuredClone(v.tables);
    const fence = await v.select();
    expect(v.tables.accounts[0]).toMatchObject({
      operator_reference: "native-operator",
      provider_account_state: "UNVERIFIED",
      receiving_capability: false,
      withdrawal_capability: false,
      commercial_enabled: false,
      observed_at: null,
    });
    expect(v.tables.destinations[0]).toMatchObject({
      id: "selection-one",
      version: 1,
      bank_reference: "native-bank",
      bank_state: "PENDING",
      is_current: true,
    });
    expect(v.tables.evidence).toHaveLength(0);
    expect(v.tables.operations).toEqual(original.operations);
    for (const field of [
      "account_reference",
      "recipient_reference",
      "credential_version",
      "credential_key_id",
      "credential_nonce",
      "credential_ciphertext",
      "credential_tag",
    ])
      expect(v.tables.accounts[0][field]).toEqual(original.accounts[0][field]);
    expect(
      await v.repository.consultSelection(
        fence,
        "selection-one",
        v.candidate(),
      ),
    ).toBe(true);
    const sql = v.queries.map((query) => query.sql).join("\n");
    expect(sql).toMatch(/FOR UPDATE OF st/);
    expect(sql).toMatch(/FOR SHARE OF u/);
    expect(sql).toMatch(/FOR SHARE OF se/);
    expect(sql).toMatch(/FOR SHARE OF m/);
    expect(sql).not.toMatch(
      /INSERT INTO "(receiving_account|financial_operation)"/,
    );
  });
  it("a same captured selection cannot reactivate or allocate another version", async () => {
    const v = fixture();
    const fence = await v.select();
    const original = structuredClone(v.tables);
    await expect(
      v.repository.selectDestination(
        fence,
        "selection-two",
        v.candidate(),
        v.authorization,
      ),
    ).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it("monotonic replacement preserves old immutable destination and operation history", async () => {
    const v = fixture();
    await v.select();
    const original = structuredClone(v.tables.destinations[0]);
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    await v.select("selection-two");
    expect(v.tables.destinations).toHaveLength(2);
    expect(v.tables.destinations[0]).toEqual({
      ...original,
      is_current: false,
    });
    expect(v.tables.destinations[1]).toMatchObject({
      version: 2,
      is_current: true,
    });
  });
  it.each([
    "active",
    "session",
    "membership",
    "policy",
    "owner-role",
    "proof",
    "wait-expiry",
  ])("current %s denial prevents destination mutation", async (change) => {
    const v = fixture();
    const fence = await v.repository.captureSelection(
      v.scope(),
      v.authorization,
    );
    const original = structuredClone(v.tables);
    if (change === "active") v.state.active = false;
    if (change === "session") v.state.session = false;
    if (change === "membership") v.state.membership = false;
    if (change === "policy") v.state.policy = false;
    if (change === "owner-role") v.state.role = "OWNER";
    if (change === "wait-expiry") v.state.expireDuringPolicy = true;
    const auth =
      change === "proof"
        ? {
            ...v.authorization,
            recentAuth: {
              ...v.authorization.recentAuth,
              expiresAt: new Date("2026-10-13T00:00:03Z"),
            },
          }
        : v.authorization;
    await expect(
      v.repository.selectDestination(
        fence,
        "selection-one",
        v.candidate(),
        auth,
      ),
    ).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it.each([
    "foreign-account",
    "unsettled-original",
    "history-only",
    "unknown-receipt",
  ])("relevant %s cannot become an empty/approved scope", async (change) => {
    const v = fixture();
    if (change === "foreign-account")
      v.tables.accounts.push({
        ...v.tables.accounts[0],
        id: "foreign-account",
      });
    if (change === "unsettled-original")
      v.tables.operations[0].state = "UNKNOWN";
    if (change === "history-only")
      v.tables.destinations.push({
        id: "legacy",
        site_id: "site-one",
        account_id: "account-one",
        environment: "sandbox",
        version: 4,
        bank_reference: "old-bank",
        masked_descriptor: null,
        bank_state: "PENDING",
        is_current: false,
        created_at: "2026-10-13T00:00:00Z",
      });
    if (change === "unknown-receipt") {
      await v.select();
      v.tables.evidence.push({
        id: "legacy-evidence",
        site_id: "site-one",
        account_id: "account-one",
        environment: "sandbox",
        destination_version: 1,
        verification_reference: "legacy-unknown",
      });
    }
    await expect(
      v.repository.captureSelection(v.scope(), v.authorization),
    ).rejects.toThrow();
  });
  it("one microsecond changed account fence rejects a late original observation", async () => {
    const v = fixture();
    await v.select();
    const fence = await v.repository.captureObservation(v.scope());
    v.tables.accounts[0].updated_at = "2026-10-13T00:00:03.000124Z";
    await expect(
      v.repository.appendObservation(fence, v.observation()),
    ).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(0);
  });
  it("verifiable account UNVERIFIED retains the exact bank proof/time without READY", async () => {
    const v = fixture();
    await v.select();
    const base = v.observation();
    const value = v.observation({
      account: {
        ...base.account,
        state: "UNVERIFIED",
        receiving: false,
        withdrawal: false,
        commercial: false,
      },
    });
    await v.append(value);
    const evidence = v.tables.evidence[0],
      account = v.tables.accounts[0],
      destination = v.tables.destinations[0];
    expect(evidence).toMatchObject({
      verification_status: "VERIFIED",
      provider_account_state: "UNVERIFIED",
      bank_state: "VERIFIED",
      bank_observed_at: "2026-10-13T00:00:00.000321Z",
    });
    const binding = {
      siteId: "site-one",
      provider: "ASAAS",
      operatorReference: "native-operator",
      environment: "sandbox" as const,
      accountReference: "native-account",
      recipientReference: "native-wallet",
      destinationVersion: 1,
      bankReference: "native-bank",
    };
    expect(
      evaluateReceivingReadiness({
        siteId: "site-one",
        isDemo: false,
        environment: "test",
        mode: "sandbox",
        providerBinding: binding,
        evidence: {
          ...binding,
          verification: "verified",
          provenance: "provider",
          accountState: "onboarding",
          bankState:
            destination.bank_state === "VERIFIED" ? "verified" : "pending",
          observedAt: new Date(String(account.observed_at)),
          bankObservedAt: new Date(String(evidence.bank_observed_at)),
          capabilities: {
            receiving: account.receiving_capability === true,
            withdrawal: account.withdrawal_capability === true,
          },
          commercialEnabled: account.commercial_enabled === true,
        },
        now: new Date(v.state.clock),
        freshnessMs: 60000,
      }),
    ).toMatchObject({ catalogEligible: false, state: "ONBOARDING" });
  });
  it("an evidence insert failure rolls back both account and bank projections", async () => {
    const v = fixture();
    await v.select();
    const original = structuredClone(v.tables);
    v.state.failEvidence = true;
    await expect(v.append()).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it("lost evidence commit ACK is resolved only by original exact receipt consultation", async () => {
    const v = fixture();
    await v.select();
    const fence = await v.repository.captureObservation(v.scope());
    const value = v.observation();
    v.state.lostCommit = true;
    await expect(
      v.repository.appendObservation(fence, value),
    ).rejects.toThrow();
    expect(await v.repository.consultObservation(value)).toBe(true);
    const changed = v.observation({
      account: { ...value.account, sourceOrder: "9007199254740994" },
    });
    expect(await v.repository.consultObservation(changed)).toBe(false);
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("changing account source order is conflict even with a new bank component", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    const changed = v.observation({
      account: { ...base.account, sourceOrder: "9007199254740994" },
      bank: {
        ...base.bank,
        sourceId: "bank-source-two",
        sourceOrder: "9007199254740996",
      },
    });
    await expect(v.append(changed)).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("changing retained bank proof semantics is conflict with a new account component", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    const changed = v.observation({
      account: {
        ...base.account,
        sourceId: "account-source-two",
        sourceOrder: "9007199254740994",
        observedAt: "2026-10-13T00:00:02.000123Z",
      },
      bank: { ...base.bank, observedAt: "2026-10-13T00:00:00.000322Z" },
    });
    await expect(v.append(changed)).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("a local destination version cannot hide changed same-account-source facts", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    await v.select("selection-two");
    const base = v.observation();
    await expect(
      v.append(
        v.observation({ account: { ...base.account, state: "BLOCKED" } }),
      ),
    ).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("an account refresh never changes the original bank receipt or proof time", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    const next = v.observation({
      account: {
        ...base.account,
        sourceId: "account-source-two",
        sourceOrder: "9007199254740994",
        observedAt: "2026-10-13T00:00:02.000123Z",
      },
    });
    await v.append(next);
    expect(v.tables.evidence).toHaveLength(2);
    expect(v.tables.evidence[1].bank_observed_at).toBe(
      v.tables.evidence[0].bank_observed_at,
    );
    expect(v.tables.evidence[1].verification_reference).toBe(
      next.verificationReference,
    );
  });
  it("late positive captured before a newer suspension cannot rebase or restore eligibility", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    const old = await v.repository.captureObservation(v.scope());
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    const base = v.observation();
    await v.append(
      v.observation({
        account: {
          ...base.account,
          sourceId: "account-suspend",
          sourceOrder: "9007199254740994",
          state: "SUSPENDED",
          observedAt: "2026-10-13T00:00:02.000123Z",
          receiving: false,
          withdrawal: false,
          commercial: false,
        },
      }),
    );
    const original = structuredClone(v.tables);
    const late = v.observation({
      account: {
        ...base.account,
        sourceId: "account-release",
        sourceOrder: "9007199254740995",
        observedAt: "2026-10-13T00:00:02.001123Z",
      },
    });
    await expect(v.repository.appendObservation(old, late)).rejects.toThrow();
    expect(v.tables).toEqual(original);
  });
  it("current suspension requires explicit newer native release policy, not just newer source order", async () => {
    const v = fixture();
    await v.select();
    const base = v.observation();
    await v.append(
      v.observation({
        account: {
          ...base.account,
          state: "SUSPENDED",
          receiving: false,
          withdrawal: false,
          commercial: false,
        },
      }),
    );
    v.state.clock = "2026-10-13T00:00:03.001123Z";
    v.state.release = false;
    const next = v.observation({
      account: {
        ...base.account,
        sourceId: "account-release",
        sourceOrder: "9007199254740994",
        observedAt: "2026-10-13T00:00:02.000123Z",
      },
    });
    await expect(v.append(next)).rejects.toThrow();
    expect(v.tables.accounts[0].provider_account_state).toBe("SUSPENDED");
  });
  it("equal decoded DB creation time never admits another positive or invents last+1", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.000124Z";
    const base = v.observation();
    const next = v.observation({
      account: {
        ...base.account,
        sourceId: "account-source-two",
        sourceOrder: "9007199254740994",
        observedAt: "2026-10-13T00:00:02.000123Z",
      },
    });
    await expect(v.append(next)).rejects.toThrow();
    expect(v.tables.evidence).toHaveLength(1);
  });
  it("a genuine newer restriction may persist at equal decoded time and still blocks", async () => {
    const v = fixture();
    await v.select();
    await v.append();
    v.state.clock = "2026-10-13T00:00:03.000124Z";
    const base = v.observation();
    await v.append(
      v.observation({
        account: {
          ...base.account,
          sourceId: "account-blocked",
          sourceOrder: "9007199254740994",
          state: "BLOCKED",
          observedAt: "2026-10-13T00:00:02.000123Z",
          receiving: false,
          withdrawal: false,
          commercial: false,
        },
      }),
    );
    expect(v.tables.accounts[0].provider_account_state).toBe("BLOCKED");
    expect(v.tables.evidence[1].created_at).toBe(v.state.clock);
  });
});
