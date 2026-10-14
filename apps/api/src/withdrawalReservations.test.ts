import { createHash } from "node:crypto";
import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import {
  withdrawalRequestContextSchema,
  withdrawalRequestStatusSchema,
} from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AsaasBalanceObservation } from "./asaasHttpClient";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import { FinancialAuthorizationError } from "./financialAuthorization";
import {
  createWithdrawalReservationService,
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
  readWithdrawalReservationRecord,
  readWithdrawalReservationSnapshot,
  type WithdrawalConfirmationReference,
  type WithdrawalConsentRecord,
  type WithdrawalConsentSnapshot,
  type WithdrawalFeeQuote,
  type WithdrawalReservationContext,
  type WithdrawalReservationCurrentAuthorization,
  type WithdrawalReservationLockedState,
  type WithdrawalReservationOptions,
  type WithdrawalReservationRecord,
  type WithdrawalReservationSnapshot,
} from "./withdrawalReservations";

const now = new Date("2026-10-12T12:00:00.000Z");

function fixture() {
  const actor: FinancialActor = {
    userId: "user:operator.1",
    siteId: "site-1",
    sessionId: "session:1",
  };
  const access: SiteAccess = {
    siteId: actor.siteId,
    userId: actor.userId,
    membershipId: "membership-1",
    membershipRole: "SITE_ADMIN",
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
  const recentAuth: RecentFinancialAuthenticationEvidence = {
    ...actor,
    proofKind: "PASSWORD_REAUTHENTICATION",
    verification: "verified",
    provenance: "backend",
    authenticatedAt: new Date("2026-10-12T11:59:30.000Z"),
    expiresAt: new Date("2026-10-12T12:04:30.000Z"),
  };
  const readiness: ReceivingReadiness = {
    siteId: actor.siteId,
    state: "READY",
    reason: null,
    observedAt: now.toISOString(),
    destinationVersion: 3,
    catalogEligible: true,
    mode: "sandbox",
  };
  const context: WithdrawalReservationContext = {
    siteId: actor.siteId,
    isDemo: true,
    mode: "sandbox",
    verification: "verified",
    accountId: "account-1",
    bankReference: "bank-1",
    recipientBinding: {
      siteId: actor.siteId,
      operatorUserId: actor.userId,
      accountReference: "acct_1",
      recipientReference: "wallet_1",
      environment: "sandbox",
      destinationVersion: 3,
    },
    readiness,
  };
  const fee: WithdrawalFeeQuote = {
    siteId: actor.siteId,
    accountId: "account-1",
    accountReference: "acct_1",
    environment: "sandbox",
    bankReference: "bank-1",
    destinationVersion: 3,
    amountCents: 10_000,
    currency: "BRL",
    feeCents: 500,
    policyVersion: "provider-fee-v1",
    provenance: "provider",
    verification: "verified",
    observedAt: new Date(now),
    expiresAt: new Date(now.getTime() + 60_000),
  };
  const balance: AsaasBalanceObservation = {
    source: "provider",
    provider: "ASAAS",
    siteId: actor.siteId,
    accountBindingId: "account-1",
    accountReference: "acct_1",
    environment: "sandbox",
    currency: "BRL",
    observedAt: new Date(now),
    balanceCents: 15_000,
  };
  const input = {
    requestId: "request-1",
    amountCents: 10_000,
    destinationVersion: 3,
  };
  const locked: WithdrawalReservationLockedState = {
    access,
    currentSession: { ...actor },
    context: structuredClone(context),
    existingReservation: null,
    heldCents: 5_000n,
    unresolvedFinancialEventCount: 0,
    balanceEffectsAfterObservationCount: 0,
  };
  const loadContext = vi.fn().mockResolvedValue(context);
  const findByRequest = vi.fn().mockResolvedValue(null);
  const quoteWithdrawal = vi.fn().mockResolvedValue(fee);
  const getBalance = vi.fn().mockResolvedValue(balance);
  const reserveWithdrawal = vi.fn(
    async (
      snapshot: WithdrawalReservationSnapshot,
      authorize: (state: WithdrawalReservationLockedState) => Promise<void>,
      _authorization: WithdrawalReservationCurrentAuthorization,
      _confirmation?: WithdrawalConfirmationReference,
    ): Promise<WithdrawalReservationRecord> => {
      await authorize(locked);
      return { snapshot, intent: snapshot.intent };
    },
  );
  const presentation = {
    siteId: actor.siteId,
    accountId: "account-1",
    accountReference: "acct_1",
    environment: "sandbox" as const,
    bankReference: "bank-1",
    destinationVersion: 3,
    amountCents: 10000,
    currency: "BRL" as const,
    source: "stored" as const,
    verification: "verified" as const,
    provenance: "provider" as const,
    operatorUserId: actor.userId,
    recipientReference: "wallet_1",
    destinationId: "destination-3",
    evidenceId: "evidence-1",
    verificationReference: "verified-1",
    evidenceObservedAt: new Date(now),
    bankObservedAt: new Date(now),
    operatorProfileUpdatedAt: new Date(now),
    maskedDestination: "Bank **** 1234",
    operatorDisplayName: "Stored Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: actor.siteId,
      requestId: input.requestId,
      mode: "sandbox",
      currency: "BRL",
      amountCents: input.amountCents,
      feeCents: fee.feeCents,
      netCents: input.amountCents - fee.feeCents,
      destinationVersion: 3,
      maskedDestination: presentation.maskedDestination,
      operatorDisplayName: presentation.operatorDisplayName,
      policyVersion: fee.policyVersion,
      issuedAt: now.toISOString(),
      expiresAt: fee.expiresAt.toISOString(),
    },
    scope: {
      siteId: actor.siteId,
      accountId: "account-1",
      accountReference: "acct_1",
      environment: "sandbox",
      bankReference: "bank-1",
      destinationVersion: 3,
      amountCents: 10000,
      currency: "BRL",
    },
    operatorUserId: actor.userId,
    recipientReference: "wallet_1",
    presentation,
    feeQuote: {
      feeCents: fee.feeCents,
      policyVersion: fee.policyVersion,
      provenance: fee.provenance,
      observedAt: fee.observedAt.toISOString(),
      expiresAt: fee.expiresAt.toISOString(),
    },
  });
  const consent = {
    snapshot: consentSnapshot,
    previewHash: hashWithdrawalConsentSnapshot(consentSnapshot),
    requestRevision: "1" as const,
    state: "OPEN" as const,
  };
  const confirmation = {
    requestId: input.requestId,
    previewHash: consent.previewHash,
    requestRevision: "1" as const,
  };
  const findConsent = vi.fn().mockResolvedValue(consent);
  const loadPresentation = vi.fn().mockResolvedValue(presentation);
  const options: Exclude<WithdrawalReservationOptions, { mode: "disabled" }> = {
    mode: "sandbox",
    applicationEnvironment: "test",
    maxAuthAgeMs: 300_000,
    freshnessMs: 60_000,
    now: () => new Date(now),
    generateId: (kind) => `${kind}-1`,
    loadContext,
    loadVerifiedPresentation: loadPresentation,
    feeQuotes: { quoteWithdrawal },
    balance: { getBalance },
    repository: { findByRequest, reserveWithdrawal, findConsent },
  };
  return {
    actor,
    access,
    recentAuth,
    input,
    context,
    fee,
    balance,
    locked,
    options,
    loadContext,
    findByRequest,
    quoteWithdrawal,
    getBalance,
    reserveWithdrawal,
    consent,
    confirmation,
    findConsent,
    presentation,
    loadPresentation,
  };
}

function create(values: ReturnType<typeof fixture>) {
  return createWithdrawalReservationService(values.options).createWithdrawal({
    actor: values.actor,
    access: values.access,
    recentAuth: values.recentAuth,
    input: values.input,
    confirmation: values.confirmation,
  });
}

function registerAcceptedConsent(
  values: ReturnType<typeof fixture>,
  requestId = values.input.requestId,
) {
  Object.assign(values.presentation, {
    environment: values.options.mode,
    amountCents: values.input.amountCents,
  });
  const previous = values.consent.snapshot;
  const snapshot = readWithdrawalConsentSnapshot({
    ...previous,
    preview: {
      ...previous.preview,
      requestId,
      mode: values.options.mode,
      amountCents: values.input.amountCents,
      feeCents: values.fee.feeCents,
      netCents: values.input.amountCents - values.fee.feeCents,
      policyVersion: values.fee.policyVersion,
    },
    scope: {
      ...previous.scope,
      environment: values.options.mode,
      amountCents: values.input.amountCents,
    },
    presentation: {
      ...previous.presentation,
      environment: values.options.mode,
      amountCents: values.input.amountCents,
    },
    feeQuote: {
      ...previous.feeQuote,
      feeCents: values.fee.feeCents,
      provenance: values.fee.provenance,
      policyVersion: values.fee.policyVersion,
    },
  });
  const consent = {
    ...values.consent,
    snapshot,
    previewHash: hashWithdrawalConsentSnapshot(snapshot),
  };
  Object.assign(values.confirmation, {
    requestId,
    previewHash: consent.previewHash,
  });
  values.findConsent.mockResolvedValue(consent);
  return consent;
}

function durableFixture() {
  const v = fixture();
  let revision = "0",
    consent: WithdrawalConsentRecord | null = null,
    stored: WithdrawalReservationRecord | null = null;
  const attempt = {
    actor: v.actor,
    access: v.access,
    requestId: v.input.requestId,
  };
  const status = () =>
    withdrawalRequestStatusSchema.parse({
      siteId: v.actor.siteId,
      requestId: v.input.requestId,
      mode: v.options.mode,
      requestRevision: consent?.requestRevision ?? null,
      scopeRevision: revision,
      observedAt: now.toISOString(),
      observationOrder: {
        scopeRevision: revision,
        requestRevision: consent?.requestRevision ?? null,
        recordUpdatedAtMicroseconds:
          consent || stored
            ? databaseTimestampEpochMicroseconds(now).toString()
            : null,
      },
      ...(stored
        ? {
            state: "EXISTING",
            command: v.input,
            withdrawal: stored.intent,
            preview: consent?.snapshot.preview ?? null,
          }
        : consent?.state === "OPEN"
          ? { state: "OPEN", preview: consent.snapshot.preview }
          : consent
            ? {
                state: "SEALED_NOT_CREATED",
                command: v.input,
                sealedAt: now.toISOString(),
              }
            : { state: "UNRESOLVED", command: null }),
    });
  const readRequest = vi.fn(async () => status());
  const issuePreview = vi.fn(
    async (snapshot: WithdrawalConsentSnapshot, expected: string) => {
      if (expected !== revision) throw new Error("private-scope-drift");
      consent = {
        snapshot: readWithdrawalConsentSnapshot(snapshot),
        previewHash: hashWithdrawalConsentSnapshot(snapshot),
        state: "OPEN",
        requestRevision: "1",
      };
      revision = "1";
      return status();
    },
  );
  const recoverWithdrawal = vi.fn(async () => stored);
  const sealUncreatedRequest = vi.fn(async () => {
    if (!stored && consent) {
      consent = {
        ...consent,
        state: "SEALED_NOT_CREATED",
        requestRevision: "2",
      };
      revision = "2";
    }
    return status();
  });
  const readContext = vi.fn(async () =>
    withdrawalRequestContextSchema.parse({
      siteId: v.actor.siteId,
      mode: v.options.mode,
      scopeRevision: revision,
      observedAt: now.toISOString(),
      observationOrder: {
        scopeRevision: revision,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: consent === null,
      reason: consent ? "OPEN_REQUEST" : null,
      openRequest: consent?.state === "OPEN" ? status() : null,
      recoverableRequests: stored ? [status()] : [],
      nextCursor: null,
    }),
  );
  v.findConsent.mockImplementation(async () => consent);
  v.findByRequest.mockImplementation(async () => stored);
  v.reserveWithdrawal.mockImplementation(async (snapshot, authorize) => {
    await authorize(v.locked);
    stored = { snapshot, intent: snapshot.intent };
    if (consent)
      consent = { ...consent, state: "COMMITTED", requestRevision: "2" };
    revision = "2";
    return stored;
  });
  Object.assign(v.options.repository, {
    readRequest,
    issuePreview,
    recoverWithdrawal,
    sealUncreatedRequest,
    readContext,
  });
  return {
    ...v,
    attempt,
    readRequest,
    issuePreview,
    recoverWithdrawal,
    sealUncreatedRequest,
    readContext,
    status,
    setRevision(value: string) {
      revision = value;
    },
    getConsent() {
      return consent;
    },
    service: createWithdrawalReservationService(v.options),
  };
}

describe("durable withdrawal consent service", () => {
  it("rejects stale scope before any new fee or presentation read", async () => {
    const v = durableFixture();
    v.setRevision("4");
    await rejected(
      v.service.createPreview({
        ...v.attempt,
        input: {
          requestId: v.input.requestId,
          amountCents: v.input.amountCents,
          scopeRevision: "0",
        },
      }),
      "REQUEST_CONFLICT",
      409,
    );
    expect(v.quoteWithdrawal).not.toHaveBeenCalled();
    expect(v.loadPresentation).not.toHaveBeenCalled();
    expect(v.issuePreview).not.toHaveBeenCalled();
  });
  it("issues immutable public terms without proof, balance, hold, or generated financial IDs", async () => {
    const v = durableFixture();
    const generateId = vi.spyOn(v.options, "generateId");
    const opened = await v.service.createPreview({
      ...v.attempt,
      input: {
        requestId: v.input.requestId,
        amountCents: v.input.amountCents,
        scopeRevision: "0",
      },
    });
    expect(opened).toMatchObject({
      state: "OPEN",
      scopeRevision: "1",
      preview: v.consent.snapshot.preview,
    });
    expect(v.getBalance).not.toHaveBeenCalled();
    expect(v.reserveWithdrawal).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
    expect(JSON.stringify(opened)).not.toMatch(
      /acct_|wallet_|bank-1|evidence-|verificationReference|previewHash|recentAuth/,
    );
    if (opened.state !== "OPEN") throw new Error("Expected OPEN");
    opened.preview.maskedDestination = "Changed **** 9999";
    expect(v.getConsent()?.snapshot.preview.maskedDestination).toBe(
      "Bank **** 1234",
    );
  });
  it("retries the original OPEN before scope, current readiness, or price checks", async () => {
    const v = durableFixture();
    const input = {
      requestId: v.input.requestId,
      amountCents: v.input.amountCents,
      scopeRevision: "0",
    };
    const opened = await v.service.createPreview({ ...v.attempt, input });
    v.quoteWithdrawal.mockClear();
    v.loadPresentation.mockClear();
    v.loadContext.mockRejectedValue(new Error("sensitive-secret"));
    expect(await v.service.createPreview({ ...v.attempt, input })).toEqual(
      opened,
    );
    expect(v.quoteWithdrawal).not.toHaveBeenCalled();
    expect(v.loadPresentation).not.toHaveBeenCalled();
    await rejected(
      v.service.createPreview({
        ...v.attempt,
        input: { ...input, amountCents: input.amountCents + 1 },
      }),
      "REQUEST_CONFLICT",
      409,
    );
  });
  it("lets repository CAS reject a scope change during fee I/O without creating a hold", async () => {
    const v = durableFixture();
    v.quoteWithdrawal.mockImplementation(async () => {
      v.setRevision("2");
      return v.fee;
    });
    await rejected(
      v.service.createPreview({
        ...v.attempt,
        input: {
          requestId: v.input.requestId,
          amountCents: v.input.amountCents,
          scopeRevision: "0",
        },
      }),
      "WITHDRAWAL_UNAVAILABLE",
      503,
    );
    expect(v.issuePreview).toHaveBeenCalled();
    expect(v.reserveWithdrawal).not.toHaveBeenCalled();
    expect(v.getConsent()).toBeNull();
  });
  it("confirms an issued preview, then recovers the original intent without financial reads", async () => {
    const v = durableFixture();
    await v.service.createPreview({
      ...v.attempt,
      input: {
        requestId: v.input.requestId,
        amountCents: v.input.amountCents,
        scopeRevision: "0",
      },
    });
    const protectedAttempt = { ...v.attempt, recentAuth: v.recentAuth };
    const result = await v.service.confirmNew(protectedAttempt);
    expect(result).toMatchObject({
      amountCents: v.input.amountCents,
      feeCents: v.fee.feeCents,
      netCents: v.input.amountCents - v.fee.feeCents,
    });
    expect(v.reserveWithdrawal.mock.calls[0]?.[3]).toEqual({
      requestId: v.input.requestId,
      previewHash: v.getConsent()?.previewHash,
      requestRevision: "1",
    });
    v.quoteWithdrawal.mockClear();
    v.getBalance.mockClear();
    v.loadPresentation.mockClear();
    v.loadContext.mockRejectedValue(new Error("sensitive-secret"));
    expect(await v.service.confirmNew(protectedAttempt)).toEqual(result);
    expect(await v.service.recoverExisting(protectedAttempt)).toEqual(result);
    expect(v.quoteWithdrawal).not.toHaveBeenCalled();
    expect(v.getBalance).not.toHaveBeenCalled();
    expect(v.loadPresentation).not.toHaveBeenCalled();
  });
  it("seals without hold/release and preserves that state on retry", async () => {
    const v = durableFixture();
    await v.service.createPreview({
      ...v.attempt,
      input: {
        requestId: v.input.requestId,
        amountCents: v.input.amountCents,
        scopeRevision: "0",
      },
    });
    const protectedAttempt = { ...v.attempt, recentAuth: v.recentAuth };
    const sealed = await v.service.sealUncreatedRequest(protectedAttempt);
    expect(sealed).toMatchObject({
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      scopeRevision: "2",
      command: v.input,
    });
    expect(await v.service.sealUncreatedRequest(protectedAttempt)).toEqual(
      sealed,
    );
    await rejected(
      v.service.confirmNew(protectedAttempt),
      "REQUEST_CONFLICT",
      409,
    );
    expect(v.reserveWithdrawal).not.toHaveBeenCalled();
    expect(v.getBalance).not.toHaveBeenCalled();
  });
  it("does not turn missing recovery into creation", async () => {
    const v = durableFixture();
    await rejected(
      v.service.recoverExisting({ ...v.attempt, recentAuth: v.recentAuth }),
      "WITHDRAWAL_UNAVAILABLE",
      503,
    );
    expect(v.reserveWithdrawal).not.toHaveBeenCalled();
    expect(v.quoteWithdrawal).not.toHaveBeenCalled();
    expect(v.getBalance).not.toHaveBeenCalled();
  });
  it.each(["fee", "policy", "mask", "profile"])(
    "rejects changed accepted %s terms before any hold",
    async (field) => {
      const v = durableFixture();
      await v.service.createPreview({
        ...v.attempt,
        input: {
          requestId: v.input.requestId,
          amountCents: v.input.amountCents,
          scopeRevision: "0",
        },
      });
      if (field === "fee") v.fee.feeCents += 1;
      else if (field === "policy") v.fee.policyVersion = "provider-fee-v2";
      else if (field === "mask")
        v.presentation.maskedDestination = "Bank **** 9999";
      else v.presentation.operatorDisplayName = "New Operator";
      await rejected(
        v.service.confirmNew({ ...v.attempt, recentAuth: v.recentAuth }),
        "REQUEST_CONFLICT",
        409,
      );
      expect(v.reserveWithdrawal).not.toHaveBeenCalled();
      expect(v.getConsent()?.state).toBe("OPEN");
    },
  );
  it("rejects expired OPEN without extending its original preview", async () => {
    const v = durableFixture();
    await v.service.createPreview({
      ...v.attempt,
      input: {
        requestId: v.input.requestId,
        amountCents: v.input.amountCents,
        scopeRevision: "0",
      },
    });
    v.options.now = () => new Date(now.getTime() + 60_000);
    const service = createWithdrawalReservationService(v.options);
    await rejected(
      service.confirmNew({ ...v.attempt, recentAuth: v.recentAuth }),
      "REQUEST_CONFLICT",
      409,
    );
    expect((await service.readRequest(v.attempt)).state).toBe("OPEN");
    expect(v.reserveWithdrawal).not.toHaveBeenCalled();
    expect(v.getConsent()?.snapshot.preview.expiresAt).toBe(
      v.fee.expiresAt.toISOString(),
    );
  });
  it.each(["confirmNew", "recoverExisting", "sealUncreatedRequest"] as const)(
    "requires real recent proof for %s before any repository mutation",
    async (method) => {
      const v = durableFixture();
      await rejected(
        v.service[method]({ ...v.attempt, recentAuth: null }),
        "RECENT_AUTH_REQUIRED",
        403,
      );
      expect(v.reserveWithdrawal).not.toHaveBeenCalled();
      expect(v.recoverWithdrawal).not.toHaveBeenCalled();
      expect(v.sealUncreatedRequest).not.toHaveBeenCalled();
    },
  );
  it("preserves exact three-field financial hash separately from presentation consent", async () => {
    const v = durableFixture();
    await v.service.createPreview({
      ...v.attempt,
      input: {
        requestId: v.input.requestId,
        amountCents: v.input.amountCents,
        scopeRevision: "0",
      },
    });
    await v.service.confirmNew({ ...v.attempt, recentAuth: v.recentAuth });
    const snapshot = v.reserveWithdrawal.mock.calls[0]?.[0];
    expect(snapshot?.requestHash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "withdrawal.reservation.v1",
            v.actor.siteId,
            v.input.requestId,
            v.actor.userId,
            "sandbox",
            v.input.amountCents,
            v.input.destinationVersion,
          ]),
        )
        .digest("hex"),
    );
    expect(snapshot?.requestHash).not.toBe(v.getConsent()?.previewHash);
  });
  it("sanitizes malformed private consent parser failures", () => {
    expect(() =>
      readWithdrawalConsentSnapshot({
        ...fixture().consent.snapshot,
        preview: { siteId: "private-secret" },
      }),
    ).toThrowError(expect.objectContaining({ code: "WITHDRAWAL_UNAVAILABLE" }));
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing test fixture");
  return value;
}

async function rejected(
  action: Promise<unknown>,
  code: string,
  status: number,
) {
  const error = await action.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code, status });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toMatch(
    /sensitive-secret|password-hash|payer@example/,
  );
}

async function replayFixture(
  state: WithdrawalReservationRecord["intent"]["state"] = "UNKNOWN",
) {
  const values = fixture();
  const intent = await create(values);
  const snapshot = required(values.reserveWithdrawal.mock.calls[0]?.[0]);
  const stored: WithdrawalReservationRecord = {
    snapshot,
    intent: { ...intent, state },
  };
  values.findByRequest.mockResolvedValue(stored);
  values.locked.existingReservation = stored;
  values.locked.context = {
    ...values.context,
    verification: "unverified",
    accountId: null,
    bankReference: null,
    recipientBinding: null,
    readiness: null,
  };
  values.loadContext.mockResolvedValue(values.locked.context);
  values.locked.heldCents = null;
  values.locked.unresolvedFinancialEventCount = null;
  values.locked.balanceEffectsAfterObservationCount = null;
  values.reserveWithdrawal.mockImplementation(async (_snapshot, authorize) => {
    await authorize(values.locked);
    return stored;
  });
  values.quoteWithdrawal.mockClear();
  values.getBalance.mockClear();
  values.reserveWithdrawal.mockClear();
  return { ...values, stored };
}

describe("withdrawal reservations", () => {
  it("denies an unconsented first hold before provider reads", async () => {
    const values = fixture();
    await rejected(
      createWithdrawalReservationService(values.options).createWithdrawal({
        actor: values.actor,
        access: values.access,
        recentAuth: values.recentAuth,
        input: values.input,
      }),
      "REQUEST_CONFLICT",
      409,
    );
    expect(values.quoteWithdrawal).not.toHaveBeenCalled();
    expect(values.getBalance).not.toHaveBeenCalled();
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });
  it("rejects a balance invalidated by another withdrawal completing before the account lock", async () => {
    const values = fixture();
    let current = now.getTime();
    values.options.now = () => new Date(current);
    values.getBalance.mockImplementation(async () => {
      const stale = { ...values.balance };
      current += 1;
      values.locked.heldCents = 0n;
      values.locked.unresolvedFinancialEventCount = 0;
      Object.assign(values.locked, { balanceEffectsAfterObservationCount: 1 });
      return stale;
    });
    await rejected(create(values), "PROVIDER_BALANCE_UNAVAILABLE", 409);
  });

  it.each([undefined, null, -1, 0.5, Number.NaN])(
    "requires an authoritative balance effect fence: %s",
    async (count) => {
      const values = fixture();
      Object.assign(values.locked, {
        balanceEffectsAfterObservationCount: count,
      });
      await rejected(create(values), "WITHDRAWAL_UNAVAILABLE", 503);
    },
  );

  it("reserves total including provider fee with complete authorization despite operational flag false", async () => {
    const values = fixture();
    const result = await create(values);
    expect(result).toEqual({
      id: "withdrawal-1",
      siteId: "site-1",
      amountCents: 10_000,
      feeCents: 500,
      netCents: 9_500,
      currency: "BRL",
      destinationVersion: 3,
      state: "REQUESTED",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      mode: "sandbox",
    });
    expect(values.reserveWithdrawal).toHaveBeenCalledOnce();
    const snapshot = values.reserveWithdrawal.mock.calls[0]?.[0];
    expect(snapshot).toMatchObject({
      accountId: "account-1",
      operatorUserId: values.actor.userId,
      bankReference: "bank-1",
      operationId: "operation-1",
      requestId: "request-1",
      feeQuote: { feeCents: 500 },
      balance: { balanceCents: 15_000 },
    });
    expect(snapshot?.authenticationAuditHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /account|bank|operator|policy|hash|session/i,
    );
    expect(readWithdrawalReservationSnapshot(snapshot)).toEqual(snapshot);
    expect(
      readWithdrawalReservationRecord({ snapshot, intent: result }).intent,
    ).toEqual(result);
  });
  it("preserves the exact three-field business identity and original stored hash", async () => {
    const values = fixture();
    const result = await create(values);
    const snapshot = required(values.reserveWithdrawal.mock.calls[0]?.[0]);
    expect(snapshot.requestHash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "withdrawal.reservation.v1",
            values.actor.siteId,
            values.input.requestId,
            values.actor.userId,
            "sandbox",
            values.input.amountCents,
            values.input.destinationVersion,
          ]),
          "utf8",
        )
        .digest("hex"),
    );
    expect(JSON.stringify({ snapshot, result })).not.toMatch(
      /reauthenticationToken|fr1\./,
    );
  });
  it("rejects the raw transport proof before any repository or provider read", async () => {
    const values = fixture();
    const token = `fr1.${"s".repeat(80)}.${"p".repeat(43)}`;
    const error = await createWithdrawalReservationService(values.options)
      .createWithdrawal({
        actor: values.actor,
        access: values.access,
        recentAuth: values.recentAuth,
        input: { ...values.input, reauthenticationToken: token },
      })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 400, code: "WITHDRAWAL_INVALID" });
    expect(error.message).not.toContain(token);
    expect(values.findByRequest).not.toHaveBeenCalled();
    expect(values.loadContext).not.toHaveBeenCalled();
    expect(values.quoteWithdrawal).not.toHaveBeenCalled();
    expect(values.getBalance).not.toHaveBeenCalled();
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });

  it("rejects a fee consuming the entire amount before any reservation", async () => {
    const values = fixture();
    values.fee.feeCents = values.input.amountCents;
    await expect(create(values)).rejects.toMatchObject({
      status: 409,
      code: "FEE_QUOTE_UNAVAILABLE",
    });
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });

  it("captures server context before later awaits can change its account or recipient", async () => {
    const values = fixture();
    values.quoteWithdrawal.mockImplementation(async () => {
      if (values.context.recipientBinding)
        values.context.recipientBinding.recipientReference = "mutated-wallet";
      values.context.bankReference = "mutated-bank";
      return values.fee;
    });
    await expect(create(values)).resolves.toMatchObject({ state: "REQUESTED" });
    expect(values.reserveWithdrawal.mock.calls[0]?.[0]).toMatchObject({
      bankReference: "bank-1",
      recipientReference: "wallet_1",
    });
  });

  it("does not claim acknowledged success when provider balance expires during commit", async () => {
    const values = fixture();
    let current = now.getTime();
    values.options.now = () => new Date(current);
    values.reserveWithdrawal.mockImplementation(async (snapshot, authorize) => {
      await authorize(values.locked);
      current += 60_001;
      return { snapshot, intent: snapshot.intent };
    });
    await expect(create(values)).rejects.toMatchObject({
      status: 503,
      code: "WITHDRAWAL_UNAVAILABLE",
    });
  });

  it("has a disabled mode requiring no ports and making no call", async () => {
    const service = createWithdrawalReservationService({ mode: "disabled" });
    await rejected(
      service.createWithdrawal({
        actor: null,
        access: null,
        recentAuth: null,
        input: null,
      }),
      "PROVIDER_MODE_UNAVAILABLE",
      409,
    );
  });

  it("sanitizes a malformed factory configuration", () => {
    expect(() =>
      createWithdrawalReservationService(
        null as unknown as WithdrawalReservationOptions,
      ),
    ).toThrowError(
      expect.objectContaining({ status: 503, code: "WITHDRAWAL_UNAVAILABLE" }),
    );
  });

  it("does not leak a typed dependency error's raw title, message, properties or cause", async () => {
    const values = fixture();
    const raw = new FinancialAuthorizationError(
      403,
      "MEMBERSHIP_DENIED",
      "sensitive-secret payer@example",
    );
    Object.assign(raw, {
      cause: new Error("password-hash"),
      token: "sensitive-secret",
    });
    values.loadContext.mockRejectedValue(raw);
    await rejected(create(values), "MEMBERSHIP_DENIED", 403);
  });

  it.each([0, -1, 300_001, Number.NaN, 1.5])(
    "rejects invalid bounded options %s",
    (value) => {
      const values = fixture();
      for (const key of ["freshnessMs", "maxAuthAgeMs"] as const) {
        expect(() =>
          createWithdrawalReservationService({
            ...values.options,
            [key]: value,
          }),
        ).toThrowError(
          expect.objectContaining({
            code: "WITHDRAWAL_UNAVAILABLE",
            status: 503,
          }),
        );
      }
    },
  );

  it("rejects live mode outside production before ports", () => {
    const values = fixture();
    expect(() =>
      createWithdrawalReservationService({ ...values.options, mode: "live" }),
    ).toThrowError(
      expect.objectContaining({ code: "PROVIDER_MODE_UNAVAILABLE" }),
    );
    expect(values.loadContext).not.toHaveBeenCalled();
  });

  it("rejects a demo site's live mode before fee or balance fetch", async () => {
    const values = fixture();
    values.options.mode = "live";
    values.options.applicationEnvironment = "production";
    values.context.mode = "live";
    registerAcceptedConsent(values);
    await rejected(create(values), "PROVIDER_MODE_UNAVAILABLE", 409);
    expect(values.quoteWithdrawal).not.toHaveBeenCalled();
    expect(values.getBalance).not.toHaveBeenCalled();
  });

  it("supports actual verified live facts on a production non-demo site", async () => {
    const values = fixture();
    values.options.mode = "live";
    values.options.applicationEnvironment = "production";
    for (const context of [values.context, required(values.locked.context)]) {
      context.mode = "live";
      context.isDemo = false;
      required(context.recipientBinding).environment = "live";
      required(context.readiness).mode = "live";
    }
    values.fee.environment = "live";
    values.balance.environment = "live";
    registerAcceptedConsent(values);
    await expect(create(values)).resolves.toMatchObject({
      mode: "live",
      state: "REQUESTED",
    });
  });

  it.each([
    {
      field: "role",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.access.membershipRole = "SITE_ASSISTANT";
      },
    },
    {
      field: "missing membership",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.access.membershipId = null;
      },
    },
    {
      field: "crosssite",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.access.siteId = "site-2";
      },
    },
    {
      field: "crossuser",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.access.userId = "user-2";
      },
    },
    {
      field: "read denied",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.access.capabilities.readFinance = false;
      },
    },
    {
      field: "OWNER",
      mutate: (v: ReturnType<typeof fixture>) => {
        Object.assign(v.access, { membershipRole: "OWNER" });
      },
    },
    {
      field: "browser role",
      mutate: (v: ReturnType<typeof fixture>) => {
        Object.assign(v.access, { role: "SITE_ADMIN" });
      },
    },
  ])("denies $field before stored financial reads", async ({ mutate }) => {
    const values = fixture();
    mutate(values);
    values.access.capabilities.requestWithdrawal = true;
    await rejected(create(values), "MEMBERSHIP_DENIED", 403);
    expect(values.loadContext).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { requestId: "request-1", amountCents: 0, destinationVersion: 3 },
    { requestId: "request-1", amountCents: 1.5, destinationVersion: 3 },
    {
      requestId: "request-1",
      amountCents: 2_147_483_648,
      destinationVersion: 3,
    },
    { requestId: "request-1", amountCents: 1, destinationVersion: 0 },
    {
      requestId: "request-1",
      amountCents: 1,
      destinationVersion: 3,
      accountId: "account-2",
    },
    {
      requestId: "request-1",
      amountCents: 1,
      destinationVersion: 3,
      reauthToken: "sensitive-secret",
    },
    {
      requestId: "request-1",
      amountCents: 1,
      destinationVersion: 3,
      approved: true,
    },
  ])("rejects an invalid or spoofed input %#", async (input) => {
    const values = fixture();
    await rejected(
      createWithdrawalReservationService(values.options).createWithdrawal({
        ...values,
        input,
      }),
      "WITHDRAWAL_INVALID",
      400,
    );
    expect(values.loadContext).not.toHaveBeenCalled();
  });

  it.each([
    { field: "missing", patch: null },
    { field: "other session", patch: { sessionId: "other-session" } },
    { field: "other user", patch: { userId: "other-user" } },
    { field: "other site", patch: { siteId: "site-2" } },
    { field: "unverified", patch: { verification: "unverified" } },
    { field: "browser", patch: { provenance: "browser" } },
    { field: "expired", patch: { expiresAt: new Date(now) } },
    {
      field: "future",
      patch: { authenticatedAt: new Date(now.getTime() + 1) },
    },
    { field: "invalid date", patch: { authenticatedAt: new Date("invalid") } },
    {
      field: "unbounded expiry",
      patch: { expiresAt: new Date(now.getTime() + 300_001) },
    },
    {
      field: "old",
      patch: { authenticatedAt: new Date(now.getTime() - 300_001) },
    },
  ])(
    "denies $field authentication before loading financial context",
    async ({ patch }) => {
      const values = fixture();
      const proof = patch === null ? null : { ...values.recentAuth, ...patch };
      await rejected(
        createWithdrawalReservationService(values.options).createWithdrawal({
          ...values,
          recentAuth: proof as RecentFinancialAuthenticationEvidence | null,
        }),
        "RECENT_AUTH_REQUIRED",
        403,
      );
      expect(values.loadContext).not.toHaveBeenCalled();
    },
  );

  it("accepts backend MFA proof and one cent net without float allocation", async () => {
    const values = fixture();
    values.recentAuth.proofKind = "MFA_REAUTHENTICATION";
    values.input.amountCents = 501;
    values.fee.amountCents = 501;
    registerAcceptedConsent(values);
    await expect(create(values)).resolves.toMatchObject({
      amountCents: 501,
      feeCents: 500,
      netCents: 1,
    });
  });

  it("reserves the maximum C1 integer exactly", async () => {
    const values = fixture();
    values.input.amountCents = 2_147_483_647;
    values.fee.amountCents = values.input.amountCents;
    values.fee.feeCents = 2_147_483_646;
    values.balance.balanceCents = values.input.amountCents;
    values.locked.heldCents = 0n;
    registerAcceptedConsent(values);
    await expect(create(values)).resolves.toMatchObject({
      amountCents: 2_147_483_647,
      feeCents: 2_147_483_646,
      netCents: 1,
    });
  });

  it.each([
    { field: "account", patch: { accountId: "account-2" } },
    { field: "PSP account", patch: { accountReference: "acct_2" } },
    { field: "site", patch: { siteId: "site-2" } },
    { field: "environment", patch: { environment: "live" } },
    { field: "bank", patch: { bankReference: "bank-2" } },
    { field: "version", patch: { destinationVersion: 2 } },
    { field: "amount", patch: { amountCents: 9_000 } },
    { field: "currency", patch: { currency: "USD" } },
    { field: "verification", patch: { verification: "unverified" } },
    { field: "unknown fee", patch: { feeCents: null } },
    { field: "negative fee", patch: { feeCents: -1 } },
    { field: "fraction", patch: { feeCents: 0.1 } },
    { field: "overflow", patch: { feeCents: 2_147_483_648 } },
    {
      field: "future observation",
      patch: { observedAt: new Date(now.getTime() + 1) },
    },
    { field: "expired quote", patch: { expiresAt: new Date(now) } },
    {
      field: "stale quote",
      patch: { observedAt: new Date(now.getTime() - 60_001) },
    },
    {
      field: "unbounded quote",
      patch: { expiresAt: new Date(now.getTime() + 60_001) },
    },
    { field: "missing policy", patch: { policyVersion: null } },
  ])("rejects $field fee evidence", async ({ patch }) => {
    const values = fixture();
    Object.assign(values.fee, patch);
    await rejected(create(values), "FEE_QUOTE_UNAVAILABLE", 409);
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });

  it("allows an explicitly verified simulation fee only for a sandbox demo", async () => {
    const values = fixture();
    values.fee.provenance = "simulation";
    registerAcceptedConsent(values);
    await expect(create(values)).resolves.toMatchObject({
      state: "REQUESTED",
      mode: "sandbox",
    });
  });

  it.each(["real-site", "production"])(
    "rejects simulated fee for %s",
    async (kind) => {
      const values = fixture();
      values.fee.provenance = "simulation";
      if (kind === "real-site") values.context.isDemo = false;
      else values.options.applicationEnvironment = "production";
      await rejected(create(values), "FEE_QUOTE_UNAVAILABLE", 409);
    },
  );

  it.each([
    { field: "missing", patch: null },
    { field: "source", patch: { source: "browser" } },
    { field: "provider", patch: { provider: "OTHER" } },
    { field: "site", patch: { siteId: "site-2" } },
    { field: "local account", patch: { accountBindingId: "account-2" } },
    { field: "PSP account", patch: { accountReference: "acct_2" } },
    { field: "environment", patch: { environment: "live" } },
    { field: "currency", patch: { currency: "USD" } },
    { field: "unknown balance", patch: { balanceCents: null } },
    { field: "negative balance", patch: { balanceCents: -1 } },
    { field: "fraction", patch: { balanceCents: 0.1 } },
    { field: "overflow", patch: { balanceCents: 2_147_483_648 } },
    { field: "future", patch: { observedAt: new Date(now.getTime() + 1) } },
    { field: "stale", patch: { observedAt: new Date(now.getTime() - 60_001) } },
    {
      field: "invalid timestamp",
      patch: { observedAt: "2026-10-12T12:00:00.000Z" },
    },
  ])(
    "rejects $field balance without inventing available funds",
    async ({ patch }) => {
      const values = fixture();
      values.getBalance.mockResolvedValue(
        patch === null ? null : { ...values.balance, ...patch },
      );
      await rejected(create(values), "PROVIDER_BALANCE_UNAVAILABLE", 409);
      expect(values.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it.each([0, 9_999])(
    "denies an actual balance of %s without a reservation",
    async (balanceCents) => {
      const values = fixture();
      values.balance.balanceCents = balanceCents;
      await rejected(create(values), "INSUFFICIENT_FUNDS", 409);
      expect(values.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      field: "revoked membership",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.access = { ...v.access, membershipId: null };
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      field: "other session",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.currentSession = { ...v.actor, sessionId: "other-session" };
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      field: "missing session",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.currentSession = null;
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      field: "other nominee",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(required(v.locked.context).recipientBinding).operatorUserId =
          "other-user";
      },
      code: "RECIPIENT_REQUIRED",
      status: 403,
    },
    {
      field: "unverified designation",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(v.locked.context).verification = "unverified";
      },
      code: "RECIPIENT_REQUIRED",
      status: 403,
    },
    {
      field: "changed bank",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(v.locked.context).bankReference = "bank-2";
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      field: "changed version",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(
          required(v.locked.context).recipientBinding,
        ).destinationVersion = 4;
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      field: "changed account",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(v.locked.context).accountId = "account-2";
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      field: "changed recipient",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(
          required(v.locked.context).recipientBinding,
        ).recipientReference = "wallet_2";
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      field: "stale readiness",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(required(v.locked.context).readiness).observedAt = new Date(
          now.getTime() - 60_001,
        ).toISOString();
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      field: "pending readiness",
      mutate: (v: ReturnType<typeof fixture>) => {
        required(v.locked.context).readiness = {
          ...required(v.context.readiness),
          state: "BANK_VALIDATION_PENDING",
          reason: "BANK_VERIFICATION_REQUIRED",
          catalogEligible: false,
        };
      },
      code: "RECEIVING_NOT_READY",
      status: 409,
    },
    {
      field: "holds",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.heldCents = 5_001n;
      },
      code: "INSUFFICIENT_FUNDS",
      status: 409,
    },
    {
      field: "large holds",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.heldCents = 9_007_199_254_740_993n;
      },
      code: "INSUFFICIENT_FUNDS",
      status: 409,
    },
    {
      field: "unresolved event",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.unresolvedFinancialEventCount = 1;
      },
      code: "FINANCIAL_EVENTS_UNRESOLVED",
      status: 409,
    },
    {
      field: "missing unresolved count",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.unresolvedFinancialEventCount = null;
      },
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    },
    {
      field: "fractional unresolved count",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.unresolvedFinancialEventCount = 0.1;
      },
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    },
    {
      field: "negative unresolved count",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.unresolvedFinancialEventCount = -1;
      },
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    },
    {
      field: "missing holds",
      mutate: (v: ReturnType<typeof fixture>) => {
        v.locked.heldCents = null;
      },
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    },
  ])(
    "rechecks $field under the reservation lock",
    async ({ mutate, code, status }) => {
      const values = fixture();
      mutate(values);
      await rejected(create(values), code, status);
      expect(values.quoteWithdrawal).toHaveBeenCalledOnce();
      expect(values.reserveWithdrawal).toHaveBeenCalledOnce();
    },
  );

  it("requires freshness again after provider I/O", async () => {
    const values = fixture();
    let current = now.getTime();
    values.options.now = () => new Date(current);
    values.getBalance.mockImplementation(async () => {
      current += 60_001;
      return values.balance;
    });
    await rejected(create(values), "FEE_QUOTE_UNAVAILABLE", 409);
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });

  it("requires recent proof again after await and inside the lock", async () => {
    for (const phase of ["load", "lock"]) {
      const values = fixture();
      let current = now.getTime();
      values.options.now = () => new Date(current);
      if (phase === "load")
        values.loadContext.mockImplementation(async () => {
          current += 270_000;
          return values.context;
        });
      else
        values.reserveWithdrawal.mockImplementation(
          async (snapshot, authorize) => {
            current += 270_000;
            await authorize(values.locked);
            return { snapshot, intent: snapshot.intent };
          },
        );
      await rejected(create(values), "RECENT_AUTH_REQUIRED", 403);
    }
  });

  it("uses authoritative HELD totals to prevent concurrent overspending in the injected atomic port", async () => {
    const values = fixture();
    let held = 0n;
    let commits = 0;
    let serial = Promise.resolve();
    values.options.generateId = (kind) => `${kind}-${++commits}`;
    values.reserveWithdrawal.mockImplementation((snapshot, authorize) => {
      const result = serial.then(async () => {
        await authorize({ ...values.locked, heldCents: held });
        held += BigInt(snapshot.intent.amountCents);
        return { snapshot, intent: snapshot.intent };
      });
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    const service = createWithdrawalReservationService(values.options);
    const consents = new Map(
      ["request-a", "request-b"].map((requestId) => [
        requestId,
        registerAcceptedConsent(values, requestId),
      ]),
    );
    values.findConsent.mockImplementation(async ({ requestId }) =>
      consents.get(requestId),
    );
    const results = await Promise.allSettled(
      ["request-a", "request-b"].map((requestId) =>
        service.createWithdrawal({
          ...values,
          input: { ...values.input, requestId },
          confirmation: {
            requestId,
            previewHash: required(consents.get(requestId)).previewHash,
            requestRevision: "1",
          },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "INSUFFICIENT_FUNDS" }),
      }),
    ]);
    expect(held).toBe(10_000n);
  });

  it.each([
    "REQUESTED",
    "AWAITING_AUTHORIZATION",
    "PROCESSING",
    "UNKNOWN",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ] as const)(
    "replays the original %s record with changed or deactivated destination and no new provider call",
    async (state) => {
      const values = await replayFixture(state);
      values.actor.sessionId = "renewed-session";
      values.recentAuth.sessionId = values.actor.sessionId;
      values.locked.currentSession = { ...values.actor };
      const result = await create(values);
      expect(result).toEqual(values.stored.intent);
      expect(values.quoteWithdrawal).not.toHaveBeenCalled();
      expect(values.getBalance).not.toHaveBeenCalled();
      const [snapshot, , authorization] = required(
        values.reserveWithdrawal.mock.calls[0],
      );
      expect(snapshot).toEqual(values.stored.snapshot);
      expect(authorization.actor.sessionId).toBe("renewed-session");
      expect(snapshot.authenticationAuditHash).toBe(
        values.stored.snapshot.authenticationAuditHash,
      );
    },
  );

  it("cannot replay another operator's request", async () => {
    const values = await replayFixture();
    values.actor.userId = "other-user";
    values.access.userId = values.actor.userId;
    values.recentAuth.userId = values.actor.userId;
    await rejected(create(values), "REQUEST_CONFLICT", 409);
    expect(values.reserveWithdrawal).not.toHaveBeenCalled();
  });
  it("reauthorizes a plain command replay while preserving the original UNKNOWN snapshot and hash", async () => {
    const values = await replayFixture("UNKNOWN");
    values.actor.sessionId = "fresh-session";
    values.recentAuth.sessionId = "fresh-session";
    values.locked.currentSession = { ...values.actor };
    const result = await create(values);
    const snapshot = required(values.reserveWithdrawal.mock.calls[0]?.[0]);
    expect(result).toEqual(values.stored.intent);
    expect(snapshot).toEqual(values.stored.snapshot);
    expect(snapshot.requestHash).toBe(values.stored.snapshot.requestHash);
    expect(snapshot.authenticationAuditHash).toBe(
      values.stored.snapshot.authenticationAuditHash,
    );
    expect(values.quoteWithdrawal).not.toHaveBeenCalled();
    expect(values.getBalance).not.toHaveBeenCalled();
    expect(JSON.stringify({ snapshot, result })).not.toMatch(
      /reauthenticationToken|fr1\./,
    );
  });

  it.each(["amount", "destination"])(
    "rejects a replay collision on %s",
    async (field) => {
      const values = await replayFixture();
      if (field === "amount") values.input.amountCents++;
      else values.input.destinationVersion++;
      await rejected(create(values), "REQUEST_CONFLICT", 409);
      expect(values.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it("still rejects revoked current membership for an exact historical replay", async () => {
    const values = await replayFixture();
    values.locked.access = { ...values.access, membershipId: null };
    await rejected(create(values), "MEMBERSHIP_DENIED", 403);
  });

  it("resolves a same-request race to the stored original rather than reserving candidate again", async () => {
    const values = await replayFixture();
    values.findByRequest.mockResolvedValue(null);
    values.loadContext.mockResolvedValue(values.context);
    values.locked.context = values.context;
    values.options.generateId = (kind) => `${kind}-racing-candidate`;
    const result = await create(values);
    expect(result).toEqual(values.stored.intent);
    expect(result.id).toBe("withdrawal-1");
    expect(values.reserveWithdrawal.mock.calls[0]?.[0].intent.id).toBe(
      "withdrawal-racing-candidate",
    );
  });

  it("does not accept a disappeared stored reservation as a new hold", async () => {
    const values = await replayFixture();
    values.locked.existingReservation = null;
    await rejected(create(values), "WITHDRAWAL_UNAVAILABLE", 503);
  });

  it("retains a committed UNKNOWN record after lost acknowledgement and replays without another provider read", async () => {
    const values = fixture();
    let stored: WithdrawalReservationRecord | null = null;
    values.reserveWithdrawal.mockImplementation(async (snapshot, authorize) => {
      await authorize(values.locked);
      stored = { snapshot, intent: { ...snapshot.intent, state: "UNKNOWN" } };
      throw new Error("sensitive-secret password-hash payer@example");
    });
    await rejected(create(values), "WITHDRAWAL_UNAVAILABLE", 503);
    const committed = readWithdrawalReservationRecord(stored);
    expect(committed.intent.state).toBe("UNKNOWN");
    values.findByRequest.mockResolvedValue(committed);
    values.locked.existingReservation = committed;
    values.reserveWithdrawal.mockImplementation(
      async (_snapshot, authorize) => {
        await authorize(values.locked);
        return committed;
      },
    );
    values.quoteWithdrawal.mockClear();
    values.getBalance.mockClear();
    await expect(create(values)).resolves.toMatchObject({
      id: "withdrawal-1",
      state: "UNKNOWN",
    });
    expect(values.quoteWithdrawal).not.toHaveBeenCalled();
    expect(values.getBalance).not.toHaveBeenCalled();
  });

  it.each(["load", "find", "fee", "balance", "reserve"])(
    "sanitizes a %s port failure without exposing provider or payer details",
    async (phase) => {
      const values = fixture();
      const failure = new Error("sensitive-secret password-hash payer@example");
      const port = {
        load: values.loadContext,
        find: values.findByRequest,
        fee: values.quoteWithdrawal,
        balance: values.getBalance,
        reserve: values.reserveWithdrawal,
      }[phase];
      required(port).mockRejectedValue(failure);
      await rejected(create(values), "WITHDRAWAL_UNAVAILABLE", 503);
    },
  );

  it("rejects a repository returning success without executing locked authorization", async () => {
    const values = fixture();
    values.reserveWithdrawal.mockImplementation(async (snapshot) => ({
      snapshot,
      intent: snapshot.intent,
    }));
    await rejected(create(values), "WITHDRAWAL_UNAVAILABLE", 503);
  });

  it("does not store private provider fields, raw proof or browser claims", async () => {
    const values = fixture();
    Object.assign(values.fee, {
      accessToken: "sensitive-secret",
      payer: "payer@example",
    });
    Object.assign(values.balance, {
      raw: { password: "sensitive-secret" },
      bank: "raw-bank",
    });
    await create(values);
    const snapshot = required(values.reserveWithdrawal.mock.calls[0]?.[0]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /sensitive-secret|payer@example|session:1|PASSWORD_REAUTHENTICATION|raw-bank/,
    );
    const expectedAudit = createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.authentication.v1",
          values.actor.userId,
          values.actor.siteId,
          values.actor.sessionId,
          values.recentAuth.proofKind,
          values.recentAuth.authenticatedAt?.toISOString(),
          values.recentAuth.expiresAt?.toISOString(),
        ]),
      )
      .digest("hex");
    expect(snapshot.authenticationAuditHash).toBe(expectedAudit);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.intent)).toBe(true);
    expect(Object.isFrozen(snapshot.feeQuote)).toBe(true);
  });

  it("rejects corrupt historical snapshots and changed immutable order fields", async () => {
    const values = await replayFixture();
    const snapshot = structuredClone(values.stored.snapshot);
    for (const corrupt of [
      { ...snapshot, requestHash: "0".repeat(64) },
      { ...snapshot, authenticationAuditHash: "not-a-hash" },
      { ...snapshot, accessToken: "sensitive-secret" },
      { ...snapshot, intent: { ...snapshot.intent, state: "UNKNOWN" } },
      { ...snapshot, feeQuote: { ...snapshot.feeQuote, feeCents: 0 } },
      { ...snapshot, balance: { ...snapshot.balance, balanceCents: 0 } },
      {
        ...snapshot,
        feeQuote: {
          ...snapshot.feeQuote,
          provenance: { toString: () => "provider" },
        },
      },
    ])
      expect(() => readWithdrawalReservationSnapshot(corrupt)).toThrowError(
        expect.objectContaining({ code: "WITHDRAWAL_UNAVAILABLE" }),
      );
    expect(() =>
      readWithdrawalReservationRecord({
        ...values.stored,
        intent: { ...values.stored.intent, id: "another-id" },
      }),
    ).toThrowError(expect.objectContaining({ code: "WITHDRAWAL_UNAVAILABLE" }));
  });
});
