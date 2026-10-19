import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { AsaasTransferObservation } from "./asaasHttpClient";
import { createAsaasWithdrawalTransferAdapter } from "./asaasTransferClient";
import { createAsaasWithdrawalCustody } from "./asaasWithdrawalCustody";
import type { DispatchFence, OriginalWithdrawal } from "./withdrawalExecution";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
} from "./withdrawalReservations";

function fixture(maximum = false) {
  const time = new Date("2026-10-14T04:00:00.000Z");
  const actor = {
    siteId: "site-1",
    userId: "operator-1",
    sessionId: "session-1",
  };
  const intent = {
    id: "withdrawal-1",
    siteId: actor.siteId,
    amountCents: 10000,
    feeCents: maximum ? 200 : 0,
    ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
    netCents: maximum ? 9800 : 10000,
    currency: "BRL" as const,
    destinationVersion: 3,
    state: "REQUESTED" as const,
    mode: "sandbox" as const,
    createdAt: time.toISOString(),
    updatedAt: time.toISOString(),
  };
  const feeQuote = {
    feeCents: maximum ? 200 : 0,
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
    source: "stored",
    verification: "verified",
    provenance: "provider",
    operatorUserId: actor.userId,
    recipientReference: snapshot.recipientReference,
    destinationId: "destination-3",
    evidenceId: "evidence-1",
    verificationReference: "verification-1",
    evidenceObservedAt: time.toISOString(),
    bankObservedAt: time.toISOString(),
    operatorProfileUpdatedAt: time.toISOString(),
    maskedDestination: "Bank **** 1234",
    operatorDisplayName: "Original Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: actor.siteId,
      requestId: snapshot.requestId,
      mode: "sandbox",
      amountCents: 10000,
      feeCents: maximum ? 200 : 0,
      ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
      netCents: maximum ? 9800 : 10000,
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
    presentation,
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
    feeCents: maximum ? 200 : 0,
    netCents: maximum ? 9800 : 10000,
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
  const fence: DispatchFence = {
    operationId: snapshot.operationId,
    attempts: 1,
    leaseOwner: "worker-1",
    leaseToken: "token-1",
    leaseExpiresAt: new Date(+time + 60000).toISOString(),
  };
  return { original, fence, time };
}

function adapterFixture(maximum = false) {
  const f = fixture(maximum);
  const destination = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    environment: "sandbox" as const,
    recipientReference: "recipient-1",
    bankReference: "bank-1",
    destinationVersion: 3,
    pixAddressKey: "cliente-a00001@pix.bcb.gov.br",
    pixAddressKeyType: "EMAIL" as const,
    provenance: "provider" as const,
    verification: "verified" as const,
  };
  const observation: AsaasTransferObservation = {
    source: "provider",
    provider: "ASAAS",
    siteId: "site-1",
    accountBindingId: "account-1",
    accountReference: "acct-1",
    environment: "sandbox",
    observedAt: f.time,
    transfer: {
      id: "transfer-1",
      type: "PIX",
      operationType: "PIX",
      status: "DONE",
      value: "100.00",
      netValue: "100.00",
      transferFee: "0.00",
      externalReference: "operation-1",
      transactionReceiptUrl: "https://sandbox.asaas.com/receipt/1",
      endToEndIdentifier: "E123",
      effectiveDate: "2026-10-14",
    },
  };
  const client = {
    createPixTransfer: vi.fn(async () => structuredClone(observation)),
    getTransfer: vi.fn(async () => structuredClone(observation)),
    listTransfers: vi.fn(async (offset: number) => ({
      ...structuredClone(observation),
      offset,
      totalCount: 1,
      hasMore: false,
      transfers: [structuredClone(observation.transfer)],
    })),
  };
  const custody = {
    record: vi.fn(async () => `asaas-transfer:${"a".repeat(64)}`),
  };
  const loadDestination = vi.fn(async () => structuredClone(destination));
  const adapter = createAsaasWithdrawalTransferAdapter({
    mode: "sandbox",
    applicationEnvironment: "test",
    now: () => f.time,
    loadDestination,
    loadClient: vi.fn(async () => client),
    custody,
  });
  return {
    ...f,
    destination,
    observation,
    client,
    custody,
    loadDestination,
    adapter,
  };
}
describe("Sandbox native withdrawal transfer adapter", () => {
  it("sends the frozen net amount once and records completed provider custody", async () => {
    const f = adapterFixture();
    const result = await f.adapter.dispatch(f.original, f.fence);
    expect(result).toMatchObject({
      outcome: "ACCEPTED",
      providerReference: "transfer-1",
      proofReference: `asaas-transfer:${"a".repeat(64)}`,
    });
    expect(f.client.createPixTransfer).toHaveBeenCalledWith({
      valueCents: 10000,
      pixAddressKey: f.destination.pixAddressKey,
      pixAddressKeyType: "EMAIL",
      externalReference: "operation-1",
    });
    expect(f.custody.record).toHaveBeenCalledTimes(1);
  });
  it("keeps a lost POST unresolved and never retries", async () => {
    const f = adapterFixture();
    f.client.createPixTransfer.mockRejectedValue(new Error("lost"));
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(f.client.createPixTransfer).toHaveBeenCalledTimes(1);
    expect(f.client.listTransfers).not.toHaveBeenCalled();
  });
  it("reconciles a lost response through native pages without redispatch", async () => {
    const f = adapterFixture();
    const result = await f.adapter.lookup(f.original, f.fence, null);
    expect(result).toMatchObject({
      outcome: "FOUND",
      observation: { providerReference: "transfer-1" },
    });
    expect(f.client.listTransfers).toHaveBeenCalledWith(0);
    expect(f.client.createPixTransfer).not.toHaveBeenCalled();
  });
  it("reads a known provider ID directly", async () => {
    const f = adapterFixture();
    await f.adapter.lookup(f.original, f.fence, "transfer-1");
    expect(f.client.getTransfer).toHaveBeenCalledWith("transfer-1");
    expect(f.client.listTransfers).not.toHaveBeenCalled();
  });
  it.each([
    "siteId",
    "accountId",
    "bankReference",
    "recipientReference",
    "environment",
    "destinationVersion",
    "provenance",
  ])("rejects foreign destination %s before POST", async (key) => {
    const f = adapterFixture();
    (f.destination as Record<string, unknown>)[key] = "foreign";
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(f.client.createPixTransfer).not.toHaveBeenCalled();
  });
  it.each([
    "value",
    "netValue",
    "transferFee",
    "externalReference",
    "operationType",
  ])("never creates completion proof for contradictory %s", async (key) => {
    const f = adapterFixture();
    (f.observation.transfer as unknown as Record<string, unknown>)[key] =
      "foreign";
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(f.custody.record).not.toHaveBeenCalled();
  });
  it("retains pending provider IDs without manufacturing a completion proof", async () => {
    const f = adapterFixture();
    f.observation.transfer.status = "PENDING";
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "ACCEPTED",
      providerReference: "transfer-1",
      proofReference: null,
    });
  });
  it("keeps duplicate correlation matches unresolved", async () => {
    const f = adapterFixture();
    f.client.listTransfers.mockResolvedValue({
      ...f.observation,
      offset: 0,
      totalCount: 2,
      hasMore: false,
      transfers: [
        f.observation.transfer,
        { ...f.observation.transfer, id: "transfer-2" },
      ],
    });
    expect(await f.adapter.lookup(f.original, f.fence, null)).toEqual({
      outcome: "UNRESOLVED",
    });
    expect(f.custody.record).not.toHaveBeenCalled();
  });
});

describe("durable Asaas withdrawal completion custody", () => {
  it("is not satisfied by an in-memory completion reference", async () => {
    const { createAsaasWithdrawalCustody } = await import(
      "./asaasWithdrawalCustody"
    );
    const f = adapterFixture();
    const tx = { execute: vi.fn(async () => ({ rows: [] })) };
    const db = {
      transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
    };
    const custody = createAsaasWithdrawalCustody(db as never, {
      mode: "sandbox",
      applicationEnvironment: "test",
      now: () => f.time,
    });
    expect(
      await custody.loadCompletionProofInTransaction(
        tx as never,
        f.original,
        f.fence,
        `asaas-transfer:${"a".repeat(64)}`,
      ),
    ).toBeNull();
  });
});

function custodyFixture() {
  const f = adapterFixture();
  let retained: Record<string, unknown> | null = null;
  const operation = {
    requestHash: f.original.correlation.requestHash,
    requestSnapshot: JSON.parse(JSON.stringify(f.original.snapshot)),
    state: "PROCESSING",
    attempts: 1,
    leaseOwner: f.fence.leaseOwner,
    leaseToken: f.fence.leaseToken,
    leaseExpiresAt: f.fence.leaseExpiresAt,
    providerReference: null,
  };
  const dialect = new PgDialect();
  const execute = vi.fn(
    async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (sql.includes('FROM "financial_operation"'))
        return { rows: [operation] };
      if (sql.startsWith('INSERT INTO "withdrawal_provider_observation"')) {
        if (!retained)
          retained = {
            id: params[0],
            siteId: params[1],
            accountId: params[2],
            environment: params[3],
            operationId: params[4],
            providerReference: params[5],
            payloadHash: params[6],
            payload: JSON.parse(String(params[7])),
            observedAt: params[8],
            recordedAt: f.time,
          };
        return { rows: [] };
      }
      return { rows: retained ? [structuredClone(retained)] : [] };
    },
  );
  const tx = { execute };
  const db = {
    transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
  };
  const custody = createAsaasWithdrawalCustody(db as never, {
    mode: "sandbox",
    applicationEnvironment: "test",
    now: () => f.time,
  });
  return {
    ...f,
    tx,
    custody,
    operation,
    retained: () => retained as Record<string, unknown>,
  };
}
describe("original-operation custody record and transactional proof loading", () => {
  it("records a content-addressed proof and derives completion only from the retained provider observation", async () => {
    const f = custodyFixture();
    const reference = await f.custody.record(
      f.original,
      f.fence,
      f.observation,
    );
    expect(reference).toMatch(/^asaas-transfer:[a-f0-9]{64}$/);
    const proof = await f.custody.loadCompletionProofInTransaction(
      f.tx as never,
      f.original,
      f.fence,
      reference,
    );
    expect(proof).toMatchObject({
      outcome: "COMPLETED",
      custody: "immutable-durable",
      provenance: "provider",
      providerReference: "transfer-1",
      totalDebitCents: 10000,
      netCents: 10000,
      feeCents: 0,
      proofReference: reference,
      receiptReference: reference,
    });
    expect(f.retained().payload).not.toHaveProperty("pixAddressKey");
    expect(await f.custody.record(f.original, f.fence, f.observation)).toBe(
      reference,
    );
  });
  it.each(["leaseToken", "requestHash", "attempts", "requestSnapshot"])(
    "rejects a changed operation %s before writing custody",
    async (key) => {
      const f = custodyFixture();
      (f.operation as Record<string, unknown>)[key] = "changed";
      await expect(
        f.custody.record(f.original, f.fence, f.observation),
      ).rejects.toThrow("custody unavailable");
      expect(f.retained()).toBeNull();
    },
  );
  it.each(["providerReference", "payloadHash", "recordedAt", "environment"])(
    "does not load tampered durable metadata %s",
    async (key) => {
      const f = custodyFixture();
      const reference = await f.custody.record(
        f.original,
        f.fence,
        f.observation,
      );
      f.retained()[key] = "changed";
      expect(
        await f.custody.loadCompletionProofInTransaction(
          f.tx as never,
          f.original,
          f.fence,
          reference,
        ),
      ).toBeNull();
    },
  );
  it("retains a pending observation without allowing completion", async () => {
    const f = custodyFixture();
    f.observation.transfer.status = "PENDING";
    const reference = await f.custody.record(
      f.original,
      f.fence,
      f.observation,
    );
    expect(
      await f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        reference,
      ),
    ).toBeNull();
  });
  it("detects a payload changed after insertion", async () => {
    const f = custodyFixture();
    const reference = await f.custody.record(
      f.original,
      f.fence,
      f.observation,
    );
    (f.retained().payload as Record<string, unknown>).version = 2;
    expect(
      await f.custody.loadCompletionProofInTransaction(
        f.tx as never,
        f.original,
        f.fence,
        reference,
      ),
    ).toBeNull();
  });
});

describe("bounded transfer reconciliation and dispatch gates", () => {
  it("stops after ten full pages and never redispatches", async () => {
    const f = adapterFixture();
    f.client.listTransfers.mockImplementation(async (offset) => ({
      ...f.observation,
      offset,
      totalCount: 1100,
      hasMore: true,
      transfers: Array.from({ length: 100 }, (_, index) => ({
        ...f.observation.transfer,
        id: `other-${offset + index}`,
        externalReference: "another-operation",
      })),
    }));
    expect(await f.adapter.lookup(f.original, f.fence, null)).toEqual({
      outcome: "UNRESOLVED",
    });
    expect(f.client.listTransfers).toHaveBeenCalledTimes(10);
    expect(f.client.createPixTransfer).not.toHaveBeenCalled();
  });
  it("does not conclude absence from an account-mismatched page", async () => {
    const f = adapterFixture();
    f.client.listTransfers.mockResolvedValue({
      ...f.observation,
      accountBindingId: "another",
      offset: 0,
      totalCount: 0,
      hasMore: false,
      transfers: [],
    });
    expect(await f.adapter.lookup(f.original, f.fence, null)).toEqual({
      outcome: "UNRESOLVED",
    });
  });
  it("does not dispatch after the original lease expires", async () => {
    const f = adapterFixture();
    f.fence.leaseExpiresAt = f.time.toISOString();
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(f.client.createPixTransfer).not.toHaveBeenCalled();
  });
  it("does not dispatch a nonzero-fee or malformed frozen request", async () => {
    const f = adapterFixture();
    f.original.correlation.feeCents = 200;
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(f.client.createPixTransfer).not.toHaveBeenCalled();
  });
  it("retains terminal provider failure without producing a debit proof", async () => {
    const f = adapterFixture();
    f.observation.transfer.status = "FAILED";
    expect(await f.adapter.dispatch(f.original, f.fence)).toMatchObject({
      outcome: "REJECTED",
      reason: "ASAAS_TRANSFER_FAILED",
    });
    expect(f.custody.record).toHaveBeenCalledTimes(1);
  });
});

describe("withdrawal consent retains the reviewed external payout", () => {
  it("accepts an external Pix mask and freezes its exact reviewed binding", () => {
    const f = fixture();
    const payout = {
      destinationId: "external-1",
      destinationVersion: 4,
      configurationHash: "b".repeat(64),
      reviewId: "review-1",
      holderId: "holder-1",
      holderConsentId: "holder-consent-1",
      acceptThirdParty: true,
      keyType: "EMAIL",
      maskedKey: "c***@p***",
      ownerName: "Sandbox Recipient",
    };
    const consent = readWithdrawalConsentSnapshot({
      ...f.original.consent.snapshot,
      preview: {
        ...f.original.consent.snapshot.preview,
        maskedDestination: "Pix EMAIL: c***@p***",
        payoutRecipientName: "Sandbox Recipient",
      },
      presentation: {
        ...f.original.consent.snapshot.presentation,
        maskedDestination: "Pix EMAIL: c***@p***",
        payout,
      },
    });
    expect(consent.presentation.payout).toEqual(payout);
    expect(consent.preview.payoutRecipientName).toBe("Sandbox Recipient");
  });
});

it("dispatches the fixed recipient net under an approved maximum fee without promising zero", async () => {
  const f = adapterFixture(true);
  f.observation.transfer.value = "98.00";
  f.observation.transfer.netValue = "98.00";
  const result = await f.adapter.dispatch(f.original, f.fence);
  expect(result).toMatchObject({
    outcome: "ACCEPTED",
    providerReference: "transfer-1",
  });
  expect(f.client.createPixTransfer).toHaveBeenCalledWith(
    expect.objectContaining({ valueCents: 9800 }),
  );
  expect(f.original.snapshot.intent.amountCents).toBe(10000);
  expect(f.original.snapshot.intent.feeCents).toBe(200);
});
