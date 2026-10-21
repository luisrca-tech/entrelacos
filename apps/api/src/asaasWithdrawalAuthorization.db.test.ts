import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AsaasTransferObservation } from "./asaasHttpClient";
import { createAsaasWithdrawalAuthorization } from "./asaasWithdrawalAuthorization";
import { withdrawalCorrelation } from "./withdrawalExecution";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
  readWithdrawalReservationSnapshot,
} from "./withdrawalReservations";

const epoch = Date.parse("2026-10-20T02:00:00.000Z");
const token = "offline-authorization-token-123456789";
const bankAccount = () => ({
  bank: { ispb: "12345678" },
  ownerName: "Original Operator",
  cpfCnpj: "12345678901",
  agency: "0001",
  account: "12345",
  accountDigit: "6",
  pixAddressKey: "original@example.test",
});
function originalFixture() {
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
    leaseExpiresAt: iso(60_000),
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
      status: "PENDING",
      value: "1.00",
      netValue: "1.00",
      transferFee: "0.00",
      transactionReceiptUrl: "https://example.test/receipt",
      endToEndIdentifier: "E123",
      effectiveDate: "2026-10-20",
    },
  };
  observation.transfer.bankAccount = bankAccount();
  return { original, fence, observation };
}
async function acquireTestClient() {
  return connection.pool.connect();
}
type TestClient = Awaited<ReturnType<typeof acquireTestClient>>;
function testDatabase(client: TestClient) {
  return drizzle(client);
}
type TestTransaction = ReturnType<typeof testDatabase>;
let connection: DatabaseConnection;
const scratchSchema = `withdrawal_authorization_${randomUUID().replaceAll("-", "")}`;
function transaction<T>(work: (tx: TestTransaction) => Promise<T>): Promise<T> {
  return (async () => {
    const client = await acquireTestClient();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path = "${scratchSchema}", public`);
      const result = await work(testDatabase(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })();
}
async function query(text: string, values: unknown[] = []) {
  return transaction(async (tx) => tx.$client.query(text, values));
}
beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
  await connection.pool.query(`CREATE SCHEMA "${scratchSchema}"`);
  await query(`
    CREATE TABLE site (id text PRIMARY KEY);
    CREATE TABLE receiving_account (id text PRIMARY KEY, site_id text);
    CREATE TYPE financial_environment AS ENUM ('sandbox','live');
    CREATE TABLE financial_operation (id text PRIMARY KEY, site_id text NOT NULL, account_id text NOT NULL, environment financial_environment NOT NULL, kind text NOT NULL, withdrawal_intent_id text, request_id text, request_hash text, request_snapshot jsonb, state text, attempts integer, lease_owner text, lease_token text, lease_expires_at timestamptz, provider_operation_reference text, UNIQUE(site_id,account_id,environment,id));
    CREATE TABLE withdrawal_intent (id text PRIMARY KEY, site_id text, account_id text, environment financial_environment, request_id text, request_hash text, operator_user_id text, destination_version integer, amount_cents integer, fee_cents integer, net_cents integer, currency text, authorization_reference text, policy_version text, state text, reservation_state text, reserved_cents integer, provider_reference text);
    CREATE TABLE withdrawal_request (id text PRIMARY KEY, site_id text, account_id text, environment financial_environment, withdrawal_intent_id text, request_id text, operator_user_id text, destination_version integer, preview_snapshot jsonb, preview_hash text, state text, request_revision bigint, sealed_at timestamptz);
  `);
  const migration = readFileSync(
    new URL(
      "../../../packages/database/migrations/0021_withdrawal_authorization.sql",
      import.meta.url,
    ),
    "utf8",
  )
    .replaceAll(
      '"public"."financial_operation"',
      `"${scratchSchema}"."financial_operation"`,
    )
    .replaceAll(
      '"public"."withdrawal_authorization_candidate"',
      `"${scratchSchema}"."withdrawal_authorization_candidate"`,
    );
  await query(migration);
});
afterAll(async () => {
  if (connection) {
    await connection.pool.query(
      `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE`,
    );
    await connection.close();
  }
});
beforeEach(async () => {
  await query(
    "TRUNCATE withdrawal_authorization_decision,withdrawal_authorization_candidate,withdrawal_request,withdrawal_intent,financial_operation,receiving_account,site",
  );
});
async function databaseFixture() {
  const f = originalFixture();
  const c = f.original.correlation;
  const verifyConsent = vi.fn(
    async (
      tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
    ) => {
      await tx.execute(
        sql`SELECT id FROM site WHERE id=${c.siteId} FOR UPDATE`,
      );
      await tx.execute(
        sql`SELECT id FROM receiving_account WHERE id=${c.accountId} AND site_id=${c.siteId} FOR UPDATE`,
      );
    },
  );
  const service = createAsaasWithdrawalAuthorization({ transaction } as never, {
    mode: "sandbox",
    applicationEnvironment: "test",
    token,
    now: () => new Date(epoch),
    verifyConsentInTransaction: verifyConsent,
  });
  await query("INSERT INTO site VALUES ($1)", [c.siteId]);
  await query("INSERT INTO receiving_account VALUES ($1,$2)", [
    c.accountId,
    c.siteId,
  ]);
  await query(
    "INSERT INTO financial_operation VALUES ($1,$2,$3,'sandbox','WITHDRAWAL',$4,$5,$6,$7::jsonb,'PROCESSING',1,$8,$9,$10,null)",
    [
      c.operationId,
      c.siteId,
      c.accountId,
      c.withdrawalId,
      c.requestId,
      c.requestHash,
      JSON.stringify(f.original.snapshot),
      f.fence.leaseOwner,
      f.fence.leaseToken,
      f.fence.leaseExpiresAt,
    ],
  );
  await query(
    "INSERT INTO withdrawal_intent VALUES ($1,$2,$3,'sandbox',$4,$5,$6,$7,$8,$9,$10,'BRL',$11,$12,'PROCESSING','HELD',$8,null)",
    [
      c.withdrawalId,
      c.siteId,
      c.accountId,
      c.requestId,
      c.requestHash,
      c.operatorUserId,
      c.destinationVersion,
      c.amountCents,
      c.feeCents,
      c.netCents,
      f.original.snapshot.authenticationAuditHash,
      c.policyVersion,
    ],
  );
  await query(
    "INSERT INTO withdrawal_request VALUES ($1,$2,$3,'sandbox',$4,$5,$6,$7,$8::jsonb,$9,'COMMITTED',2,null)",
    [
      f.original.associationId,
      c.siteId,
      c.accountId,
      c.withdrawalId,
      c.requestId,
      c.operatorUserId,
      c.destinationVersion,
      JSON.stringify(f.original.consent.snapshot),
      f.original.consent.previewHash,
    ],
  );
  const body = () =>
    JSON.stringify({
      type: "TRANSFER",
      transfer: {
        object: "transfer",
        id: f.observation.transfer.id,
        status: "PENDING",
        type: "BANK_ACCOUNT",
        operationType: "PIX",
        value: 1,
        netValue: 1,
        transferFee: 0,
        bankAccount: bankAccount(),
      },
    });
  const record = (tx: TestTransaction) =>
    service.recordCandidateInTransaction(
      tx as never,
      f.original,
      f.fence,
      f.observation,
      {
        key: bankAccount().pixAddressKey,
        type: "EMAIL",
        reviewedMaskedCpfCnpj: "***.456.789-**",
      },
    );
  return { ...f, service, record, body, verifyConsent };
}

describe("PostgreSQL withdrawal security authorization", () => {
  it("commits one immutable authorization under simultaneous callbacks, with no debit or settlement", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.service.receive(token, f.body())),
    );
    expect(results).toEqual(Array(4).fill({ status: "APPROVED" }));
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await query(
          "SELECT state,reservation_state,reserved_cents FROM withdrawal_intent",
        )
      ).rows,
    ).toEqual([
      { state: "PROCESSING", reservation_state: "HELD", reserved_cents: 300 },
    ]);
    expect(f.verifyConsent).toHaveBeenCalledOnce();
    for (const table of [
      "withdrawal_authorization_candidate",
      "withdrawal_authorization_decision",
    ]) {
      await expect(
        query(`UPDATE ${table} SET payload_hash=repeat('a',64)`),
      ).rejects.toThrow("Withdrawal authorization custody is immutable");
      await expect(query(`DELETE FROM ${table}`)).rejects.toThrow(
        "Withdrawal authorization custody is immutable",
      );
    }
    await query(
      "UPDATE financial_operation SET state='SUCCEEDED'; UPDATE withdrawal_intent SET state='COMPLETED',reservation_state='CONSUMED',reserved_cents=0",
    );
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "APPROVED",
    });
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("refuses a callback while native creation evidence is uncommitted and after its transaction rolls back", async () => {
    const f = await databaseFixture();
    let ready!: () => void, release!: () => void;
    const staged = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creation = transaction(async (tx) => {
      await f.record(tx);
      ready();
      await unblock;
      throw new Error("synthetic lost creation commit");
    });
    const rejectedCreation = expect(creation).rejects.toThrow(
      "synthetic lost creation commit",
    );
    await staged;
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    release();
    await rejectedCreation;
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_candidate",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it("rolls back a failed decision commit instead of returning APPROVED", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    const service = createAsaasWithdrawalAuthorization(
      {
        transaction: (work: (tx: TestTransaction) => Promise<unknown>) =>
          transaction(async (tx) => {
            await work(tx);
            throw new Error("synthetic commit failure");
          }),
      } as never,
      {
        mode: "sandbox",
        applicationEnvironment: "test",
        token,
        now: () => new Date(epoch),
        verifyConsentInTransaction: f.verifyConsent,
      },
    );
    expect(await service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "APPROVED",
    });
  });
  it("times out lock contention safely without changing the held withdrawal", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    let ready!: () => void, release!: () => void;
    const staged = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = transaction(async (tx) => {
      await tx.$client.query("SELECT id FROM financial_operation FOR UPDATE");
      ready();
      await unblock;
    });
    await staged;
    const started = performance.now();
    try {
      expect(await f.service.receive(token, f.body())).toEqual({
        status: "REFUSED",
      });
    } finally {
      release();
      await blocker;
    }
    expect(performance.now() - started).toBeLessThan(5000);
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await query("SELECT state,reserved_cents FROM withdrawal_intent")).rows,
    ).toEqual([{ state: "PROCESSING", reserved_cents: 300 }]);
  });
  it("refuses a dispatch fence changed by one database microsecond", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    await query(
      "UPDATE financial_operation SET lease_expires_at=lease_expires_at + interval '1 microsecond'",
    );
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM withdrawal_authorization_decision",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it("shares the posting site/account lock order without deadlocking a concurrent callback", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    let ready!: () => void, release!: () => void, verifying!: () => void;
    const staged = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempting = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    const verify = f.verifyConsent.getMockImplementation();
    if (!verify) throw new Error("Missing consent verifier");
    f.verifyConsent.mockImplementation(async (tx) => {
      verifying();
      await verify(tx);
    });
    const posting = transaction(async (tx) => {
      await tx.$client.query("SELECT id FROM site FOR UPDATE");
      await tx.$client.query("SELECT id FROM receiving_account FOR UPDATE");
      await tx.$client.query("SELECT id FROM withdrawal_request FOR UPDATE");
      await tx.$client.query("SELECT id FROM withdrawal_intent FOR UPDATE");
      await tx.$client.query("SELECT id FROM financial_operation FOR UPDATE");
      ready();
      await unblock;
    });
    await staged;
    const callback = f.service.receive(token, f.body());
    await attempting;
    release();
    await posting;
    expect(await callback).toEqual({ status: "APPROVED" });
  });
  it("enforces scoped operation ownership, a single native ID, and a single original operation", async () => {
    const f = await databaseFixture();
    await transaction(f.record);
    await expect(
      query(
        "INSERT INTO withdrawal_authorization_candidate SELECT environment,'other-transfer',site_id,account_id,operation_id,payload_hash,payload,recorded_at FROM withdrawal_authorization_candidate",
      ),
    ).rejects.toThrow(/unique/);
    await expect(
      query(
        "INSERT INTO withdrawal_authorization_candidate SELECT environment,provider_reference,site_id,account_id,operation_id,payload_hash,payload,recorded_at FROM withdrawal_authorization_candidate",
      ),
    ).rejects.toThrow(/unique/);
    await expect(
      query(
        "INSERT INTO withdrawal_authorization_candidate VALUES ('sandbox','foreign-transfer','foreign-site','account-1','foreign-operation',repeat('a',64),'{}',now())",
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      query(
        "INSERT INTO withdrawal_authorization_decision VALUES ('sandbox','unknown-transfer',repeat('a',64),'APPROVED',now())",
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      query(
        "INSERT INTO withdrawal_authorization_candidate VALUES ('live','live-transfer','site-1','account-1','operation-live',repeat('a',64),'{}',now())",
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
