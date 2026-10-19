import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import {
  createWithdrawalExecutionService,
  type OriginalWithdrawal,
  type WithdrawalCompletionProof,
} from "./withdrawalExecution";
import {
  createWithdrawalPostingRepository,
  type WithdrawalPostingDatabase,
  type WithdrawalPostingPorts,
  type WithdrawalPostingRepositoryOptions,
} from "./withdrawalPostingRepository";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
} from "./withdrawalReservations";

function fixture(maximum = false) {
  const time = new Date("2026-10-14T04:00:00.000Z");
  const sqlClock = { value: time.toISOString() };
  const actor = {
    siteId: "site-1",
    userId: "operator-1",
    sessionId: "session-1",
  };
  const intent = {
    id: "withdrawal-1",
    siteId: actor.siteId,
    amountCents: 10000,
    feeCents: 500,
    ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
    netCents: 9500,
    currency: "BRL" as const,
    destinationVersion: 3,
    state: "REQUESTED" as const,
    mode: "sandbox" as const,
    createdAt: time.toISOString(),
    updatedAt: time.toISOString(),
  };
  const feeQuote = {
    feeCents: 500,
    ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
    policyVersion: "fee-v1",
    provenance: "provider" as const,
    observedAt: time.toISOString(),
    expiresAt: new Date(+time + 60000).toISOString(),
  };
  const snapshot = {
    intent,
    requestId: "request-1",
    accountId: "account-1",
    operatorUserId: actor.userId,
    accountReference: "acct-1",
    recipientReference: "recipient-1",
    bankReference: "bank-1",
    environment: "sandbox" as const,
    operationId: "operation-1",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          actor.siteId,
          "request-1",
          actor.userId,
          "sandbox",
          10000,
          3,
        ]),
      )
      .digest("hex"),
    authenticationAuditHash: "a".repeat(64),
    feeQuote,
    balance: { balanceCents: 15000, observedAt: time.toISOString() },
  };
  const scope = {
    siteId: actor.siteId,
    accountId: snapshot.accountId,
    accountReference: snapshot.accountReference,
    environment: snapshot.environment,
    bankReference: snapshot.bankReference,
    destinationVersion: 3,
    amountCents: 10000,
    currency: "BRL" as const,
  };
  const presentation = {
    ...scope,
    source: "stored" as const,
    verification: "verified" as const,
    provenance: "provider" as const,
    operatorUserId: actor.userId,
    recipientReference: snapshot.recipientReference,
    destinationId: "destination-3",
    evidenceId: "evidence-1",
    verificationReference: "verification-1",
    evidenceObservedAt: new Date(time),
    bankObservedAt: new Date(time),
    operatorProfileUpdatedAt: new Date(time),
    maskedDestination: "Bank **** 1234",
    operatorDisplayName: "Original Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: actor.siteId,
      requestId: snapshot.requestId,
      mode: "sandbox",
      amountCents: 10000,
      feeCents: 500,
      ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
      netCents: 9500,
      currency: "BRL",
      destinationVersion: 3,
      maskedDestination: presentation.maskedDestination,
      operatorDisplayName: presentation.operatorDisplayName,
      policyVersion: feeQuote.policyVersion,
      issuedAt: time.toISOString(),
      expiresAt: feeQuote.expiresAt,
    },
    scope,
    operatorUserId: actor.userId,
    recipientReference: snapshot.recipientReference,
    presentation: {
      ...presentation,
      evidenceObservedAt: time.toISOString(),
      bankObservedAt: time.toISOString(),
      operatorProfileUpdatedAt: time.toISOString(),
    },
    feeQuote,
  });
  const consent = {
    snapshot: consentSnapshot,
    previewHash: hashWithdrawalConsentSnapshot(consentSnapshot),
    state: "COMMITTED" as const,
    requestRevision: "2" as const,
  };
  const correlation = {
    ...scope,
    requestId: snapshot.requestId,
    requestHash: snapshot.requestHash,
    withdrawalId: intent.id,
    operationId: snapshot.operationId,
    recipientReference: snapshot.recipientReference,
    operatorUserId: actor.userId,
    feeCents: 500,
    netCents: 9500,
    policyVersion: feeQuote.policyVersion,
  };
  const holderBinding = {
    correlation,
    consentHash: consent.previewHash,
    bindingReference: "binding-1",
    holderUserId: "bride-1",
    holderConsentReference: "holder-consent-1",
    actingUserId: actor.userId,
    holderRole: "BRIDE_HOLDER" as const,
    provenance: "durable" as const,
    verification: "verified" as const,
  };
  const original: OriginalWithdrawal = {
    snapshot,
    consent,
    associationId: "association-1",
    correlation,
    holderBinding,
  };
  const access = {
    siteId: actor.siteId,
    userId: actor.userId,
    membershipId: "membership-1",
    membershipRole: "SITE_ADMIN" as const,
    capabilities: {
      manageInvitations: true,
      manageMessages: true,
      manageCatalog: true,
      manageTeam: true,
      readFinance: true,
      configureReceiving: true,
      requestWithdrawal: false,
    },
  };
  const recentAuth = {
    ...actor,
    proofKind: "PASSWORD_REAUTHENTICATION" as const,
    verification: "verified" as const,
    provenance: "backend" as const,
    authenticatedAt: new Date(+time - 30000),
    expiresAt: new Date(+time + 270000),
  };
  const context = {
    siteId: actor.siteId,
    isDemo: true,
    mode: "sandbox" as const,
    verification: "verified" as const,
    accountId: "account-1",
    bankReference: "bank-1",
    recipientBinding: {
      siteId: actor.siteId,
      operatorUserId: actor.userId,
      accountReference: "acct-1",
      recipientReference: "recipient-1",
      environment: "sandbox" as const,
      destinationVersion: 3,
    },
    readiness: {
      siteId: actor.siteId,
      state: "READY" as const,
      reason: null,
      observedAt: time.toISOString(),
      destinationVersion: 3,
      catalogEligible: true,
      mode: "sandbox" as const,
    },
  };
  const authority = {
    actor,
    access,
    recentAuth,
    context,
    presentation,
    holderBinding,
  };
  const attempt = { actor, access, requestId: snapshot.requestId, recentAuth };
  const tables: Record<string, any[]> = {
    site: [{ siteId: actor.siteId, isDemo: true }],
    user: [{ userId: actor.userId, state: "ACTIVE", role: "SITE_ADMIN" }],
    session: [
      {
        userId: actor.userId,
        sessionId: actor.sessionId,
        sessionExpiresAt: new Date(+time + 3600000).toISOString(),
        lastActiveAt: time.toISOString(),
        sessionCreatedAt: new Date(+time - 3600000).toISOString(),
      },
    ],
    site_membership: [
      {
        id: "membership-1",
        siteId: actor.siteId,
        userId: actor.userId,
        role: "SITE_ADMIN",
        revokedAt: null,
      },
    ],
    receiving_account: [
      {
        id: "account-1",
        siteId: actor.siteId,
        environment: "sandbox",
        provider: "ASAAS",
        operatorUserId: actor.userId,
        accountReference: "acct-1",
        recipientReference: "recipient-1",
        isCurrent: true,
      },
    ],
    receiving_destination: [
      {
        id: "destination-3",
        siteId: actor.siteId,
        accountId: "account-1",
        environment: "sandbox",
        version: 3,
        bankReference: "bank-1",
        bankState: "VERIFIED",
        isCurrent: true,
      },
    ],
    withdrawal_intent: [
      {
        id: intent.id,
        siteId: actor.siteId,
        accountId: "account-1",
        environment: "sandbox",
        operatorUserId: actor.userId,
        destinationVersion: 3,
        requestId: snapshot.requestId,
        requestHash: snapshot.requestHash,
        authorizationReference: snapshot.authenticationAuditHash,
        policyVersion: feeQuote.policyVersion,
        amountCents: 10000,
        feeCents: 500,
        netCents: 9500,
        currency: "BRL",
        state: "REQUESTED",
        reservationState: "HELD",
        reservedCents: 10000,
        providerReference: null,
        receiptReference: null,
        resolutionObservedAt: null,
        createdAt: time.toISOString(),
        updatedAt: time.toISOString(),
      },
    ],
    financial_operation: [
      {
        id: snapshot.operationId,
        siteId: actor.siteId,
        accountId: "account-1",
        environment: "sandbox",
        kind: "WITHDRAWAL",
        state: "REQUESTED",
        requestId: snapshot.requestId,
        requestHash: snapshot.requestHash,
        requestSnapshot: snapshot,
        withdrawalIntentId: intent.id,
        orderId: null,
        paymentId: null,
        providerOperationReference: null,
        attempts: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: time.toISOString(),
        lastErrorCode: null,
        createdAt: time.toISOString(),
        updatedAt: time.toISOString(),
      },
    ],
    withdrawal_request: [
      {
        id: original.associationId,
        siteId: actor.siteId,
        accountId: "account-1",
        environment: "sandbox",
        operatorUserId: actor.userId,
        destinationVersion: 3,
        requestId: snapshot.requestId,
        previewSnapshot: consent.snapshot,
        previewHash: consent.previewHash,
        expiresAt: feeQuote.expiresAt,
        state: "COMMITTED",
        requestRevision: "2",
        withdrawalIntentId: intent.id,
        sealedAt: null,
        createdAt: time.toISOString(),
        updatedAt: time.toISOString(),
      },
    ],
    financial_ledger_entry: [],
  };
  const queries: { text: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const faults = {
    commitLost: false,
    failWrite: 0,
    writes: 0,
    onQuery: null as ((text: string, params: unknown[]) => void) | null,
  };
  const camel = (text: string) =>
    text.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  function equal(left: unknown, right: unknown) {
    if (
      typeof left === "object" &&
      left &&
      typeof right === "string" &&
      right.startsWith("{")
    )
      return isDeepStrictEqual(left, JSON.parse(right));
    if (
      typeof left === "string" &&
      typeof right === "string" &&
      /^\d{4}-\d{2}-\d{2}[T ]/.test(left)
    )
      return (
        databaseTimestampEpochMicroseconds(left) ===
        databaseTimestampEpochMicroseconds(right)
      );
    return isDeepStrictEqual(left, right);
  }
  function matches(row: any, text: string, params: unknown[]) {
    for (const match of text.matchAll(
      /(?:w|op|r|a|d|st|u|se|m|le)\.([a-z_]+)\s*=\s*(\$\d+|'[^']*'|\d+)/g,
    )) {
      const key = camel(match[1]);
      const raw = match[2];
      const value = raw.startsWith("$")
        ? params[Number(raw.slice(1)) - 1]
        : raw.startsWith("'")
          ? raw.slice(1, -1)
          : Number(raw);
      if (key in row && !equal(row[key], value)) return false;
    }
    for (const match of text.matchAll(
      /(?:w|op|r|a|d|st|u|se|m|le)\.([a-z_]+) IS NULL/g,
    ))
      if (row[camel(match[1])] !== null) return false;
    for (const match of text.matchAll(/(?:w|op)\.([a-z_]+) IN \(([^)]+)\)/g))
      if (
        !match[2]
          .split(",")
          .map((s) => s.trim().replaceAll("'", ""))
          .includes(row[camel(match[1])])
      )
        return false;
    return true;
  }
  const execute = vi.fn(async (statement: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(statement);
    queries.push({ text, params });
    faults.onQuery?.(text, params);
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
    if (/SELECT clock_timestamp/.test(text))
      return { rows: [{ currentTime: sqlClock.value }] };
    const table = /(?:FROM|UPDATE|INTO) "([a-z_]+)"/.exec(text)?.[1];
    if (!table || !tables[table])
      throw new Error(`Unsupported fixture SQL: ${text}`);
    if (/^UPDATE/.test(text)) {
      faults.writes++;
      if (faults.failWrite === faults.writes) return { rows: [] };
      const row = tables[table].find((row) =>
        matches(row, text.split(" WHERE ")[1], params),
      );
      if (!row) return { rows: [] };
      for (const assignment of text
        .split(" SET ")[1]
        .split(" WHERE ")[0]
        .split(",")) {
        const match = /^\s*([a-z_]+)=(\$\d+|'[^']*'|\d+|NULL)/.exec(assignment);
        if (!match)
          throw new Error(`Unsupported fixture assignment: ${assignment}`);
        const raw = match[2];
        row[camel(match[1])] = raw.startsWith("$")
          ? params[Number(raw.slice(1)) - 1]
          : raw === "NULL"
            ? null
            : raw.startsWith("'")
              ? raw.slice(1, -1)
              : Number(raw);
      }
      return { rows: [{ id: row.id }] };
    }
    if (/^INSERT/.test(text)) {
      faults.writes++;
      if (faults.failWrite === faults.writes) return { rows: [] };
      const match = /\(([^)]+)\) VALUES \(([^)]+)\)/.exec(text)!;
      const fields = match[1]
        .split(",")
        .map((s) => camel(s.trim().replaceAll('"', "")));
      const values = match[2].split(",");
      const row: any = {};
      fields.forEach((field, index) => {
        const raw = values[index].trim();
        row[field] = raw.startsWith("$")
          ? params[Number(raw.match(/^\$(\d+)/)?.[1]) - 1]
          : raw === "NULL"
            ? null
            : raw.startsWith("'")
              ? raw.slice(1, -1)
              : Number(raw);
      });
      if (
        tables[table].some(
          (r) =>
            r.effectKey === row.effectKey &&
            r.siteId === row.siteId &&
            r.accountId === row.accountId &&
            r.environment === row.environment,
        )
      )
        throw new Error("unique effect");
      tables[table].push(row);
      return { rows: [{ id: row.id }] };
    }
    if (table === "financial_ledger_entry")
      return {
        rows: structuredClone(
          tables[table]
            .filter(
              (r) =>
                r.siteId === params[0] &&
                r.accountId === params[1] &&
                r.environment === params[2] &&
                (r.effectKey === params[3] ||
                  r.withdrawalIntentId === params[4] ||
                  r.operationId === params[5]),
            )
            .slice(0, 2),
        ),
      };
    if (/ AS "collisionId"/.test(text)) {
      const referenceColumn =
        table === "financial_operation"
          ? "providerOperationReference"
          : /receipt_reference/.test(text)
            ? "receiptReference"
            : "providerReference";
      return {
        rows: tables[table]
          .filter((r) => r[referenceColumn] === params[0] && r.id !== params[1])
          .map((r) => ({ collisionId: r.id }))
          .slice(0, 2),
      };
    }
    return {
      rows: structuredClone(
        tables[table]
          .filter((row) => matches(row, text, params))
          .slice(0, /LIMIT 2/.test(text) ? 2 : undefined),
      ),
    };
  });
  let queue: Promise<unknown> = Promise.resolve();
  const db = {
    execute,
    transaction: vi.fn((callback: (tx: any) => Promise<any>) => {
      const result = queue.then(async () => {
        const before = structuredClone(tables);
        let committed = false;
        try {
          const value = await callback({ execute });
          committed = true;
          if (faults.commitLost) throw new Error("lost commit acknowledgement");
          return value;
        } catch (error) {
          if (!committed) {
            for (const key of Object.keys(tables)) tables[key] = before[key];
          }
          throw error;
        }
      });
      queue = result.catch(() => undefined);
      return result;
    }),
  } as unknown as WithdrawalPostingDatabase;
  let proof: WithdrawalCompletionProof | null = null;
  const ports: WithdrawalPostingPorts = {
    loadOriginalHolderConsentInTransaction: vi.fn(async () =>
      structuredClone(holderBinding),
    ),
    loadDispatchAuthorityInTransaction: vi.fn(async () =>
      structuredClone(authority),
    ),
    loadCompletionProofInTransaction: vi.fn(async () => structuredClone(proof)),
  };
  const options: WithdrawalPostingRepositoryOptions = {
    mode: "sandbox",
    applicationEnvironment: "test",
    maxAuthAgeMs: 300000,
    freshnessMs: 300000,
    leaseOwner: "worker-1",
    leaseDurationMs: 60000,
    now: () => new Date(time),
    generateLeaseToken: vi.fn(() => "token-1"),
    ports,
  };
  const repository = createWithdrawalPostingRepository(db, options);
  async function arm() {
    const result = await repository.armExisting(attempt);
    expect(result.outcome).toBe("ARMED");
    if (result.outcome !== "ARMED") throw new Error("Expected arm");
    return result;
  }
  function makeProof(armed: Awaited<ReturnType<typeof arm>>) {
    proof = {
      outcome: "COMPLETED",
      correlation: structuredClone(armed.original.correlation),
      holderBinding: structuredClone(armed.original.holderBinding),
      fence: structuredClone(armed.fence),
      proofReference: "bank-receipt-1",
      receiptReference: "bank-receipt-1",
      providerReference: "transfer-1",
      totalDebitCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL",
      bankCompleted: true,
      custody: "immutable-durable",
      verification: "verified",
      provenance: "provider",
      observedAt: time.toISOString(),
      recordedAt: time.toISOString(),
    };
    return proof;
  }
  return {
    time,
    sqlClock,
    tables,
    queries,
    faults,
    db,
    ports,
    options,
    repository,
    attempt,
    actor,
    original,
    authority,
    holderBinding,
    arm,
    makeProof,
    get proof() {
      return proof;
    },
    set proof(value) {
      proof = value;
    },
  };
}

describe("private withdrawal posting repository", () => {
  it("loads only exact existing rows with bounded parameterized queries and durable original holder custody", async () => {
    const f = fixture();
    const stored = await f.repository.readExisting({
      siteId: "site-1",
      requestId: "request-1",
    });
    expect(stored?.original).toEqual(f.original);
    expect(stored?.reservedCents).toBe(10000);
    for (const table of [
      "withdrawal_intent",
      "financial_operation",
      "withdrawal_request",
    ])
      expect(
        f.queries.find((q) => q.text.includes(`FROM "${table}"`))?.text,
      ).toContain("LIMIT 2");
    expect(f.queries.some((q) => q.params.includes("request-1"))).toBe(true);
    expect(f.queries.some((q) => /^INSERT|^UPDATE/.test(q.text))).toBe(false);
  });
  it("atomically arms attempts0 once with the reservation lock order and retained exact lease", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.repository.armExisting(f.attempt),
      f.repository.armExisting(f.attempt),
    ]);
    expect([first.outcome, second.outcome]).toEqual(["ARMED", "EXISTING"]);
    expect((f.options as any).generateLeaseToken).toHaveBeenCalledTimes(1);
    expect(f.tables.financial_operation[0]).toMatchObject({
      state: "PROCESSING",
      attempts: 1,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
    });
    expect(f.tables.withdrawal_intent[0]).toMatchObject({
      state: "PROCESSING",
      reservationState: "HELD",
      reservedCents: 10000,
    });
    const index = (needle: string) =>
      f.queries.findIndex((q) => q.text.includes(needle));
    expect(index("pg_advisory_xact_lock")).toBeLessThan(index('FROM "site"'));
    expect(index('FROM "site"')).toBeLessThan(index('FROM "user"'));
    expect(index('FROM "user"')).toBeLessThan(index('FROM "session"'));
    expect(index('FROM "session"')).toBeLessThan(
      index('FROM "site_membership"'),
    );
    expect(index('FROM "site_membership"')).toBeLessThan(
      index('FROM "receiving_account"'),
    );
    expect(
      f.queries.find((q) => q.text.includes("pg_advisory_xact_lock"))?.params,
    ).toContain(
      JSON.stringify(["withdrawal-reservation", "site-1", "request-1"]),
    );
    expect(
      f.queries.find((q) => q.text.startsWith('UPDATE "financial_operation"'))
        ?.text,
    ).toMatch(/attempts=0/);
  });
  it.each([
    "holderMissing",
    "holderForeign",
    "holderChanging",
    "holderActor",
    "roleOnly",
    "authorityMissing",
    "actor",
    "session",
    "membership",
    "context",
    "presentation",
    "consent",
    "submillisecondExpiry",
    "awaitExpiry",
  ])(
    "denies first dispatch for %s without changing the full hold",
    async (kind) => {
      const f = fixture();
      if (kind === "holderMissing")
        vi.mocked(
          f.ports.loadOriginalHolderConsentInTransaction,
        ).mockResolvedValue(null);
      if (kind === "holderForeign")
        f.holderBinding.correlation.accountId = "foreign";
      if (kind === "holderChanging")
        vi.mocked(f.ports.loadOriginalHolderConsentInTransaction)
          .mockResolvedValueOnce(structuredClone(f.holderBinding))
          .mockResolvedValue({
            ...f.holderBinding,
            bindingReference: "changed",
          });
      if (kind === "holderActor") f.holderBinding.actingUserId = "foreign";
      if (kind === "roleOnly")
        (f.holderBinding as any).holderRole = "SITE_ADMIN";
      if (kind === "authorityMissing")
        vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mockResolvedValue(
          null,
        );
      if (kind === "actor") f.authority.actor.userId = "foreign";
      if (kind === "session")
        f.tables.session[0].sessionExpiresAt = f.time.toISOString();
      if (kind === "membership")
        f.tables.site_membership[0].revokedAt = f.time.toISOString();
      if (kind === "context") f.authority.context.accountId = "replacement";
      if (kind === "presentation")
        f.authority.presentation.bankReference = "replacement";
      if (kind === "consent")
        f.tables.withdrawal_request[0].previewHash = "b".repeat(64);
      if (kind === "submillisecondExpiry") {
        f.authority.recentAuth.expiresAt = new Date(+f.time + 1);
        f.sqlClock.value = "2026-10-14T04:00:00.001001Z";
      }
      if (kind === "awaitExpiry")
        vi.mocked(
          f.ports.loadDispatchAuthorityInTransaction,
        ).mockImplementation(async () => {
          f.sqlClock.value = "2026-10-14T04:01:00.000001Z";
          return structuredClone(f.authority);
        });
      expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
        "DENIED",
      );
      expect(f.tables.withdrawal_intent[0]).toMatchObject({
        state: "REQUESTED",
        reservedCents: 10000,
      });
      expect(f.tables.financial_operation[0].attempts).toBe(0);
      expect(f.queries.some((q) => /^UPDATE/.test(q.text))).toBe(false);
    },
  );
  it.each(["snapshot", "moneyPrecision", "ambiguous", "foreignAssociation"])(
    "rejects inconsistent stored %s",
    async (kind) => {
      const f = fixture();
      if (kind === "snapshot")
        f.tables.financial_operation[0].requestSnapshot = {
          ...f.original.snapshot,
          extra: true,
        };
      if (kind === "moneyPrecision")
        f.tables.withdrawal_intent[0].amountCents = 10000.5;
      if (kind === "ambiguous")
        f.tables.withdrawal_intent.push(
          structuredClone(f.tables.withdrawal_intent[0]),
        );
      if (kind === "foreignAssociation")
        f.tables.withdrawal_request[0].withdrawalIntentId = "foreign";
      expect(
        await f.repository.readExisting({
          siteId: "site-1",
          requestId: "request-1",
        }),
      ).toBeNull();
      expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
        "DENIED",
      );
    },
  );
  it("does not grant dispatch after a lost arm commit acknowledgement and never rearms an expired lease", async () => {
    const f = fixture();
    f.faults.commitLost = true;
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
      "UNRESOLVED",
    );
    expect(f.tables.financial_operation[0].attempts).toBe(1);
    f.faults.commitLost = false;
    f.time.setTime(+f.time + 3600000);
    f.sqlClock.value = f.time.toISOString();
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
      "EXISTING",
    );
    expect((f.options as any).generateLeaseToken).toHaveBeenCalledTimes(1);
  });
  it.each(["REJECTED", "UNRESOLVED"])(
    "retains UNKNOWN and full hold after %s",
    async (outcome) => {
      const f = fixture();
      const armed = await f.arm();
      const stored = await f.repository.recordObservation(
        armed.original,
        armed.fence,
        {
          outcome,
          correlation: armed.original.correlation,
          holderBinding: armed.original.holderBinding,
          fence: armed.fence,
          ...(outcome === "REJECTED" ? { reason: "NATIVE_REJECTED" } : {}),
        } as any,
      );
      expect(stored).toMatchObject({
        state: "UNKNOWN",
        reservationState: "HELD",
        reservedCents: 10000,
        fence: armed.fence,
      });
      expect(f.tables.financial_ledger_entry).toHaveLength(0);
    },
  );
  it.each(["fence", "provider", "holder"])(
    "rejects stale/colliding observation %s",
    async (kind) => {
      const f = fixture();
      const armed = await f.arm();
      const observation: any = {
        outcome: "ACCEPTED",
        correlation: armed.original.correlation,
        holderBinding: structuredClone(armed.original.holderBinding),
        fence: structuredClone(armed.fence),
        providerReference: "transfer-1",
        observedAt: f.time.toISOString(),
        proofReference: null,
      };
      if (kind === "fence") observation.fence.leaseToken = "foreign";
      if (kind === "provider")
        f.tables.withdrawal_intent[0].providerReference =
          f.tables.financial_operation[0].providerOperationReference =
            "original-transfer";
      if (kind === "holder")
        observation.holderBinding.holderConsentReference = "foreign";
      await expect(
        f.repository.recordObservation(
          armed.original,
          armed.fence,
          observation,
        ),
      ).rejects.toThrow();
      expect(f.tables.withdrawal_intent[0].reservedCents).toBe(10000);
    },
  );
  it("posts one total debit before consuming the commitment and preserves frozen consent/lease", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    const completed = await f.repository.postCompleted(
      armed.original,
      armed.fence,
      "bank-receipt-1",
    );
    expect(completed.outcome).toBe("COMPLETED");
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
    expect(f.tables.financial_ledger_entry[0]).toMatchObject({
      amountCents: 10000,
      direction: "DEBIT",
      kind: "WITHDRAWAL_COMPLETED",
      currency: "BRL",
      withdrawalIntentId: "withdrawal-1",
      operationId: "operation-1",
      paymentId: null,
      eventId: null,
      compensatesEntryId: null,
    });
    const effect =
      "withdrawal.completed.v1:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            "site-1",
            "account-1",
            "sandbox",
            "withdrawal-1",
            "operation-1",
          ]),
        )
        .digest("hex");
    expect(f.tables.financial_ledger_entry[0].effectKey).toBe(effect);
    expect(f.tables.withdrawal_intent[0]).toMatchObject({
      state: "COMPLETED",
      reservationState: "CONSUMED",
      reservedCents: 0,
      receiptReference: "bank-receipt-1",
      providerReference: "transfer-1",
    });
    expect(f.tables.financial_operation[0]).toMatchObject({
      state: "SUCCEEDED",
      attempts: 1,
      leaseToken: armed.fence.leaseToken,
      requestSnapshot: f.original.snapshot,
    });
    expect(f.tables.withdrawal_request[0]).toMatchObject({
      state: "COMMITTED",
      previewHash: f.original.consent.previewHash,
    });
    const debit = f.queries.findIndex((q) =>
      q.text.startsWith('INSERT INTO "financial_ledger_entry"'),
    );
    const consume = f.queries.findIndex(
      (q) =>
        q.text.startsWith('UPDATE "withdrawal_intent"') &&
        q.text.includes("CONSUMED"),
    );
    expect(debit).toBeGreaterThan(-1);
    expect(debit).toBeLessThan(consume);
  });
  it.each([
    "missing",
    "foreign",
    "holder",
    "receiptIdentity",
    "fee",
    "net",
    "debit",
    "currency",
    "unverified",
    "custody",
    "bank",
    "simulationLive",
    "future",
    "submillisecondFuture",
    "chronology",
  ])("rejects absent/malformed/foreign terminal proof %s", async (kind) => {
    const f = fixture();
    const armed = await f.arm();
    const proof: any = f.makeProof(armed);
    if (kind === "missing") f.proof = null;
    if (kind === "foreign") proof.correlation.bankReference = "foreign";
    if (kind === "holder") proof.holderBinding.holderUserId = "foreign";
    if (kind === "receiptIdentity")
      proof.proofReference = "unpersisted-proof-id";
    if (kind === "fee") proof.feeCents = 400;
    if (kind === "net") proof.netCents = 9600;
    if (kind === "debit") proof.totalDebitCents = 9500;
    if (kind === "currency") proof.currency = "USD";
    if (kind === "unverified") proof.verification = "unverified";
    if (kind === "custody") proof.custody = "webhook";
    if (kind === "bank") proof.bankCompleted = false;
    if (kind === "simulationLive") {
      proof.provenance = "simulation";
      (f.options as any).applicationEnvironment =
        "production"; /* The immutable factory configuration is tested separately below. */
      f.tables.site[0].isDemo = false;
    }
    if (kind === "future")
      proof.observedAt = proof.recordedAt = new Date(+f.time + 1).toISOString();
    if (kind === "submillisecondFuture")
      proof.observedAt = proof.recordedAt = "2026-10-14T04:00:00.000001Z";
    if (kind === "chronology")
      proof.recordedAt = new Date(+f.time - 1).toISOString();
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
    expect(f.tables.withdrawal_intent[0]).toMatchObject({
      reservationState: "HELD",
      reservedCents: 10000,
    });
  });
  it("recognizes late original completion without current replacement actor/holder/readiness", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.time.setTime(+f.time + 3600000);
    f.sqlClock.value = f.time.toISOString();
    f.makeProof(armed);
    f.tables.receiving_account[0].isCurrent = false;
    f.tables.user = [];
    f.tables.session = [];
    f.tables.site_membership = [];
    vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mockResolvedValue(
      null,
    );
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("COMPLETED");
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
  });
  it("replays a lost terminal acknowledgement and concurrent completions without another debit", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    f.faults.commitLost = true;
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("UNRESOLVED");
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
    f.faults.commitLost = false;
    const results = await Promise.all([
      f.repository.postCompleted(armed.original, armed.fence, "bank-receipt-1"),
      f.repository.postCompleted(armed.original, armed.fence, "bank-receipt-1"),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["DUPLICATE", "DUPLICATE"]);
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
    const stored = await f.repository.recordObservation(
      armed.original,
      armed.fence,
      {
        outcome: "UNRESOLVED",
        correlation: armed.original.correlation,
        holderBinding: armed.original.holderBinding,
        fence: armed.fence,
      },
    );
    expect(stored.state).toBe("COMPLETED");
  });
  it.each([1, 2])("rolls back arm write/CAS boundary %s", async (boundary) => {
    const f = fixture();
    const before = structuredClone(f.tables);
    f.faults.failWrite = boundary;
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
      "UNRESOLVED",
    );
    expect(f.tables).toEqual(before);
  });
  it.each([1, 2, 3])(
    "rolls back completion write/CAS boundary %s",
    async (boundary) => {
      const f = fixture();
      const armed = await f.arm();
      f.makeProof(armed);
      const before = structuredClone(f.tables);
      f.faults.writes = 0;
      f.faults.failWrite = boundary;
      expect(
        (
          await f.repository.postCompleted(
            armed.original,
            armed.fence,
            "bank-receipt-1",
          )
        ).outcome,
      ).toBe("UNRESOLVED");
      expect(f.tables).toEqual(before);
    },
  );
  it("fails closed on effect or receipt collisions and on changed durable replay custody", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("COMPLETED");
    f.tables.financial_ledger_entry[0].amountCents = 9500;
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    f.tables.financial_ledger_entry[0].amountCents = 10000;
    vi.mocked(f.ports.loadOriginalHolderConsentInTransaction).mockResolvedValue(
      { ...f.holderBinding, holderConsentReference: "replacement" },
    );
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
  });
  it("allows only the committed-arm caller to dispatch under simultaneous and reentrant execution", async () => {
    const f = fixture();
    let service: ReturnType<typeof createWithdrawalExecutionService>;
    let reentrant: Promise<unknown> | undefined;
    const dispatch = vi.fn(async (original, fence) => {
      reentrant = service.executeExisting(f.attempt);
      return {
        outcome: "ACCEPTED" as const,
        correlation: original.correlation,
        holderBinding: original.holderBinding,
        fence,
        providerReference: "transfer-1",
        observedAt: f.time.toISOString(),
        proofReference: null,
      };
    });
    service = createWithdrawalExecutionService({
      mode: "sandbox",
      applicationEnvironment: "test",
      maxAuthAgeMs: 300000,
      now: () => new Date(f.time),
      repository: f.repository,
      dispatch: { dispatch },
      lookup: { lookup: async () => ({ outcome: "NOT_FOUND" }) },
    });
    await Promise.all([
      service.executeExisting(f.attempt),
      service.executeExisting(f.attempt),
    ]);
    await reentrant;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.tables.withdrawal_intent[0].reservedCents).toBe(10000);
  });
  it("locks the committed request before the intent and operation after the original account lock", async () => {
    const f = fixture();
    await f.arm();
    const locked = f.queries.filter((q) => /FOR UPDATE OF/.test(q.text));
    const index = (table: string) =>
      locked.findIndex((q) => q.text.includes(`FROM "${table}"`));
    expect(index("receiving_account")).toBeLessThan(
      index("withdrawal_request"),
    );
    expect(index("withdrawal_request")).toBeLessThan(
      index("withdrawal_intent"),
    );
    expect(index("withdrawal_intent")).toBeLessThan(
      index("financial_operation"),
    );
  });
  it("rejects completion custody that changes between awaited reads of the actual receipt reference", async () => {
    const f = fixture();
    const armed = await f.arm();
    const first = structuredClone(f.makeProof(armed));
    const changed = {
      ...first,
      recordedAt: new Date(+f.time - 1).toISOString(),
    };
    vi.mocked(f.ports.loadCompletionProofInTransaction)
      .mockResolvedValueOnce(first)
      .mockResolvedValue(changed);
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
    expect(f.tables.withdrawal_intent[0].reservedCents).toBe(10000);
  });
  it("rejects a contradictory late provider reference after completion without regressing the terminal tuple", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    await f.repository.postCompleted(
      armed.original,
      armed.fence,
      "bank-receipt-1",
    );
    const before = structuredClone(f.tables);
    await expect(
      f.repository.recordObservation(armed.original, armed.fence, {
        outcome: "ACCEPTED",
        correlation: armed.original.correlation,
        holderBinding: armed.original.holderBinding,
        fence: armed.fence,
        providerReference: "foreign-transfer",
        observedAt: f.time.toISOString(),
        proofReference: null,
      }),
    ).rejects.toThrow();
    expect(f.tables).toEqual(before);
  });
  it.each([1, 2])(
    "rolls back observation write/CAS boundary %s without releasing money",
    async (boundary) => {
      const f = fixture();
      const armed = await f.arm();
      const before = structuredClone(f.tables);
      f.faults.writes = 0;
      f.faults.failWrite = boundary;
      await expect(
        f.repository.recordObservation(armed.original, armed.fence, {
          outcome: "UNRESOLVED",
          correlation: armed.original.correlation,
          holderBinding: armed.original.holderBinding,
          fence: armed.fence,
        }),
      ).rejects.toThrow();
      expect(f.tables).toEqual(before);
    },
  );
  it("rolls back both arm writes when precise SQL authority expires between them", async () => {
    const f = fixture();
    const before = structuredClone(f.tables);
    f.faults.onQuery = (text) => {
      if (text.startsWith('UPDATE "withdrawal_intent"'))
        f.sqlClock.value = "2026-10-14T04:01:00.000001Z";
    };
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(f.tables).toEqual(before);
  });
  it.each(["effect", "receipt", "provider"])(
    "rejects a preexisting conflicting %s before any terminal write",
    async (kind) => {
      const f = fixture();
      const armed = await f.arm();
      f.makeProof(armed);
      if (kind === "effect")
        f.tables.financial_ledger_entry.push({
          siteId: "site-1",
          accountId: "account-1",
          environment: "sandbox",
          withdrawalIntentId: "withdrawal-1",
          operationId: "other-operation",
          effectKey: "foreign",
          amountCents: 9500,
        });
      if (kind === "receipt")
        f.tables.withdrawal_intent.push({
          ...structuredClone(f.tables.withdrawal_intent[0]),
          id: "other-withdrawal",
          requestId: "other-request",
          receiptReference: "bank-receipt-1",
        });
      if (kind === "provider")
        f.tables.financial_operation.push({
          ...structuredClone(f.tables.financial_operation[0]),
          id: "other-operation",
          requestId: "other-request",
          withdrawalIntentId: "other-withdrawal",
          providerOperationReference: "transfer-1",
        });
      const before = structuredClone(f.tables);
      expect(
        (
          await f.repository.postCompleted(
            armed.original,
            armed.fence,
            "bank-receipt-1",
          )
        ).outcome,
      ).toBe("DENIED");
      expect(f.tables).toEqual(before);
    },
  );
  it("keeps captured production configuration while rejecting a simulated receipt", async () => {
    const f = fixture();
    const armed = await f.arm();
    const p = f.makeProof(armed);
    p.provenance = "simulation";
    const options = {
      ...f.options,
      applicationEnvironment: "production",
    } as WithdrawalPostingRepositoryOptions;
    const repository = createWithdrawalPostingRepository(f.db, options);
    (options as any).applicationEnvironment = "test";
    expect(
      (
        await repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
  });
  it("does not dispatch when the real repository lost its arm commit acknowledgement", async () => {
    const f = fixture();
    f.faults.commitLost = true;
    const dispatch = vi.fn();
    const service = createWithdrawalExecutionService({
      mode: "sandbox",
      applicationEnvironment: "test",
      maxAuthAgeMs: 300000,
      now: () => new Date(f.time),
      repository: f.repository,
      dispatch: { dispatch },
      lookup: { lookup: async () => ({ outcome: "NOT_FOUND" }) },
    });
    expect((await service.executeExisting(f.attempt)).outcome).toBe(
      "UNRESOLVED",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.tables.withdrawal_intent[0].reservedCents).toBe(10000);
  });
  it("rolls back an arm if the committed association changes across the authority await", async () => {
    const f = fixture();
    const before = structuredClone(f.tables);
    vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mockImplementation(
      async () => {
        f.tables.withdrawal_request[0].previewHash = "b".repeat(64);
        return structuredClone(f.authority);
      },
    );
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(f.tables).toEqual(before);
  });
  it("rolls back changed intent money across the authority await before granting an arm", async () => {
    const f = fixture();
    const before = structuredClone(f.tables);
    vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mockImplementation(
      async () => {
        f.tables.withdrawal_intent[0].feeCents = 501;
        f.tables.withdrawal_intent[0].netCents = 9499;
        return structuredClone(f.authority);
      },
    );
    expect((await f.repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(f.tables).toEqual(before);
  });
  it("rolls back a changed actual terminal receipt instead of acknowledging a different bank proof", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    const before = structuredClone(f.tables);
    vi.mocked(
      f.ports.loadOriginalHolderConsentInTransaction,
    ).mockImplementation(async () => {
      if (f.tables.withdrawal_intent[0].state === "COMPLETED")
        f.tables.withdrawal_intent[0].receiptReference = "different-receipt";
      return structuredClone(f.holderBinding);
    });
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.tables).toEqual(before);
  });
});

describe("withdrawal repository corrective boundaries", () => {
  it.each([
    ["live", "test"],
    ["live", "development"],
    ["sandbox", "production"],
    ["unexpected", "test"],
    [undefined, "test"],
    ["sandbox", undefined],
    ["sandbox", "unexpected"],
  ])(
    "does not enable repository ports for runtime mode %s in %s",
    async (mode, applicationEnvironment) => {
      const f = fixture();
      const repository = createWithdrawalPostingRepository(f.db, {
        ...f.options,
        mode,
        applicationEnvironment,
      } as any);
      expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
      expect(
        await repository.readExisting({
          siteId: "site-1",
          requestId: "request-1",
        }),
      ).toBeNull();
      expect(f.db.transaction).not.toHaveBeenCalled();
      expect(f.queries).toHaveLength(0);
      expect(
        f.ports.loadOriginalHolderConsentInTransaction,
      ).not.toHaveBeenCalled();
      expect(f.ports.loadDispatchAuthorityInTransaction).not.toHaveBeenCalled();
    },
  );
  it.each(["accountReference", "recipientReference"])(
    "retains first-dispatch current %s admission",
    async (field) => {
      const f = fixture();
      f.tables.receiving_account[0][field] = "current-replacement";
      expect((await f.repository.armExisting(f.attempt)).outcome).toBe(
        "DENIED",
      );
      expect(f.tables.withdrawal_intent[0].reservedCents).toBe(10000);
      expect(f.tables.financial_operation[0].attempts).toBe(0);
    },
  );
  it("records, settles and replays the exact original account after mutable current references and holder change", async () => {
    const f = fixture();
    const armed = await f.arm();
    f.makeProof(armed);
    Object.assign(f.tables.receiving_account[0], {
      accountReference: "replacement-account-ref",
      recipientReference: "replacement-recipient-ref",
      operatorUserId: "replacement-holder",
      isCurrent: false,
    });
    f.tables.user = [];
    f.tables.session = [];
    f.tables.site_membership = [];
    vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mockResolvedValue(
      null,
    );
    const observation = await f.repository.recordObservation(
      armed.original,
      armed.fence,
      {
        outcome: "ACCEPTED",
        correlation: armed.original.correlation,
        holderBinding: armed.original.holderBinding,
        fence: armed.fence,
        providerReference: "transfer-1",
        observedAt: f.time.toISOString(),
        proofReference: "bank-receipt-1",
      },
    );
    expect(observation.original).toEqual(armed.original);
    expect(observation.reservedCents).toBe(10000);
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("COMPLETED");
    expect(
      (
        await f.repository.postCompleted(
          armed.original,
          armed.fence,
          "bank-receipt-1",
        )
      ).outcome,
    ).toBe("DUPLICATE");
    expect(f.tables.financial_ledger_entry).toHaveLength(1);
    expect(f.tables.financial_ledger_entry[0].accountId).toBe("account-1");
    expect(f.tables.withdrawal_intent[0]).toMatchObject({
      providerReference: "transfer-1",
      receiptReference: "bank-receipt-1",
      reservationState: "CONSUMED",
    });
    expect(
      vi.mocked(f.ports.loadDispatchAuthorityInTransaction).mock.calls.length,
    ).toBe(1);
  });
  it.each(["query", "transaction", "holder", "authority", "proof"])(
    "retains native pending %s ownership across unsafe constructor metadata",
    async (boundary) => {
      const f = fixture();
      let resolve!: (value: any) => void;
      let reads = 0;
      let entered = 0;
      const native = new Promise<any>((done) => {
        resolve = done;
      });
      Object.defineProperty(native, "constructor", {
        get() {
          reads++;
          throw new Error("Unsafe constructor metadata");
        },
      });
      let armed: Awaited<ReturnType<typeof f.arm>> | undefined;
      const hold = () => {
        entered++;
        return native;
      };
      if (boundary === "proof") {
        armed = await f.arm();
        f.makeProof(armed);
        f.ports.loadCompletionProofInTransaction = hold;
      }
      if (boundary === "holder")
        f.ports.loadOriginalHolderConsentInTransaction = hold;
      if (boundary === "authority")
        f.ports.loadDispatchAuthorityInTransaction = hold;
      const database =
        boundary === "transaction"
          ? ({ ...f.db, transaction: hold } as any)
          : boundary === "query"
            ? ({
                ...f.db,
                transaction: async (callback: (tx: any) => Promise<any>) =>
                  callback({ execute: hold }),
              } as any)
            : f.db;
      const repository = createWithdrawalPostingRepository(database, f.options);
      let settled = false;
      const pending = (
        boundary === "proof"
          ? repository.postCompleted(
              armed!.original,
              armed!.fence,
              "bank-receipt-1",
            )
          : repository.armExisting(f.attempt)
      ).then(() => {
        settled = true;
      });
      for (let index = 0; index < 300; index++) await Promise.resolve();
      expect(entered).toBe(1);
      expect(settled).toBe(false);
      expect(reads).toBe(0);
      expect(f.tables.financial_ledger_entry).toHaveLength(0);
      resolve({ rows: [] });
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(settled).toBe(false);
      void pending;
    },
  );
});

describe("withdrawal repository configuration capture amendment", () => {
  it("rejects the genuine production-to-test getter bypass before enabling repository ports", async () => {
    const f = fixture();
    let reads = 0;
    const options = { ...f.options, mode: "live" } as any;
    Object.defineProperty(options, "applicationEnvironment", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? "production" : "test";
      },
    });
    const repository = createWithdrawalPostingRepository(f.db, options);
    expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(reads).toBe(0);
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(0);
  });
  it("rejects stateful mode switching instead of constructing sandbox/production configuration", async () => {
    const f = fixture();
    let reads = 0;
    const options = {
      ...f.options,
      applicationEnvironment: "production",
    } as any;
    Object.defineProperty(options, "mode", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? "live" : "sandbox";
      },
    });
    const repository = createWithdrawalPostingRepository(f.db, options);
    expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(reads).toBe(0);
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.ports.loadDispatchAuthorityInTransaction).not.toHaveBeenCalled();
  });
  it.each([
    "mode",
    "applicationEnvironment",
    "maxAuthAgeMs",
    "freshnessMs",
    "leaseOwner",
    "leaseDurationMs",
    "ports",
    "now",
    "generateLeaseToken",
  ])(
    "rejects accessor configuration %s before activating repository capabilities",
    async (field) => {
      const f = fixture();
      const options = { ...f.options } as any;
      const original = options[field];
      let reads = 0;
      Object.defineProperty(options, field, {
        enumerable: true,
        get() {
          reads++;
          return original;
        },
      });
      const repository = createWithdrawalPostingRepository(f.db, options);
      expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
      expect(
        await repository.readExisting({
          siteId: "site-1",
          requestId: "request-1",
        }),
      ).toBeNull();
      expect(reads).toBe(0);
      expect(f.db.transaction).not.toHaveBeenCalled();
      expect(f.queries).toHaveLength(0);
      expect(
        f.ports.loadOriginalHolderConsentInTransaction,
      ).not.toHaveBeenCalled();
      expect(f.ports.loadDispatchAuthorityInTransaction).not.toHaveBeenCalled();
    },
  );
  it.each(["maxAuthAgeMs", "freshnessMs", "leaseOwner", "leaseDurationMs"])(
    "rejects missing ordinary scalar %s before activating ports",
    async (field) => {
      const f = fixture();
      const options = { ...f.options } as any;
      delete options[field];
      const repository = createWithdrawalPostingRepository(f.db, options);
      expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
      expect(f.db.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["development", "test"])(
    "preserves ordinary sandbox repository data in %s despite later option mutation",
    async (applicationEnvironment) => {
      const f = fixture();
      const options = { ...f.options, applicationEnvironment } as any;
      const repository = createWithdrawalPostingRepository(f.db, options);
      options.mode = "live";
      options.applicationEnvironment = "production";
      options.maxAuthAgeMs = 0;
      options.freshnessMs = 0;
      options.leaseOwner = "replacement";
      options.leaseDurationMs = 0;
      const result = await repository.armExisting(f.attempt);
      expect(result.outcome).toBe("ARMED");
      if (result.outcome === "ARMED")
        expect(result.fence).toMatchObject({
          leaseOwner: "worker-1",
          leaseToken: "token-1",
          leaseExpiresAt: "2026-10-14T04:01:00.000Z",
        });
    },
  );
  it("admits ordinary live/production data without approving a foreign sandbox reservation", async () => {
    const f = fixture();
    const repository = createWithdrawalPostingRepository(f.db, {
      ...f.options,
      mode: "live",
      applicationEnvironment: "production",
    });
    expect((await repository.armExisting(f.attempt)).outcome).toBe("DENIED");
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.tables.financial_operation[0].attempts).toBe(0);
  });
});

describe("maximum approved withdrawal budget settlement", () => {
  it("posts only actual debit and consumes the held budget without rewriting consent", async () => {
    const f = fixture(true);
    const armed = await f.arm();
    const original = structuredClone(armed.original);
    const proof = f.makeProof(armed);
    proof.totalDebitCents = 9500;
    proof.feeCents = 0;
    const completed = await f.repository.postCompleted(
      armed.original,
      armed.fence,
      proof.proofReference,
    );
    expect(completed.outcome).toBe("COMPLETED");
    expect(f.tables.financial_ledger_entry[0].amountCents).toBe(9500);
    expect(completed).toMatchObject({
      stored: { reservedCents: 0, reservationState: "CONSUMED" },
    });
    expect(armed.original).toEqual(original);
  });
});

it("never gives dispatch a lease beyond the accepted recent-auth validity", async () => {
  const f = fixture();
  f.attempt.recentAuth.expiresAt = new Date(+f.time + 1000);
  const armed = await f.arm();
  expect(Date.parse(armed.fence.leaseExpiresAt)).toBe(+f.time + 1000);
});
