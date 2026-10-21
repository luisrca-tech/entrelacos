import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsaasTransferObservation } from "./asaasHttpClient";
import { createAsaasWithdrawalCustody } from "./asaasWithdrawalCustody";
import { withdrawalCorrelation } from "./withdrawalExecution";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
  readWithdrawalReservationSnapshot,
} from "./withdrawalReservations";

const epoch = Date.parse("2026-10-20T02:00:00.000Z");
const canonical = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
};
function fixture(lagMs = 335) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const initialPerformance = performance.now();
  const elapsed = () => performance.now() - initialPerformance;
  const iso = (offset = 0) => new Date(epoch + offset).toISOString();
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    environment: "sandbox" as const,
    bankReference: "bank-1",
    destinationVersion: 1,
    amountCents: 300,
    currency: "BRL" as const,
  };
  const feeQuote = {
    feeCents: 200,
    feeSemantics: "MAXIMUM" as const,
    policyVersion: "fee-v1",
    provenance: "provider" as const,
    observedAt: iso(-60_000),
    expiresAt: iso(60_000),
  };
  const intent = {
    id: "withdrawal-1",
    siteId: scope.siteId,
    amountCents: 300,
    feeCents: 200,
    feeSemantics: "MAXIMUM" as const,
    netCents: 100,
    currency: "BRL" as const,
    destinationVersion: 1,
    state: "REQUESTED" as const,
    mode: "sandbox" as const,
    createdAt: iso(-30_000),
    updatedAt: iso(-30_000),
  };
  const requestId = "request-1",
    operatorUserId = "operator-1";
  const snapshot = readWithdrawalReservationSnapshot({
    intent,
    requestId,
    accountId: scope.accountId,
    operatorUserId,
    accountReference: scope.accountReference,
    recipientReference: "recipient-1",
    bankReference: scope.bankReference,
    environment: scope.environment,
    operationId: "operation-1",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          scope.siteId,
          requestId,
          operatorUserId,
          "sandbox",
          300,
          1,
        ]),
      )
      .digest("hex"),
    authenticationAuditHash: "a".repeat(64),
    feeQuote,
    balance: { balanceCents: 1782, observedAt: iso(-60_000) },
  });
  const payout = {
    destinationId: "pix-1",
    destinationVersion: 1,
    configurationHash: "b".repeat(64),
    reviewId: "review-1",
    holderId: "holder-1",
    holderConsentId: "holder-consent-1",
    acceptThirdParty: false,
    keyType: "EMAIL" as const,
    maskedKey: "o***@example.test",
    ownerName: "Original Operator",
  };
  const presentation = {
    ...scope,
    payout,
    source: "stored",
    verification: "verified",
    provenance: "provider",
    operatorUserId,
    recipientReference: "recipient-1",
    destinationId: "destination-1",
    evidenceId: "evidence-1",
    verificationReference: "verification-1",
    evidenceObservedAt: iso(-60_000),
    bankObservedAt: iso(-60_000),
    operatorProfileUpdatedAt: iso(-60_000),
    maskedDestination: "Pix EMAIL: o***@example.test",
    operatorDisplayName: "Original Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: scope.siteId,
      requestId,
      mode: "sandbox",
      amountCents: 300,
      feeCents: 200,
      feeSemantics: "MAXIMUM",
      netCents: 100,
      currency: "BRL",
      destinationVersion: 1,
      maskedDestination: presentation.maskedDestination,
      operatorDisplayName: presentation.operatorDisplayName,
      payoutRecipientName: payout.ownerName,
      policyVersion: feeQuote.policyVersion,
      issuedAt: iso(-60_000),
      expiresAt: feeQuote.expiresAt,
    },
    scope,
    operatorUserId,
    recipientReference: "recipient-1",
    presentation,
    feeQuote,
  });
  const consent = {
    snapshot: consentSnapshot,
    previewHash: hashWithdrawalConsentSnapshot(consentSnapshot),
    state: "COMMITTED" as const,
    requestRevision: "2" as const,
  };
  const correlation = withdrawalCorrelation(snapshot);
  const original = {
    snapshot,
    consent,
    correlation,
    associationId: "association-1",
    holderBinding: {
      correlation,
      consentHash: consent.previewHash,
      bindingReference: "binding-1",
      holderUserId: operatorUserId,
      holderConsentReference: payout.holderConsentId,
      actingUserId: operatorUserId,
      holderRole: "BRIDE_HOLDER" as const,
      provenance: "durable" as const,
      verification: "verified" as const,
    },
  };
  const fence = {
    operationId: correlation.operationId,
    attempts: 1 as const,
    leaseOwner: "worker-1",
    leaseToken: "token-1",
    leaseExpiresAt: iso(-1),
  };
  const observation: AsaasTransferObservation = {
    source: "provider",
    provider: "ASAAS",
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    accountReference: scope.accountReference,
    environment: "sandbox",
    observedAt: new Date(epoch),
    transfer: {
      id: "transfer-1",
      externalReference: correlation.operationId,
      type: "PIX",
      operationType: "PIX",
      status: "DONE",
      value: "1.00",
      netValue: "1.00",
      transferFee: "0.00",
      transactionReceiptUrl: "https://example.test/receipt",
      endToEndIdentifier: "E123",
      effectiveDate: "2026-10-20",
    },
  };
  const faults = {
    samples: [] as unknown[],
    latencyMs: 0,
    nodeOffsetMs: 0,
    insertClockOffsetMs: 0,
    readLatencyMs: 0,
    nodeRate: 1,
    nodeInvalidAfterMs: Number.POSITIVE_INFINITY,
  };
  let retained: Record<string, unknown> | null = null;
  const inserts: { sql: string; params: unknown[] }[] = [];
  const operation = {
    requestHash: snapshot.requestHash,
    requestSnapshot: JSON.parse(JSON.stringify(snapshot)),
    state: "UNKNOWN",
    attempts: 1,
    leaseOwner: fence.leaseOwner,
    leaseToken: fence.leaseToken,
    leaseExpiresAt: fence.leaseExpiresAt,
    providerReference: null,
  };
  const sqlNow = () => new Date(epoch - lagMs + elapsed());
  let transactionStartedAt = sqlNow();
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes('FROM "financial_operation"'))
      return { rows: [operation] };
    if (query.sql.startsWith("SELECT clock_timestamp()")) {
      if (faults.latencyMs) vi.advanceTimersByTime(faults.latencyMs);
      return {
        rows: [
          {
            currentTime: faults.samples.length
              ? faults.samples.shift()
              : sqlNow().toISOString(),
          },
        ],
      };
    }
    if (query.sql.startsWith('INSERT INTO "withdrawal_provider_observation"')) {
      inserts.push(query);
      const recordedAt = query.sql.includes("clock_timestamp()")
        ? new Date(sqlNow().getTime() + faults.insertClockOffsetMs)
        : transactionStartedAt;
      const observedAt = new Date(String(query.params[8]));
      if (recordedAt.getTime() < observedAt.getTime())
        throw Object.assign(new Error("SQL time check"), {
          code: "23514",
          constraint: "withdrawal_observation_time_check",
        });
      retained ??= {
        id: query.params[0],
        siteId: query.params[1],
        accountId: query.params[2],
        environment: query.params[3],
        operationId: query.params[4],
        providerReference: query.params[5],
        payloadHash: query.params[6],
        payload: JSON.parse(String(query.params[7])),
        observedAt: query.params[8],
        recordedAt: recordedAt.toISOString(),
      };
      return { rows: [] };
    }
    if (query.sql.includes('FROM "withdrawal_provider_observation"')) {
      if (faults.readLatencyMs) vi.advanceTimersByTime(faults.readLatencyMs);
      return {
        rows: retained
          ? [{ ...structuredClone(retained), readAt: sqlNow().toISOString() }]
          : [],
      };
    }
    throw new Error("Unexpected SQL in custody test");
  });
  const tx = { execute };
  const db = {
    transaction: vi.fn(
      async (work: (transaction: typeof tx) => Promise<unknown>) => {
        transactionStartedAt = sqlNow();
        const before = structuredClone(retained);
        try {
          return await work(tx);
        } catch (error) {
          retained = before;
          throw error;
        }
      },
    ),
  };
  const custody = createAsaasWithdrawalCustody(db as never, {
    mode: "sandbox",
    applicationEnvironment: "test",
    now: () =>
      new Date(
        elapsed() >= faults.nodeInvalidAfterMs
          ? Number.NaN
          : epoch + elapsed() * faults.nodeRate + faults.nodeOffsetMs,
      ),
  });
  return {
    original,
    fence,
    observation,
    custody,
    tx,
    db,
    faults,
    inserts,
    execute,
    elapsed,
    sqlNow,
    retained: () => retained,
    transactionStartedAt: () => transactionStartedAt,
  };
}
afterEach(() => vi.useRealTimers());

async function settle<T>(
  promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

describe("bounded SQL clock coordination for retained provider observations", () => {
  it("waits for SQL lag of335ms then inserts once at current SQL time without changing evidence or replaying dispatch", async () => {
    const f = fixture();
    const frozen = structuredClone({
      original: f.original,
      fence: f.fence,
      observation: f.observation,
    });
    const expectedBody = JSON.parse(canonical({ version: 1, ...frozen }));
    const expectedHash = createHash("sha256")
      .update(canonical(expectedBody))
      .digest("hex");
    const result = await settle(
      f.custody.record(f.original, f.fence, f.observation),
    );
    expect(result).toEqual({ value: `asaas-transfer:${expectedHash}` });
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0].sql).toContain("clock_timestamp()");
    expect(f.transactionStartedAt().getTime()).toBeLessThan(epoch);
    expect(f.retained()).toMatchObject({
      payloadHash: expectedHash,
      payload: expectedBody,
    });
    expect(f.elapsed()).toBeGreaterThanOrEqual(335);
    expect(f.elapsed()).toBeLessThanOrEqual(1250);
    expect({
      original: f.original,
      fence: f.fence,
      observation: f.observation,
    }).toEqual(frozen);
    expect(f.db.transaction).toHaveBeenCalledOnce();
    const proof = await f.custody.loadCompletionProofInTransaction(
      f.tx as never,
      f.original,
      f.fence,
      `asaas-transfer:${expectedHash}`,
    );
    expect(proof).toMatchObject({
      outcome: "COMPLETED",
      providerReference: "transfer-1",
      netCents: 100,
      feeCents: 0,
    });
  });
  it.each([
    "excessLag",
    "regression",
    "invalid",
    "noProgress",
    "sampleLimit",
    "elapsedBudget",
  ])("fails closed before INSERT for %s", async (kind) => {
    const f = fixture(kind === "excessLag" ? 1001 : 335);
    if (kind === "regression")
      f.faults.samples = [
        new Date(epoch - 335).toISOString(),
        new Date(epoch - 336).toISOString(),
      ];
    if (kind === "invalid") f.faults.samples = ["invalid-sql-time"];
    if (kind === "noProgress")
      f.faults.samples = [
        new Date(epoch - 335).toISOString(),
        new Date(epoch - 335).toISOString(),
      ];
    if (kind === "sampleLimit")
      f.faults.samples = [-200, -100, -50].map((offset) =>
        new Date(epoch + offset).toISOString(),
      );
    if (kind === "elapsedBudget") f.faults.latencyMs = 1251;
    expect(
      await settle(f.custody.record(f.original, f.fence, f.observation)),
    ).toHaveProperty("error");
    expect(f.inserts).toHaveLength(0);
    expect(f.retained()).toBeNull();
    expect(
      f.execute.mock.calls.filter(([statement]) =>
        new PgDialect()
          .sqlToQuery(statement)
          .sql.startsWith("SELECT clock_timestamp()"),
      ).length,
    ).toBeLessThanOrEqual(3);
  });
  it("rejects an observation in the Node future before entering any transaction", async () => {
    const f = fixture();
    f.observation.observedAt = new Date(epoch + 1);
    await expect(
      f.custody.record(f.original, f.fence, f.observation),
    ).rejects.toThrow();
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.inserts).toHaveLength(0);
  });
  it("rechecks the Node observation boundary after waiting", async () => {
    const f = fixture();
    const work = f.custody.record(f.original, f.fence, f.observation);
    const result = work.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    f.faults.nodeOffsetMs = -1000;
    await vi.runAllTimersAsync();
    expect(await result).toHaveProperty("error");
    expect(f.inserts).toHaveLength(0);
  });
  it("uses precise SQL read time while retaining original Node and observation bounds", async () => {
    const f = fixture(0);
    const recorded = await settle(
      f.custody.record(f.original, f.fence, f.observation),
    );
    expect(recorded).toHaveProperty("value");
    if (!("value" in recorded)) return;
    const retained = f.retained();
    expect(retained).not.toBeNull();
    if (!retained) return;
    retained.recordedAt = "2026-10-20T02:00:00.000001Z";
    f.faults.nodeOffsetMs = 1000;
    expect(
      await f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        recorded.value,
      ),
    ).toBeNull();
    retained.recordedAt = "2026-10-20T01:59:59.999999Z";
    expect(
      await f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        recorded.value,
      ),
    ).toBeNull();
    retained.recordedAt = "2026-10-20T02:00:00.000000Z";
    f.faults.nodeOffsetMs = -1;
    expect(
      await f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        recorded.value,
      ),
    ).toBeNull();
  });
});

it("leaves the SQL constraint authoritative if its clock regresses after the final ready sample", async () => {
  const f = fixture(0);
  f.faults.insertClockOffsetMs = -1;
  expect(
    await settle(f.custody.record(f.original, f.fence, f.observation)),
  ).toHaveProperty("error");
  expect(f.inserts).toHaveLength(1);
  expect(f.retained()).toBeNull();
});

it("retains the same durable evidence and reference on a duplicate observation", async () => {
  const f = fixture();
  const first = await settle(
    f.custody.record(f.original, f.fence, f.observation),
  );
  expect(first).toHaveProperty("value");
  const retained = structuredClone(f.retained());
  expect(
    await settle(f.custody.record(f.original, f.fence, f.observation)),
  ).toEqual(first);
  expect(f.retained()).toEqual(retained);
  expect(f.inserts).toHaveLength(2);
});

it("waits for Node to reach a fixed SQL record 400ms ahead without changing evidence or replaying dispatch", async () => {
  const f = fixture(-400);
  const frozen = structuredClone({
    original: f.original,
    fence: f.fence,
    observation: f.observation,
  });
  const expectedBody = JSON.parse(canonical({ version: 1, ...frozen }));
  const expectedHash = createHash("sha256")
    .update(canonical(expectedBody))
    .digest("hex");
  const result = await settle(
    f.custody.record(f.original, f.fence, f.observation),
  );
  expect(result).toEqual({ value: `asaas-transfer:${expectedHash}` });
  expect(f.inserts).toHaveLength(1);
  expect(f.retained()).toMatchObject({
    payload: expectedBody,
    payloadHash: expectedHash,
    recordedAt: new Date(epoch + 400).toISOString(),
  });
  expect(f.elapsed()).toBeGreaterThanOrEqual(400);
  expect(f.elapsed()).toBeLessThanOrEqual(1250);
  expect({
    original: f.original,
    fence: f.fence,
    observation: f.observation,
  }).toEqual(frozen);
  expect(f.db.transaction).toHaveBeenCalledOnce();
  expect(
    f.execute.mock.calls.filter(([statement]) =>
      new PgDialect()
        .sqlToQuery(statement)
        .sql.startsWith("SELECT clock_timestamp()"),
    ),
  ).toHaveLength(1);
});

it("loads a SQL-valid recent proof after Node catches up to its fixed recordedAt", async () => {
  const f = fixture(-400);
  f.faults.nodeOffsetMs = 400;
  const recorded = await settle(
    f.custody.record(f.original, f.fence, f.observation),
  );
  expect(recorded).toHaveProperty("value");
  if (!("value" in recorded)) return;
  f.faults.nodeOffsetMs = 0;
  const retained = structuredClone(f.retained());
  const proof = await settle(
    f.custody.loadCompletionProofInTransaction(
      f.tx as never,
      f.original,
      f.fence,
      recorded.value,
    ),
  );
  expect(proof).toMatchObject({
    value: {
      outcome: "COMPLETED",
      recordedAt: new Date(epoch + 400).toISOString(),
    },
  });
  expect(f.retained()).toEqual(retained);
  expect(f.inserts).toHaveLength(1);
});

it.each([
  "excessAhead",
  "noProgress",
  "regression",
  "invalidNode",
  "readBudget",
  "sharedBudget",
])("fails closed after INSERT for %s", async (kind) => {
  const f = fixture(kind === "excessAhead" ? -1001 : -400);
  if (kind === "noProgress") f.faults.nodeRate = 0;
  if (kind === "regression") f.faults.nodeRate = -1;
  if (kind === "invalidNode") f.faults.nodeInvalidAfterMs = 400;
  if (kind === "readBudget") f.faults.readLatencyMs = 1251;
  if (kind === "sharedBudget") {
    f.faults.samples = [
      new Date(epoch - 335).toISOString(),
      new Date(epoch + 10).toISOString(),
    ];
    f.faults.latencyMs = 300;
    f.faults.readLatencyMs = 100;
  }
  expect(
    await settle(f.custody.record(f.original, f.fence, f.observation)),
  ).toHaveProperty("error");
  expect(f.inserts).toHaveLength(1);
  expect(f.retained()).toBeNull();
  if (["noProgress", "regression", "invalidNode"].includes(kind))
    expect(f.elapsed()).toBeGreaterThanOrEqual(400);
  expect(f.elapsed()).toBeLessThanOrEqual(kind === "readBudget" ? 1251 : 1250);
});

it("rejects a SQL record one microsecond beyond SQL read time before waiting for Node", async () => {
  const f = fixture(-400);
  f.faults.nodeOffsetMs = 400;
  const recorded = await settle(
    f.custody.record(f.original, f.fence, f.observation),
  );
  expect(recorded).toHaveProperty("value");
  if (!("value" in recorded)) return;
  const retained = f.retained();
  if (!retained) throw new Error("Expected retained custody");
  retained.recordedAt = "2026-10-20T02:00:00.400001Z";
  f.faults.nodeOffsetMs = 0;
  const started = f.elapsed();
  expect(
    await settle(
      f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        recorded.value,
      ),
    ),
  ).toEqual({ value: null });
  expect(f.elapsed()).toBe(started);
});

it.each(["invalid", "regressed", "expired"])(
  "rejects a %s performance clock during the Node catch-up wait",
  async (kind) => {
    const f = fixture(-400);
    const monotonicNow = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => monotonicNow() + offset);
    try {
      const result = f.custody.record(f.original, f.fence, f.observation).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(f.inserts).toHaveLength(1);
      offset =
        kind === "invalid" ? Number.NaN : kind === "regressed" ? -500 : 1251;
      await vi.runAllTimersAsync();
      expect(await result).toHaveProperty("error");
      expect(f.retained()).toBeNull();
    } finally {
      clock.mockRestore();
    }
  },
);

it("rejects an invalid observation before entering a transaction", async () => {
  const f = fixture(-400);
  f.observation.observedAt = new Date(Number.NaN);
  await expect(
    f.custody.record(f.original, f.fence, f.observation),
  ).rejects.toThrow();
  expect(f.db.transaction).not.toHaveBeenCalled();
});

it("retains the original SQL-ahead evidence and reference on duplicate acceptance", async () => {
  const f = fixture(-400);
  const first = await settle(
    f.custody.record(f.original, f.fence, f.observation),
  );
  expect(first).toHaveProperty("value");
  const retained = structuredClone(f.retained());
  const elapsed = f.elapsed();
  expect(
    await settle(f.custody.record(f.original, f.fence, f.observation)),
  ).toEqual(first);
  expect(f.retained()).toEqual(retained);
  expect(f.elapsed()).toBe(elapsed);
  expect(f.inserts).toHaveLength(2);
});
