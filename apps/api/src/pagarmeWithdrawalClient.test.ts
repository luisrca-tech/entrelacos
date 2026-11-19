import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";
import type { PagarmeWithdrawal } from "./pagarmeRecipientClient";
import {
  createPagarmeWithdrawalAdapter,
  createPagarmeWithdrawalCustody,
  PAGARME_WITHDRAWAL_POLICY_VERSION,
  type PagarmeWithdrawalObservation,
  pagarmeWithdrawalIdempotencyKey,
} from "./pagarmeWithdrawalClient";
import { withdrawalCorrelation } from "./withdrawalExecution";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
  readWithdrawalReservationSnapshot,
} from "./withdrawalReservations";

const dialect = new PgDialect();
const recipient = "rp_fixtureRecipient01";

function withdrawalFixture(status: string): PagarmeWithdrawal {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        `./__fixtures__/pagarme/recipient-withdrawal-${status}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return {
    id: raw.id,
    amountCents: raw.amount,
    status: raw.status,
    updatedAt: new Date(raw.updated_at).toISOString(),
  };
}

function fixture(options: { live?: boolean; amountCents?: number } = {}) {
  const mode = options.live ? ("live" as const) : ("sandbox" as const);
  const semantics = options.live
    ? ("MAXIMUM_WITH_MINIMUM_NET" as const)
    : ("MAXIMUM" as const);
  const amountCents = options.amountCents ?? 10_000;
  const base = Date.now() - 60_000;
  const iso = (offset = 0) => new Date(base + offset).toISOString();
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: recipient,
    environment: mode,
    bankReference: "ba_fixtureBankAcct01",
    destinationVersion: 1,
    amountCents,
    currency: "BRL" as const,
  };
  const feeQuote = {
    feeCents: 367,
    feeSemantics: semantics,
    policyVersion: PAGARME_WITHDRAWAL_POLICY_VERSION,
    provenance: "provider" as const,
    observedAt: iso(-10_000),
    expiresAt: iso(200_000),
  };
  const intent = {
    id: "withdrawal-1",
    siteId: scope.siteId,
    amountCents,
    feeCents: 367,
    feeSemantics: semantics,
    netCents: amountCents - 367,
    currency: "BRL" as const,
    destinationVersion: 1,
    state: "REQUESTED" as const,
    mode,
    createdAt: iso(),
    updatedAt: iso(),
  };
  const requestId = "request-1";
  const operatorUserId = "operator-1";
  const snapshot = readWithdrawalReservationSnapshot({
    intent,
    requestId,
    accountId: scope.accountId,
    operatorUserId,
    accountReference: recipient,
    recipientReference: recipient,
    bankReference: scope.bankReference,
    environment: mode,
    operationId: "operation-1",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          scope.siteId,
          requestId,
          operatorUserId,
          mode,
          amountCents,
          1,
        ]),
      )
      .digest("hex"),
    authenticationAuditHash: "a".repeat(64),
    feeQuote,
    balance: { balanceCents: 25_000, observedAt: iso(-10_000) },
  });
  const presentation = {
    ...scope,
    source: "stored",
    verification: "verified",
    provenance: "provider",
    operatorUserId,
    recipientReference: recipient,
    destinationId: "destination-1",
    evidenceId: "evidence-1",
    verificationReference: "verification-1",
    evidenceObservedAt: iso(-20_000),
    bankObservedAt: iso(-20_000),
    operatorProfileUpdatedAt: iso(-20_000),
    maskedDestination: "Conta **** 1234",
    operatorDisplayName: "Original Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: scope.siteId,
      requestId,
      mode,
      amountCents,
      feeCents: 367,
      feeSemantics: semantics,
      netCents: amountCents - 367,
      currency: "BRL",
      destinationVersion: 1,
      maskedDestination: presentation.maskedDestination,
      operatorDisplayName: presentation.operatorDisplayName,
      policyVersion: feeQuote.policyVersion,
      issuedAt: iso(-5_000),
      expiresAt: feeQuote.expiresAt,
    },
    scope,
    operatorUserId,
    recipientReference: recipient,
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
      holderConsentReference: "holder-consent-1",
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
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { mode, original, fence, snapshot };
}

function fakeDatabase(f: ReturnType<typeof fixture>) {
  const stored = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    statements.push(text);
    if (text.includes('AS "currentTime"'))
      return { rows: [{ currentTime: new Date().toISOString() }] };
    if (/from "financial_operation"/i.test(text))
      return {
        rows: [
          {
            requestHash: f.snapshot.requestHash,
            requestSnapshot: JSON.parse(JSON.stringify(f.snapshot)),
            state: "PROCESSING",
            attempts: 1,
            leaseOwner: f.fence.leaseOwner,
            leaseToken: f.fence.leaseToken,
            leaseExpiresAt: f.fence.leaseExpiresAt,
            providerReference: null,
          },
        ],
      };
    if (text.startsWith('INSERT INTO "withdrawal_provider_observation"')) {
      const [id, siteId, accountId, environment, operationId, provider, hash] =
        params as string[];
      if (!stored.has(id))
        stored.set(id, {
          id,
          siteId,
          accountId,
          environment,
          operationId,
          providerReference: provider,
          payloadHash: hash,
          payload: JSON.parse(params[7] as string),
          observedAt: new Date(params[8] as string),
          recordedAt: new Date().toISOString(),
        });
      return { rows: [] };
    }
    if (/from "withdrawal_provider_observation"/i.test(text)) {
      const row = stored.get(params[0] as string);
      return {
        rows: row ? [{ ...row, readAt: new Date().toISOString() }] : [],
      };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const tx = { execute };
  return {
    db: {
      transaction: vi.fn(async (operation: (t: typeof tx) => unknown) =>
        operation(tx),
      ),
    },
    tx,
    stored,
    statements,
  };
}

function setup(
  options: {
    live?: boolean;
    withdrawal?: PagarmeWithdrawal;
    listed?: PagarmeWithdrawal[];
    elapsedMs?: number;
  } = {},
) {
  const f = fixture(options);
  const database = fakeDatabase(f);
  const mode = f.mode;
  const applicationEnvironment = options.live
    ? ("production" as const)
    : ("test" as const);
  const custody = createPagarmeWithdrawalCustody(database.db as never, {
    mode,
    applicationEnvironment,
    now: () => new Date(),
  });
  const client = {
    createWithdrawal: vi.fn(
      async () => options.withdrawal ?? withdrawalFixture("pending"),
    ),
    getWithdrawal: vi.fn(
      async () => options.withdrawal ?? withdrawalFixture("pending"),
    ),
    listWithdrawals: vi.fn(
      async (): Promise<PagarmeWithdrawal[]> => options.listed ?? [],
    ),
  };
  const alerts: string[] = [];
  const adapter = createPagarmeWithdrawalAdapter({
    mode,
    applicationEnvironment,
    now: () => new Date(Date.now() + (options.elapsedMs ?? 0)),
    client,
    custody,
    async onUnresolved(_original, reason) {
      alerts.push(reason);
    },
  });
  return { ...f, ...database, custody, client, adapter, alerts };
}

describe("Pagar.me withdrawal dispatch", () => {
  it("sends the gross amount minus the fixed fee with a stable idempotency key", async () => {
    const s = setup();
    const observation = await s.adapter.dispatch(s.original, s.fence);
    expect(s.client.createWithdrawal).toHaveBeenCalledExactlyOnceWith(
      recipient,
      9_633,
      pagarmeWithdrawalIdempotencyKey(s.original.correlation),
    );
    expect(pagarmeWithdrawalIdempotencyKey(s.original.correlation)).toBe(
      pagarmeWithdrawalIdempotencyKey({ ...s.original.correlation }),
    );
    expect(observation).toMatchObject({
      outcome: "ACCEPTED",
      providerReference: "with_fixtureWithdraw01",
      proofReference: null,
    });
    expect([...s.stored.keys()]).toEqual([
      expect.stringMatching(/^pagarme-withdrawal:[a-f0-9]{64}$/),
    ]);
  });

  it("accepts and proves a pending transfer identified by an integer id", async () => {
    const transfer = {
      id: "65485",
      amountCents: 9_633,
      status: "pending_transfer",
      updatedAt: new Date().toISOString(),
    };
    const s = setup({ withdrawal: transfer });
    const observation = await s.adapter.dispatch(s.original, s.fence);
    expect(observation).toMatchObject({
      outcome: "ACCEPTED",
      providerReference: "65485",
      proofReference: null,
    });
    const done = setup({
      withdrawal: { ...transfer, status: "transferred" },
    });
    const completed = await done.adapter.dispatch(done.original, done.fence);
    const reference =
      completed.outcome === "ACCEPTED" ? completed.proofReference : null;
    await expect(
      done.custody.loadCompletionProofInTransaction(
        done.tx as never,
        done.original,
        done.fence,
        reference as string,
      ),
    ).resolves.toMatchObject({
      outcome: "COMPLETED",
      providerReference: "65485",
    });
  });

  it("returns a completion reference for a transferred withdrawal", async () => {
    const s = setup({ withdrawal: withdrawalFixture("transferred") });
    const observation = await s.adapter.dispatch(s.original, s.fence);
    expect(observation.outcome).toBe("ACCEPTED");
    const reference =
      observation.outcome === "ACCEPTED" ? observation.proofReference : null;
    expect(reference).toMatch(/^pagarme-withdrawal:[a-f0-9]{64}$/);
    await expect(
      s.custody.loadCompletionProofInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        reference as string,
      ),
    ).resolves.toMatchObject({
      outcome: "COMPLETED",
      providerReference: "with_fixtureWithdraw01",
      totalDebitCents: 10_000,
      feeCents: 367,
      netCents: 9_633,
      bankCompleted: true,
      custody: "immutable-durable",
    });
    await expect(
      s.custody.loadTerminalFailureInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        reference as string,
      ),
    ).resolves.toBeNull();
  });

  it("rejects a failed withdrawal with an immutable terminal failure proof", async () => {
    const s = setup({ withdrawal: withdrawalFixture("failed") });
    const observation = await s.adapter.dispatch(s.original, s.fence);
    expect(observation).toMatchObject({
      outcome: "REJECTED",
      reason: "PAGARME_WITHDRAWAL_FAILED",
      providerReference: "with_fixtureWithdraw01",
    });
    const reference =
      observation.outcome === "REJECTED" ? observation.proofReference : "";
    expect(reference).toMatch(/^pagarme-withdrawal:[a-f0-9]{64}$/);
    await expect(
      s.custody.loadTerminalFailureInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        reference as string,
      ),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      feeCents: 0,
      proofReference: reference,
    });
    await expect(
      s.custody.loadCompletionProofInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        reference as string,
      ),
    ).resolves.toBeNull();
  });

  it("maps a canceled withdrawal to a cancelled terminal outcome", async () => {
    const s = setup({
      withdrawal: { ...withdrawalFixture("failed"), status: "canceled" },
    });
    await expect(
      s.adapter.dispatch(s.original, s.fence),
    ).resolves.toMatchObject({
      outcome: "REJECTED",
      reason: "PAGARME_WITHDRAWAL_CANCELLED",
    });
  });

  it("fails a withdrawal Pagar.me refused (4xx) with a terminal proof that releases the hold", async () => {
    const s = setup();
    s.client.createWithdrawal.mockRejectedValueOnce(
      new PagarmeRejectedError(422, "invalid_amount", "Saldo insuficiente"),
    );
    const observation = await s.adapter.dispatch(s.original, s.fence);
    expect(observation).toMatchObject({
      outcome: "REJECTED",
      reason: "PAGARME_WITHDRAWAL_FAILED",
      providerReference: expect.stringMatching(/^rejected_[a-f0-9]{32}$/),
    });
    const reference =
      observation.outcome === "REJECTED" ? observation.proofReference : "";
    await expect(
      s.custody.loadTerminalFailureInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        reference as string,
      ),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      feeCents: 0,
      proofReference: reference,
    });
    // The same refused command always maps to the same local reference.
    s.client.createWithdrawal.mockRejectedValueOnce(
      new PagarmeRejectedError(422, "invalid_amount", null),
    );
    const again = await s.adapter.dispatch(s.original, s.fence);
    expect(again).toMatchObject({
      providerReference:
        observation.outcome === "REJECTED" ? observation.providerReference : "",
    });
  });

  it("keeps a 401/403/429 refusal unresolved (configuration or throttling, not a final answer)", async () => {
    for (const status of [401, 403, 429]) {
      const s = setup();
      s.client.createWithdrawal.mockRejectedValueOnce(
        new PagarmeRejectedError(status, null, null),
      );
      await expect(
        s.adapter.dispatch(s.original, s.fence),
      ).resolves.toMatchObject({ outcome: "UNRESOLVED" });
      expect(s.stored.size).toBe(0);
    }
  });

  it("keeps an unknown provider outcome unresolved without recording custody", async () => {
    const s = setup();
    s.client.createWithdrawal.mockRejectedValueOnce(
      new PagarmeUnknownOutcomeError("timeout"),
    );
    await expect(s.adapter.dispatch(s.original, s.fence)).resolves.toEqual({
      outcome: "UNRESOLVED",
      correlation: s.original.correlation,
      holderBinding: s.original.holderBinding,
      fence: s.fence,
    });
    expect(s.stored.size).toBe(0);
  });

  it("does not accept a provider amount other than the net transfer", async () => {
    const s = setup({
      withdrawal: { ...withdrawalFixture("transferred"), amountCents: 10_000 },
    });
    await expect(
      s.adapter.dispatch(s.original, s.fence),
    ).resolves.toMatchObject({ outcome: "UNRESOLVED" });
    expect(s.stored.size).toBe(0);
  });

  it("does not dispatch after the fence expired", async () => {
    const s = setup();
    const fence = {
      ...s.fence,
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    };
    await expect(s.adapter.dispatch(s.original, fence)).resolves.toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(s.client.createWithdrawal).not.toHaveBeenCalled();
  });

  it("runs the provider request inside the composition guard", async () => {
    const f = fixture();
    const database = fakeDatabase(f);
    const order: string[] = [];
    const custody = createPagarmeWithdrawalCustody(database.db as never, {
      mode: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
    });
    const client = {
      createWithdrawal: vi.fn(async () => {
        order.push("post");
        return withdrawalFixture("pending");
      }),
      getWithdrawal: vi.fn(),
      listWithdrawals: vi.fn(),
    };
    const adapter = createPagarmeWithdrawalAdapter({
      mode: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
      client,
      custody,
      async guardDispatch(_original, _fence, send) {
        order.push("guard");
        const result = await send();
        order.push("released");
        return result;
      },
    });
    await adapter.dispatch(f.original, f.fence);
    expect(order).toEqual(["guard", "post", "released"]);
  });
});

describe("Pagar.me withdrawal dispatch guard", () => {
  it("fails a withdrawal the guard refused before sending, releasing the hold, and never POSTs", async () => {
    const f = fixture();
    const database = fakeDatabase(f);
    const client = {
      createWithdrawal: vi.fn(),
      getWithdrawal: vi.fn(),
      listWithdrawals: vi.fn(),
    };
    const adapter = createPagarmeWithdrawalAdapter({
      mode: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
      client,
      custody: createPagarmeWithdrawalCustody(database.db as never, {
        mode: "sandbox",
        applicationEnvironment: "test",
        now: () => new Date(),
      }),
      async guardDispatch() {
        throw new Error("destination changed");
      },
    });
    const observation = await adapter.dispatch(f.original, f.fence);
    expect(observation).toMatchObject({
      outcome: "REJECTED",
      reason: "PAGARME_WITHDRAWAL_NOT_SENT",
      proofReference: expect.stringMatching(/^pagarme-withdrawal:/),
      providerReference: expect.stringMatching(/^rejected_/),
    });
    expect(client.createWithdrawal).not.toHaveBeenCalled();
    // A later lookup never replays the POST either.
    await adapter.lookup(f.original, f.fence, null);
    expect(client.createWithdrawal).not.toHaveBeenCalled();
  });

  it("keeps the outcome unknown when the guard fails after the POST left", async () => {
    const f = fixture();
    const database = fakeDatabase(f);
    const client = {
      createWithdrawal: vi.fn(async () => withdrawalFixture("pending")),
      getWithdrawal: vi.fn(),
      listWithdrawals: vi.fn(),
    };
    const adapter = createPagarmeWithdrawalAdapter({
      mode: "sandbox",
      applicationEnvironment: "test",
      now: () => new Date(),
      client,
      custody: createPagarmeWithdrawalCustody(database.db as never, {
        mode: "sandbox",
        applicationEnvironment: "test",
        now: () => new Date(),
      }),
      async guardDispatch(_original, _fence, send) {
        await send();
        throw new Error("commit lost");
      },
    });
    await expect(adapter.dispatch(f.original, f.fence)).resolves.toMatchObject({
      outcome: "UNRESOLVED",
    });
    expect(client.createWithdrawal).toHaveBeenCalledOnce();
  });
});

describe("Pagar.me withdrawal lookup", () => {
  it("reads a known withdrawal by provider reference", async () => {
    const s = setup({ withdrawal: withdrawalFixture("transferred") });
    const found = await s.adapter.lookup(
      s.original,
      s.fence,
      "with_fixtureWithdraw01",
    );
    expect(s.client.getWithdrawal).toHaveBeenCalledExactlyOnceWith(
      recipient,
      "with_fixtureWithdraw01",
    );
    expect(s.client.createWithdrawal).not.toHaveBeenCalled();
    expect(found).toMatchObject({
      outcome: "FOUND",
      observation: {
        outcome: "ACCEPTED",
        proofReference: expect.stringMatching(/^pagarme-withdrawal:/),
      },
    });
  });

  it("recovers a lost POST response from the withdrawal list, never replaying the POST", async () => {
    const pending = withdrawalFixture("pending");
    const s = setup({
      listed: [
        { ...pending, id: "with_otherAmount01", amountCents: 1_000 },
        pending,
      ],
    });
    const found = await s.adapter.lookup(s.original, s.fence, null);
    expect(s.client.createWithdrawal).not.toHaveBeenCalled();
    expect(s.client.listWithdrawals).toHaveBeenCalledExactlyOnceWith(
      recipient,
      expect.any(String),
    );
    expect(found).toMatchObject({
      outcome: "FOUND",
      observation: { providerReference: "with_fixtureWithdraw01" },
    });
  });

  it("stays unresolved, without alerting, while the list may still lag", async () => {
    const s = setup({ listed: [] });
    await expect(s.adapter.lookup(s.original, s.fence, null)).resolves.toEqual({
      outcome: "UNRESOLVED",
    });
    expect(s.alerts).toEqual([]);
    expect(s.client.createWithdrawal).not.toHaveBeenCalled();
  });

  it("alerts an operator once the window passed with no single match", async () => {
    const pending = withdrawalFixture("pending");
    for (const listed of [[], [pending, { ...pending, id: "with_twin0001" }]]) {
      const s = setup({ listed, elapsedMs: 2 * 60 * 60_000 });
      await expect(
        s.adapter.lookup(s.original, s.fence, null),
      ).resolves.toEqual({ outcome: "UNRESOLVED" });
      expect(s.alerts).toEqual([
        listed.length ? "AMBIGUOUS_PROVIDER_MATCH" : "NO_PROVIDER_MATCH",
      ]);
      expect(s.client.createWithdrawal).not.toHaveBeenCalled();
    }
  });

  it("keeps the hold when reading the list is refused (4xx)", async () => {
    const s = setup();
    s.client.listWithdrawals.mockRejectedValueOnce(
      new PagarmeRejectedError(422, "validation_error", "Invalid filter"),
    );
    await expect(s.adapter.lookup(s.original, s.fence, null)).resolves.toEqual({
      outcome: "UNRESOLVED",
    });
    expect(s.stored.size).toBe(0);
  });

  it("rejects a foreign withdrawal returned for the stored reference", async () => {
    const s = setup({
      withdrawal: { ...withdrawalFixture("transferred"), id: "with_other" },
    });
    await expect(
      s.adapter.lookup(s.original, s.fence, "with_fixtureWithdraw01"),
    ).resolves.toEqual({ outcome: "UNRESOLVED" });
  });
});

describe("Pagar.me withdrawal custody", () => {
  it("records content-addressed observations idempotently", async () => {
    const s = setup();
    const observation: PagarmeWithdrawalObservation = {
      source: "provider",
      provider: "PAGARME",
      siteId: "site-1",
      accountBindingId: "account-1",
      accountReference: recipient,
      environment: "sandbox",
      observedAt: new Date().toISOString(),
      withdrawal: withdrawalFixture("pending"),
    };
    const first = await s.custody.record(s.original, s.fence, observation);
    const second = await s.custody.record(s.original, s.fence, observation);
    expect(first).toBe(second);
    expect(first).toMatch(/^pagarme-withdrawal:[a-f0-9]{64}$/);
    expect(s.stored.get(first)?.payloadHash).toBe(
      first.slice("pagarme-withdrawal:".length),
    );
  });

  it("does not load proof for a reference outside the Pagar.me namespace", async () => {
    const s = setup();
    await expect(
      s.custody.loadCompletionProofInTransaction(
        s.tx as never,
        s.original,
        s.fence,
        `legacy-transfer:${"a".repeat(64)}`,
      ),
    ).resolves.toBeNull();
  });
});
