import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
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
function fixture(live = false, fee = 200) {
  const mode = live ? ("live" as const) : ("sandbox" as const);
  const semantics = live
    ? ("MAXIMUM_WITH_MINIMUM_NET" as const)
    : ("MAXIMUM" as const);
  const iso = (offset = 0) => new Date(epoch + offset).toISOString();
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    environment: mode,
    bankReference: "bank-1",
    destinationVersion: 1,
    amountCents: 300,
    currency: "BRL" as const,
  };
  const feeQuote = {
    feeCents: 200,
    feeSemantics: semantics,
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
    feeSemantics: semantics,
    netCents: 100,
    currency: "BRL" as const,
    destinationVersion: 1,
    state: "REQUESTED" as const,
    mode,
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
          mode,
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
      mode,
      amountCents: 300,
      feeCents: 200,
      feeSemantics: semantics,
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
    environment: mode,
    observedAt: new Date(epoch),
    transfer: {
      id: "transfer-1",
      externalReference: correlation.operationId,
      type: "PIX",
      operationType: "PIX",
      status: "PENDING",
      value: live ? "3.00" : "1.00",
      netValue: live ? ((300 - fee) / 100).toFixed(2) : "1.00",
      transferFee: live ? (fee / 100).toFixed(2) : "0.00",
      transactionReceiptUrl: "https://example.test/receipt",
      endToEndIdentifier: "E123",
      effectiveDate: "2026-10-20",
    },
  };
  observation.transfer.bankAccount = bankAccount();
  const operation: Record<string, unknown> = {
    requestHash: snapshot.requestHash,
    requestSnapshot: JSON.parse(JSON.stringify(snapshot)),
    state: "PROCESSING",
    attempts: 1,
    leaseOwner: fence.leaseOwner,
    leaseToken: fence.leaseToken,
    leaseExpiresAt: fence.leaseExpiresAt,
    providerReference: null,
    withdrawalProviderReference: null,
    withdrawalState: "PROCESSING",
    reservationState: "HELD",
    reservedCents: 300,
    consentId: original.associationId,
    consentSnapshot: JSON.parse(JSON.stringify(consent.snapshot)),
    consentHash: consent.previewHash,
    consentState: "COMMITTED",
    requestRevision: "2",
    sealedAt: null,
  };
  let candidate: Record<string, unknown> | null = null;
  let decision: Record<string, unknown> | null = null;
  const statements: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const q = new PgDialect().sqlToQuery(statement);
    statements.push(q.sql);
    if (q.sql.includes("INSERT INTO withdrawal_authorization_candidate")) {
      candidate ??= {
        environment: mode,
        providerReference: q.params[0],
        siteId: q.params[1],
        accountId: q.params[2],
        operationId: q.params[3],
        payloadHash: q.params[4],
        payload: JSON.parse(String(q.params[5])),
      };
      return { rows: [] };
    }
    if (q.sql.includes("INSERT INTO withdrawal_authorization_decision")) {
      decision ??= { payloadHash: q.params[1], status: "APPROVED" };
      return { rows: [] };
    }
    if (q.sql.includes("FROM withdrawal_authorization_candidate"))
      return { rows: candidate ? [candidate] : [] };
    if (q.sql.includes("FROM withdrawal_authorization_decision"))
      return { rows: decision ? [decision] : [] };
    if (q.sql.includes("FROM financial_operation"))
      return { rows: [operation] };
    return { rows: [] };
  });
  const tx = { execute };
  let previous = Promise.resolve();
  const db = {
    transaction: vi.fn(
      async (work: (transaction: typeof tx) => Promise<unknown>) => {
        const before = previous;
        let release!: () => void;
        previous = new Promise<void>((resolve) => {
          release = resolve;
        });
        await before;
        try {
          return await work(tx);
        } finally {
          release();
        }
      },
    ),
  };
  const verifyConsent = vi.fn(async () => {});
  const service = createAsaasWithdrawalAuthorization(db as never, {
    mode,
    applicationEnvironment: live ? "production" : "test",
    token,
    now: () => new Date(epoch),
    verifyConsentInTransaction: verifyConsent,
  });
  const body = () =>
    JSON.stringify({
      type: "TRANSFER",
      transfer: {
        object: "transfer",
        id: observation.transfer.id,
        status: "PENDING",
        type: "BANK_ACCOUNT",
        operationType: "PIX",
        value: live ? 3 : 1,
        netValue: live ? (300 - fee) / 100 : 1,
        transferFee: live ? fee / 100 : 0,
        bankAccount: bankAccount(),
      },
    });
  const record = () =>
    service.recordCandidateInTransaction(
      tx as never,
      original,
      fence,
      observation,
      {
        key: bankAccount().pixAddressKey,
        type: "EMAIL",
        reviewedMaskedCpfCnpj: "***.456.789-**",
      },
    );
  return {
    service,
    body,
    record,
    db,
    tx,
    execute,
    verifyConsent,
    original,
    fence,
    observation,
    operation,
    statements,
    candidate: () => candidate,
    decision: () => decision,
  };
}

describe("Asaas withdrawal security authorization", () => {
  it("denies an authenticated callback until a trusted native candidate is durably visible", async () => {
    const f = fixture();
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(f.verifyConsent).not.toHaveBeenCalled();
    expect(f.decision()).toBeNull();
  });
  it("approves only the frozen original transfer without completing or debiting it", async () => {
    const f = fixture();
    await f.record();
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "APPROVED",
    });
    expect(f.verifyConsent).toHaveBeenCalledOnce();
    expect(f.operation.state).toBe("PROCESSING");
    expect(f.operation.reservationState).toBe("HELD");
    expect(
      f.statements.some((s) =>
        /UPDATE|financial_ledger_entry/.test(s.replace(/FOR UPDATE/g, "")),
      ),
    ).toBe(false);
    expect(JSON.stringify(f.candidate())).not.toContain(
      bankAccount().pixAddressKey,
    );
    expect(JSON.stringify(f.candidate())).not.toContain(bankAccount().cpfCnpj);
    expect(JSON.stringify(f.candidate())).not.toContain(token);
  });
  it("retains a durable approval across duplicate delivery and concurrent callbacks", async () => {
    const f = fixture();
    await f.record();
    expect(
      await Promise.all(
        Array.from({ length: 3 }, () => f.service.receive(token, f.body())),
      ),
    ).toEqual(Array(3).fill({ status: "APPROVED" }));
    expect(
      f.statements.filter((s) =>
        s.startsWith("INSERT INTO withdrawal_authorization_decision"),
      ),
    ).toHaveLength(1);
    f.operation.state = "SUCCEEDED";
    f.operation.withdrawalState = "COMPLETED";
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "APPROVED",
    });
  });
  it.each([
    ["type", "TED"],
    ["operationType", "TED"],
    ["status", "DONE"],
    ["id", "foreign-transfer"],
    ["value", 2],
    ["netValue", 0.99],
    ["transferFee", 0.01],
    ["externalReference", "foreign-operation"],
  ])(
    "refuses mismatched transfer %s without creating a decision",
    async (key, value) => {
      const f = fixture();
      await f.record();
      const b = JSON.parse(f.body());
      b.transfer[key] = value;
      expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
        status: "REFUSED",
      });
      expect(f.decision()).toBeNull();
    },
  );
  it.each([
    "ownerName",
    "cpfCnpj",
    "agency",
    "account",
    "accountDigit",
    "pixAddressKey",
    "bank",
  ])(
    "refuses changed native recipient %s, including conflicting replay",
    async (key) => {
      const f = fixture();
      await f.record();
      expect(await f.service.receive(token, f.body())).toEqual({
        status: "APPROVED",
      });
      const b = JSON.parse(f.body());
      b.transfer.bankAccount[key] =
        key === "bank" ? { ispb: "99999999" } : "foreign";
      expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
        status: "REFUSED",
      });
      expect(f.decision()?.status).toBe("APPROVED");
    },
  );
  it.each([
    ["state", "UNKNOWN"],
    ["withdrawalState", "UNKNOWN"],
    ["state", "SUCCEEDED"],
    ["withdrawalState", "COMPLETED"],
    ["reservationState", "CONSUMED"],
    ["reservedCents", 0],
    ["attempts", 2],
    ["leaseToken", "foreign"],
    ["requestHash", "foreign"],
    ["consentState", "PRESENTED"],
    ["consentHash", "foreign"],
    ["providerReference", "foreign"],
    ["withdrawalProviderReference", "foreign"],
  ])("denies ineligible durable %s", async (key, value) => {
    const f = fixture();
    await f.record();
    f.operation[key] = value;
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(f.decision()).toBeNull();
  });
  it("denies missing or changed holder/payout consent and storage failures", async () => {
    const f = fixture();
    await f.record();
    f.verifyConsent.mockRejectedValue(new Error("private detail"));
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(f.decision()).toBeNull();
  });
  it.each(["", "wrong", "offline-authorization-token-123456780"])(
    "authenticates token before database access: %s",
    async (provided) => {
      const f = fixture();
      expect(await f.service.receive(provided, f.body())).toEqual({
        status: "REFUSED",
      });
      expect(f.db.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    "{",
    '{"type":"TRANSFER","type":"BILL","transfer":{}}',
    '{"type":"TRANSFER","transfer":{"id":"one","\u0069d":"two"}}',
    '{"type":"TRANSFER","transfer":{"value":1e0}}',
    '{"type":"TRANSFER","transfer":{"value":1.000000000000000001}}',
  ])("rejects malformed, duplicate, or rounded JSON: %s", async (body) => {
    const f = fixture();
    await f.record();
    expect(await f.service.receive(token, body)).toEqual({ status: "REFUSED" });
  });
  it.each([
    "siteId",
    "accountId",
    "environment",
    "operationId",
    "payloadHash",
    "providerReference",
  ])("refuses tampered candidate %s", async (key) => {
    const f = fixture();
    await f.record();
    const row = f.candidate();
    if (!row) throw new Error("Missing candidate");
    row[key] = "foreign";
    expect(await f.service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(f.decision()).toBeNull();
  });
  it.each([
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
    "provider",
    "source",
  ])("does not persist a candidate from foreign native %s", async (key) => {
    const f = fixture();
    (f.observation as unknown as Record<string, unknown>)[key] = "foreign";
    await expect(f.record()).rejects.toThrow();
    expect(f.candidate()).toBeNull();
  });
  it("supports the provider's exact reviewed masked tax ID without stripping its mask", async () => {
    const f = fixture();
    f.observation.transfer.bankAccount = {
      ...bankAccount(),
      cpfCnpj: "***.456.789-**",
    };
    await f.record();
    const b = JSON.parse(f.body());
    b.transfer.bankAccount.cpfCnpj = "***.456.789-**";
    expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
      status: "APPROVED",
    });
    b.transfer.bankAccount.cpfCnpj = "***.999.789-**";
    expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
      status: "REFUSED",
    });
  });
  it("rejects a native recipient with a different reviewed tax mask", async () => {
    const f = fixture();
    f.observation.transfer.bankAccount = {
      ...bankAccount(),
      cpfCnpj: "***.999.789-**",
    };
    await expect(f.record()).rejects.toThrow();
    expect(f.candidate()).toBeNull();
  });
  it("freezes optional routing fields when native creation supplies them", async () => {
    const f = fixture();
    f.observation.transfer.bankAccount = {
      ...bankAccount(),
      agencyDigit: null,
      type: "CHECKING_ACCOUNT",
    };
    await f.record();
    const b = JSON.parse(f.body());
    b.transfer.bankAccount.agencyDigit = null;
    b.transfer.bankAccount.type = "CHECKING_ACCOUNT";
    expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
      status: "APPROVED",
    });
    b.transfer.bankAccount.type = "SAVINGS_ACCOUNT";
    expect(await f.service.receive(token, JSON.stringify(b))).toEqual({
      status: "REFUSED",
    });
  });
  it("rejects non-JSON whitespace before accessing the database", async () => {
    const f = fixture();
    expect(await f.service.receive(token, `\u00a0${f.body()}`)).toEqual({
      status: "REFUSED",
    });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it("applies bounded database lock and statement timeouts before reading authorization state", async () => {
    const f = fixture();
    await f.record();
    const before = f.statements.length;
    await f.service.receive(token, f.body());
    expect(f.statements.slice(before, before + 2)).toEqual([
      "SET LOCAL lock_timeout = '1000ms'",
      "SET LOCAL statement_timeout = '2000ms'",
    ]);
  });
  it("refuses unsupported mode before database access", async () => {
    const f = fixture();
    const service = createAsaasWithdrawalAuthorization(f.db as never, {
      mode: "sandbox",
      applicationEnvironment: "production",
      token,
      now: () => new Date(epoch),
      verifyConsentInTransaction: f.verifyConsent,
    });
    expect(await service.receive(token, f.body())).toEqual({
      status: "REFUSED",
    });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it("rejects a native response that lacks the reviewed Pix recipient before persisting any candidate", async () => {
    const f = fixture();
    delete f.observation.transfer.bankAccount;
    await expect(f.record()).rejects.toThrow();
    expect(f.candidate()).toBeNull();
  });
});

describe("live native withdrawal authorization", () => {
  it.each([0, 100, 200])(
    "approves only the retained native allocation with an observed %i-cent fee",
    async (fee) => {
      const f = fixture(true, fee);
      await f.record();
      expect(await f.service.receive(token, f.body())).toEqual({
        status: "APPROVED",
      });
      expect(f.verifyConsent).toHaveBeenCalledOnce();
    },
  );
  it("rejects changed fee allocation even when it remains inside the approved ceilings", async () => {
    const f = fixture(true, 100);
    await f.record();
    const body = JSON.parse(f.body());
    body.transfer.netValue = 1;
    body.transfer.transferFee = 2;
    expect(await f.service.receive(token, JSON.stringify(body))).toEqual({
      status: "REFUSED",
    });
    expect(f.decision()).toBeNull();
  });
});
