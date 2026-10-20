import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as diagnostics from "./withdrawalDiagnostics";
import {
  captureOriginalWithdrawal,
  createWithdrawalExecutionService,
  type DispatchFence,
  type OriginalWithdrawal,
  type StoredWithdrawalExecution,
  usesAcceptedMaximumWithdrawalDispatch,
  type WithdrawalDispatchObservation,
  type WithdrawalExecutionOptions,
  type WithdrawalPostingRepository,
} from "./withdrawalExecution";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
} from "./withdrawalReservations";

function fixture(maximum = false, environment: "sandbox" | "live" = "sandbox") {
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
    feeCents: 500,
    ...(maximum ? { feeSemantics: "MAXIMUM" as const } : {}),
    netCents: 9500,
    currency: "BRL" as const,
    destinationVersion: 3,
    state: "REQUESTED" as const,
    mode: environment,
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
    environment,
    operationId: "operation-1",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          actor.siteId,
          "request-1",
          actor.userId,
          environment,
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
  const payout = {
    destinationId: "pix-1",
    destinationVersion: 1,
    configurationHash: "c".repeat(64),
    reviewId: "review-1",
    holderId: "holder-1",
    holderConsentId: "holder-consent-1",
    acceptThirdParty: false,
    keyType: "EMAIL" as const,
    maskedKey: "o***@example.test",
    ownerName: "Original Operator",
  };
  const presentation = {
    ...(maximum ? { payout } : {}),
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
    maskedDestination: maximum
      ? "Pix EMAIL: o***@example.test"
      : "Bank **** 1234",
    operatorDisplayName: "Original Operator",
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: actor.siteId,
      requestId: snapshot.requestId,
      mode: environment,
      amountCents: 10000,
      feeCents: 500,
      ...(maximum
        ? {
            feeSemantics: "MAXIMUM" as const,
            payoutRecipientName: payout.ownerName,
          }
        : {}),
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
  const fence: DispatchFence = {
    operationId: snapshot.operationId,
    attempts: 1,
    leaseOwner: "worker-1",
    leaseToken: "token-1",
    leaseExpiresAt: new Date(+time + 60000).toISOString(),
  };
  let stored: StoredWithdrawalExecution = {
    original,
    state: "PROCESSING",
    operationState: "PROCESSING",
    reservationState: "HELD",
    reservedCents: 10000,
    fence,
    providerReference: null,
    receiptReference: null,
    resolutionObservedAt: null,
  };
  const attempt = {
    actor,
    requestId: snapshot.requestId,
    access: {},
    recentAuth: {
      ...actor,
      proofKind: "PASSWORD_REAUTHENTICATION" as const,
      verification: "verified" as const,
      provenance: "backend" as const,
      authenticatedAt: new Date(+time - 30000),
      expiresAt: new Date(+time + 60000),
    },
  };
  const accepted: WithdrawalDispatchObservation = {
    outcome: "ACCEPTED",
    correlation,
    holderBinding,
    fence,
    providerReference: "transfer-1",
    observedAt: time.toISOString(),
    proofReference: null,
  };
  const repository: WithdrawalPostingRepository = {
    readExisting: vi.fn(async () => stored),
    armExisting: vi.fn(async () => ({
      outcome: "ARMED" as const,
      original,
      fence,
      dispatchValidUntil: feeQuote.expiresAt,
    })),
    recordObservation: vi.fn(async (_o, _f, observation) => {
      stored = {
        ...stored,
        state: observation.outcome === "ACCEPTED" ? "PROCESSING" : "UNKNOWN",
        operationState:
          observation.outcome === "ACCEPTED" ? "PROCESSING" : "UNKNOWN",
        providerReference:
          observation.outcome === "ACCEPTED"
            ? observation.providerReference
            : stored.providerReference,
      };
      return stored;
    }),
    postCompleted: vi.fn(async () => ({ outcome: "DENIED" as const })),
  };
  const dispatch = {
    dispatch: vi.fn(
      async (): Promise<WithdrawalDispatchObservation> => accepted,
    ),
  };
  const lookup = {
    lookup: vi.fn(async () => ({ outcome: "NOT_FOUND" as const })),
  };
  const options: WithdrawalExecutionOptions = {
    mode: environment,
    applicationEnvironment: environment === "live" ? "production" : "test",
    maxAuthAgeMs: 300000,
    now: () => new Date(time),
    repository,
    dispatch,
    lookup,
  };
  return {
    time,
    actor,
    attempt,
    original,
    fence,
    accepted,
    repository,
    dispatch,
    lookup,
    options,
    get stored() {
      return stored;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("private withdrawal execution", () => {
  it("dispatches the positively committed original arm once and retains the full hold", async () => {
    const f = fixture();
    const service = createWithdrawalExecutionService(f.options);
    expect((await service.executeExisting(f.attempt)).outcome).toBe(
      "PROCESSING",
    );
    expect(f.dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.dispatch).toHaveBeenCalledWith(f.original, f.fence);
    expect(f.stored.reservedCents).toBe(10000);
    expect(f.repository.postCompleted).not.toHaveBeenCalled();
  });
  it.each(["disabled", "dispatch", "lookup", "repository"])(
    "fails closed with unavailable %s",
    async (missing) => {
      const f = fixture();
      const options = { ...f.options } as any;
      if (missing === "disabled") options.mode = "disabled";
      else delete options[missing];
      expect(
        (
          await createWithdrawalExecutionService(options).executeExisting(
            f.attempt,
          )
        ).outcome,
      ).toBe("DENIED");
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each(["DENIED", "UNRESOLVED", "EXISTING"])(
    "never dispatches after arm %s",
    async (outcome) => {
      const f = fixture();
      vi.mocked(f.repository.armExisting).mockResolvedValue(
        outcome === "EXISTING"
          ? { outcome, stored: f.stored }
          : ({ outcome } as any),
      );
      expect(
        (
          await createWithdrawalExecutionService(f.options).executeExisting(
            f.attempt,
          )
        ).outcome,
      ).toBe(outcome);
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    },
  );
  it("captures the callable, receiver, configuration and input before arm awaits", async () => {
    const f = fixture();
    const arm = deferred<any>();
    vi.mocked(f.repository.armExisting).mockReturnValue(arm.promise);
    const port = {
      configuration: { reference: "transfer-1" },
      dispatch: vi.fn(async function (this: any, original, fence) {
        return {
          ...f.accepted,
          correlation: original.correlation,
          holderBinding: original.holderBinding,
          fence,
          providerReference: this.configuration.reference,
        };
      }),
    };
    (f.options as any).dispatch = port;
    const service = createWithdrawalExecutionService(f.options);
    const pending = service.executeExisting(f.attempt);
    f.attempt.actor.userId = "foreign";
    port.configuration.reference = "changed";
    port.dispatch = vi.fn();
    arm.resolve({
      outcome: "ARMED",
      original: f.original,
      fence: f.fence,
      dispatchValidUntil: f.original.snapshot.feeQuote.expiresAt,
    });
    expect((await pending).outcome).toBe("PROCESSING");
    expect(f.stored.providerReference).toBe("transfer-1");
    expect(port.dispatch).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.repository.armExisting).mock.calls[0][0].actor?.userId,
    ).toBe("operator-1");
  });
  it("owns a genuinely pending dispatch until its actual late rejection", async () => {
    const f = fixture();
    const native = deferred<WithdrawalDispatchObservation>();
    f.dispatch.dispatch.mockReturnValue(native.promise);
    let settled = false;
    const pending = createWithdrawalExecutionService(f.options)
      .executeExisting(f.attempt)
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.repository.recordObservation).not.toHaveBeenCalled();
    native.reject(new Error("private native details"));
    expect((await pending).outcome).toBe("UNRESOLVED");
    expect(f.stored.state).toBe("UNKNOWN");
    expect(f.stored.reservedCents).toBe(10000);
  });
  it("holds pending lookup ownership and reconciliation never dispatches", async () => {
    const f = fixture();
    const native = deferred<any>();
    f.lookup.lookup.mockReturnValue(native.promise);
    let settled = false;
    const pending = createWithdrawalExecutionService(f.options)
      .reconcileExisting({ siteId: "site-1", requestId: "request-1" })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    native.resolve({ outcome: "NOT_FOUND" });
    expect((await pending).outcome).toBe("UNRESOLVED");
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    expect(f.stored.state).toBe("UNKNOWN");
  });
  it.each([
    "correlation",
    "holder",
    "fence",
    "money",
    "future",
    "accessor",
    "thenable",
    "unknown",
  ])("retains uncertainty for malformed or foreign %s", async (kind) => {
    const f = fixture();
    const value: any = structuredClone(f.accepted);
    if (kind === "correlation") value.correlation.accountId = "replacement";
    if (kind === "holder") value.holderBinding.holderUserId = "replacement";
    if (kind === "fence") value.fence.leaseToken = "replacement";
    if (kind === "money") value.correlation.netCents = 9000;
    if (kind === "future")
      value.observedAt = new Date(+f.time + 1).toISOString();
    if (kind === "accessor")
      Object.defineProperty(value, "providerReference", {
        get() {
          throw new Error("private");
        },
        enumerable: true,
      });
    if (kind === "unknown") value.outcome = "SUCCESS";
    if (kind === "thenable")
      f.dispatch.dispatch = vi.fn(() =>
        // biome-ignore lint/suspicious/noThenProperty: Intentional malformed thenable verifies dispatch uncertainty without native settlement.
        Object.defineProperty({}, "then", {
          value: () => undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        }),
      ) as any;
    else f.dispatch.dispatch.mockResolvedValue(value);
    expect(
      (
        await createWithdrawalExecutionService(f.options).executeExisting(
          f.attempt,
        )
      ).outcome,
    ).toBe("UNRESOLVED");
    expect(f.stored.state).toBe("UNKNOWN");
    expect(f.stored.reservedCents).toBe(10000);
    expect(f.repository.postCompleted).not.toHaveBeenCalled();
  });
  it("does not dispatch after the captured authorization expires while arming", async () => {
    const f = fixture();
    vi.mocked(f.repository.armExisting).mockImplementation(async () => {
      f.time.setTime(+f.time + 60001);
      return {
        outcome: "ARMED",
        original: f.original,
        fence: f.fence,
        dispatchValidUntil: f.original.snapshot.feeQuote.expiresAt,
      };
    });
    expect(
      (
        await createWithdrawalExecutionService(f.options).executeExisting(
          f.attempt,
        )
      ).outcome,
    ).toBe("UNRESOLVED");
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    expect(f.stored.state).toBe("UNKNOWN");
  });
  it("requires durable proof lookup even when dispatch supplies a completion reference", async () => {
    const f = fixture();
    f.dispatch.dispatch.mockResolvedValue({
      ...f.accepted,
      proofReference: "actual-bank-receipt",
    });
    expect(
      (
        await createWithdrawalExecutionService(f.options).executeExisting(
          f.attempt,
        )
      ).outcome,
    ).toBe("DENIED");
    expect(f.repository.postCompleted).toHaveBeenCalledWith(
      f.original,
      f.fence,
      "actual-bank-receipt",
    );
    expect(f.stored.reservedCents).toBe(10000);
  });
  it("settles the original historical account from lookup without arm or current replacement authority", async () => {
    const f = fixture();
    f.lookup.lookup.mockResolvedValue({
      outcome: "FOUND",
      observation: { ...f.accepted, proofReference: "actual-bank-receipt" },
    } as any);
    vi.mocked(f.repository.postCompleted).mockResolvedValue({
      outcome: "COMPLETED",
      stored: {
        ...f.stored,
        state: "COMPLETED",
        operationState: "SUCCEEDED",
        reservationState: "CONSUMED",
        reservedCents: 0,
      },
    });
    expect(
      (
        await createWithdrawalExecutionService(f.options).reconcileExisting({
          siteId: "site-1",
          requestId: "request-1",
        })
      ).outcome,
    ).toBe("COMPLETED");
    expect(f.repository.armExisting).not.toHaveBeenCalled();
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    expect(f.lookup.lookup).toHaveBeenCalledWith(f.original, f.fence, null);
  });
  it("rejects nested array accessors without evaluating them or granting an arm", async () => {
    const f = fixture();
    let reads = 0;
    const values = [1];
    Object.defineProperty(values, "0", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    f.attempt.access = { values };
    expect(
      (
        await createWithdrawalExecutionService(f.options).executeExisting(
          f.attempt,
        )
      ).outcome,
    ).toBe("DENIED");
    expect(reads).toBe(0);
    expect(f.repository.armExisting).not.toHaveBeenCalled();
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
  });
  it.each(["actor", "account", "holder"])(
    "never dispatches a foreign positively acknowledged arm %s",
    async (kind) => {
      const f = fixture();
      const foreign = structuredClone(f.original);
      if (kind === "actor") foreign.holderBinding.actingUserId = "foreign";
      if (kind === "account") foreign.correlation.accountId = "replacement";
      if (kind === "holder")
        foreign.holderBinding.correlation.bankReference = "replacement";
      vi.mocked(f.repository.armExisting).mockResolvedValue({
        outcome: "ARMED",
        original: foreign,
        fence: f.fence,
        dispatchValidUntil: f.original.snapshot.feeQuote.expiresAt,
      });
      expect(
        (
          await createWithdrawalExecutionService(f.options).executeExisting(
            f.attempt,
          )
        ).outcome,
      ).toBe("UNRESOLVED");
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    },
  );
});

describe("withdrawal corrective boundaries", () => {
  it.each([
    ["live", "test"],
    ["live", "development"],
    ["sandbox", "production"],
    ["unexpected", "test"],
    [undefined, "test"],
    ["sandbox", undefined],
    ["sandbox", "unexpected"],
  ])(
    "does not enable service ports for runtime mode %s in %s",
    async (mode, applicationEnvironment) => {
      const f = fixture();
      const service = createWithdrawalExecutionService({
        ...f.options,
        mode,
        applicationEnvironment,
      } as any);
      expect((await service.executeExisting(f.attempt)).outcome).toBe("DENIED");
      expect(
        (
          await service.reconcileExisting({
            siteId: "site-1",
            requestId: "request-1",
          })
        ).outcome,
      ).toBe("DENIED");
      expect(f.repository.armExisting).not.toHaveBeenCalled();
      expect(f.repository.readExisting).not.toHaveBeenCalled();
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
      expect(f.lookup.lookup).not.toHaveBeenCalled();
    },
  );
  it.each(["dispatch", "lookup", "arm", "read", "record", "post"])(
    "retains genuine pending %s ownership when native constructor metadata cannot be observed safely",
    async (boundary) => {
      const f = fixture();
      const native = deferred<any>();
      let reads = 0;
      let entered = 0;
      Object.defineProperty(native.promise, "constructor", {
        get() {
          reads++;
          throw new Error("Unsafe native constructor metadata");
        },
      });
      // Plain ports deliver the original promise; spy settlement tracking would
      // access its constructor before the application can observe it.
      const hold = () => {
        entered++;
        return native.promise;
      };
      if (boundary === "dispatch") f.dispatch.dispatch = hold as any;
      if (boundary === "lookup") f.lookup.lookup = hold as any;
      if (boundary === "arm") f.repository.armExisting = hold;
      if (boundary === "read") f.repository.readExisting = hold;
      if (boundary === "record") f.repository.recordObservation = hold;
      if (boundary === "post") {
        f.dispatch.dispatch.mockResolvedValue({
          ...f.accepted,
          proofReference: "bank-receipt-1",
        });
        f.repository.postCompleted = hold;
      }
      const service = createWithdrawalExecutionService(f.options);
      let settled = false;
      const pending = (
        boundary === "lookup" || boundary === "read"
          ? service.reconcileExisting({
              siteId: "site-1",
              requestId: "request-1",
            })
          : service.executeExisting(f.attempt)
      ).then(() => {
        settled = true;
      });
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(entered).toBe(1);
      expect(settled).toBe(false);
      expect(reads).toBe(0);
      if (boundary === "dispatch" || boundary === "lookup")
        expect(f.repository.recordObservation).not.toHaveBeenCalled();
      native.resolve(
        boundary === "lookup" ? { outcome: "NOT_FOUND" } : f.accepted,
      );
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(settled).toBe(false);
      void pending;
    },
  );
  it.each(["dispatch", "lookup"])(
    "observes genuine %s settlement through safe own species data without early release",
    async (boundary) => {
      const f = fixture();
      const native = deferred<any>();
      Object.defineProperty(native.promise, "constructor", {
        value: { [Symbol.species]: Promise },
      });
      if (boundary === "dispatch")
        f.dispatch.dispatch = (() => native.promise) as any;
      else f.lookup.lookup = (() => native.promise) as any;
      const service = createWithdrawalExecutionService(f.options);
      let settled = false;
      const pending = (
        boundary === "dispatch"
          ? service.executeExisting(f.attempt)
          : service.reconcileExisting({
              siteId: "site-1",
              requestId: "request-1",
            })
      ).then((result) => {
        settled = true;
        return result;
      });
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.repository.recordObservation).not.toHaveBeenCalled();
      native.resolve(
        boundary === "dispatch" ? f.accepted : { outcome: "NOT_FOUND" },
      );
      expect((await pending).outcome).toBe(
        boundary === "dispatch" ? "PROCESSING" : "UNRESOLVED",
      );
    },
  );
  it("does not execute an accessor species or acknowledge its pending dispatch as completed", async () => {
    const f = fixture();
    const native = deferred<any>();
    let reads = 0;
    const nativeConstructor = {};
    Object.defineProperty(nativeConstructor, Symbol.species, {
      get() {
        reads++;
        throw new Error("Unsafe species metadata");
      },
    });
    Object.defineProperty(native.promise, "constructor", {
      value: nativeConstructor,
    });
    f.dispatch.dispatch = (() => native.promise) as any;
    let settled = false;
    const pending = createWithdrawalExecutionService(f.options)
      .executeExisting(f.attempt)
      .then(() => {
        settled = true;
      });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(reads).toBe(0);
    expect(f.repository.recordObservation).not.toHaveBeenCalled();
    native.resolve(f.accepted);
    void pending;
  });
});

describe("withdrawal configuration capture amendment", () => {
  it("rejects stateful mode switching before activating service ports", async () => {
    const f = fixture();
    let reads = 0;
    const options = { ...f.options };
    Object.defineProperty(options, "mode", {
      enumerable: true,
      get() {
        reads++;
        return reads <= 2 ? "sandbox" : "live";
      },
    });
    const service = createWithdrawalExecutionService(options);
    expect((await service.executeExisting(f.attempt)).outcome).toBe("DENIED");
    expect(reads).toBe(0);
    expect(f.repository.armExisting).not.toHaveBeenCalled();
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
  });
  it("rejects stateful production-to-test configuration without evaluating it", async () => {
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
    const service = createWithdrawalExecutionService(options);
    expect((await service.executeExisting(f.attempt)).outcome).toBe("DENIED");
    expect(reads).toBe(0);
    expect(f.repository.armExisting).not.toHaveBeenCalled();
  });
  it.each([
    "mode",
    "applicationEnvironment",
    "maxAuthAgeMs",
    "repository",
    "dispatch",
    "lookup",
    "now",
  ])(
    "rejects accessor configuration %s before activating a service capability",
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
      const service = createWithdrawalExecutionService(options);
      expect((await service.executeExisting(f.attempt)).outcome).toBe("DENIED");
      expect(
        (
          await service.reconcileExisting({
            siteId: "site-1",
            requestId: "request-1",
          })
        ).outcome,
      ).toBe("DENIED");
      expect(reads).toBe(0);
      expect(f.repository.armExisting).not.toHaveBeenCalled();
      expect(f.repository.readExisting).not.toHaveBeenCalled();
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
      expect(f.lookup.lookup).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, 0, -1, 0.5, "300000", Number.NaN])(
    "rejects ordinary invalid authentication age %s without activating ports",
    async (maxAuthAgeMs) => {
      const f = fixture();
      const service = createWithdrawalExecutionService({
        ...f.options,
        maxAuthAgeMs,
      } as any);
      expect((await service.executeExisting(f.attempt)).outcome).toBe("DENIED");
      expect(f.repository.armExisting).not.toHaveBeenCalled();
    },
  );
  it.each(["development", "test"])(
    "preserves ordinary sandbox data configuration in %s",
    async (applicationEnvironment) => {
      const f = fixture();
      const options = { ...f.options, applicationEnvironment } as any;
      const service = createWithdrawalExecutionService(options);
      options.mode = "live";
      options.applicationEnvironment = "production";
      options.maxAuthAgeMs = 0;
      expect((await service.executeExisting(f.attempt)).outcome).toBe(
        "PROCESSING",
      );
      expect(f.dispatch.dispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("admits ordinary live/production factory data while preserving original-scope checks", async () => {
    const f = fixture();
    const service = createWithdrawalExecutionService({
      ...f.options,
      mode: "live",
      applicationEnvironment: "production",
    });
    expect((await service.executeExisting(f.attempt)).outcome).toBe(
      "UNRESOLVED",
    );
    expect(f.repository.armExisting).toHaveBeenCalledTimes(1);
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
  });
});

describe("accepted maximum withdrawal dispatch authority", () => {
  it("recognizes only validated accepted provider maximum Sandbox consent", () => {
    const f = fixture(true);
    expect(usesAcceptedMaximumWithdrawalDispatch(f.original, "test")).toBe(
      true,
    );
    expect(
      usesAcceptedMaximumWithdrawalDispatch(f.original, "development"),
    ).toBe(true);
    expect(
      usesAcceptedMaximumWithdrawalDispatch(f.original, "production"),
    ).toBe(false);
    expect(
      usesAcceptedMaximumWithdrawalDispatch(fixture().original, "test"),
    ).toBe(false);
  });
  it.each([
    "revision",
    "state",
    "payout",
    "provenance",
    "acceptance",
    "issuedAt",
  ])("denies invalid renewal qualification: %s", (kind) => {
    const f = fixture(true);
    const original = structuredClone(f.original) as any;
    if (kind === "revision") original.consent.requestRevision = "1";
    if (kind === "state") original.consent.state = "OPEN";
    if (kind === "payout") delete original.consent.snapshot.presentation.payout;
    if (kind === "provenance")
      original.snapshot.feeQuote.provenance = "simulation";
    if (kind === "acceptance")
      original.snapshot.intent.createdAt = original.snapshot.feeQuote.expiresAt;
    if (kind === "issuedAt")
      original.consent.snapshot.preview.issuedAt = new Date(
        +f.time + 1,
      ).toISOString();
    expect(usesAcceptedMaximumWithdrawalDispatch(original, "test")).toBe(false);
  });
  it("dispatches an accepted expired maximum preview under a fresh short authority without changing consent", async () => {
    const f = fixture(true);
    const now = new Date(+f.time + 61_000);
    const validUntil = new Date(+now + 30_000).toISOString();
    f.attempt.recentAuth.authenticatedAt = now;
    f.attempt.recentAuth.expiresAt = new Date(validUntil);
    f.fence.leaseExpiresAt = validUntil;
    vi.mocked(f.repository.armExisting).mockResolvedValue({
      outcome: "ARMED",
      original: f.original,
      fence: f.fence,
      dispatchValidUntil: validUntil,
    });
    const original = structuredClone(f.original);
    const service = createWithdrawalExecutionService({
      ...f.options,
      now: () => now,
    });
    expect((await service.executeExisting(f.attempt)).outcome).toBe(
      "PROCESSING",
    );
    expect(f.dispatch.dispatch).toHaveBeenCalledOnce();
    expect(f.original).toEqual(original);
  });
  it("keeps expired exact-fee previews unable to dispatch even with fresh authentication", async () => {
    const f = fixture();
    const now = new Date(+f.time + 61_000);
    const validUntil = new Date(+now + 30_000).toISOString();
    f.attempt.recentAuth.authenticatedAt = now;
    f.attempt.recentAuth.expiresAt = new Date(validUntil);
    f.fence.leaseExpiresAt = validUntil;
    vi.mocked(f.repository.armExisting).mockResolvedValue({
      outcome: "ARMED",
      original: f.original,
      fence: f.fence,
      dispatchValidUntil: validUntil,
    });
    expect(
      (
        await createWithdrawalExecutionService({
          ...f.options,
          now: () => now,
        }).executeExisting(f.attempt)
      ).outcome,
    ).toBe("UNRESOLVED");
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
  });
  it.each(["proof", "authority", "lease"])(
    "never renews expired current %s authority from accepted consent",
    async (kind) => {
      const f = fixture(true);
      const now = new Date(+f.time + 61_000);
      const later = new Date(+now + 30_000).toISOString();
      f.attempt.recentAuth.authenticatedAt = now;
      f.attempt.recentAuth.expiresAt = kind === "proof" ? now : new Date(later);
      f.fence.leaseExpiresAt = kind === "lease" ? now.toISOString() : later;
      vi.mocked(f.repository.armExisting).mockResolvedValue({
        outcome: "ARMED",
        original: f.original,
        fence: f.fence,
        dispatchValidUntil: kind === "authority" ? now.toISOString() : later,
      });
      await createWithdrawalExecutionService({
        ...f.options,
        now: () => now,
      }).executeExisting(f.attempt);
      expect(f.dispatch.dispatch).not.toHaveBeenCalled();
    },
  );
});

it("reports a caught arm failure through existing safe diagnostics without changing denial", async () => {
  const diagnostic = vi
    .spyOn(diagnostics, "logWithdrawalFailure")
    .mockImplementation(() => {});
  try {
    const f = fixture();
    const failure = new Error("synthetic private failure");
    vi.mocked(f.repository.armExisting).mockRejectedValue(failure);
    expect(
      await createWithdrawalExecutionService(f.options).executeExisting(
        f.attempt,
      ),
    ).toEqual({ outcome: "DENIED" });
    expect(diagnostic).toHaveBeenCalledWith(failure);
    expect(f.dispatch.dispatch).not.toHaveBeenCalled();
  } finally {
    diagnostic.mockRestore();
  }
});

function confirmationWithFreshQuote(
  maximum = true,
  environment: "sandbox" | "live" = "sandbox",
) {
  const f = fixture(maximum, environment);
  return {
    fixture: f,
    original: {
      ...f.original,
      snapshot: {
        ...f.original.snapshot,
        intent: {
          ...f.original.snapshot.intent,
          createdAt: new Date(+f.time + 2000).toISOString(),
          updatedAt: new Date(+f.time + 2000).toISOString(),
        },
        feeQuote: {
          ...f.original.snapshot.feeQuote,
          observedAt: new Date(+f.time + 1000).toISOString(),
          expiresAt: new Date(+f.time + 61000).toISOString(),
        },
      },
    },
  };
}

it("captures accepted reviewed maximum consent when confirmation independently refreshed only native quote times", () => {
  const { original } = confirmationWithFreshQuote();
  const frozen = structuredClone(original);
  expect(() => captureOriginalWithdrawal(original)).not.toThrow();
  expect(usesAcceptedMaximumWithdrawalDispatch(original, "test")).toBe(true);
  expect(original).toEqual(frozen);
});

it("retains strict fee quote timestamp equality for exact-fee consent", () => {
  const { original } = confirmationWithFreshQuote(false);
  expect(() => captureOriginalWithdrawal(original)).toThrow(
    "Invalid original withdrawal consent",
  );
});

it.each([
  "fee",
  "policy",
  "provenance",
  "semantics",
  "future",
  "rollback",
  "extendedLifetime",
  "shortenedLifetime",
  "frozenDeadline",
  "freshDeadline",
])("rejects changed or invalid refreshed confirmation quote: %s", (kind) => {
  const { original, fixture: f } = confirmationWithFreshQuote();
  if (kind === "fee") {
    original.snapshot.feeQuote.feeCents += 1;
    original.snapshot.intent.feeCents += 1;
    original.snapshot.intent.netCents -= 1;
  }
  if (kind === "policy")
    original.snapshot.feeQuote.policyVersion = "changed-policy";
  if (kind === "provenance")
    original.snapshot.feeQuote.provenance = "simulation";
  if (kind === "semantics") delete original.snapshot.feeQuote.feeSemantics;
  if (kind === "future") {
    original.snapshot.feeQuote.observedAt = new Date(
      +f.time + 2001,
    ).toISOString();
    original.snapshot.feeQuote.expiresAt = new Date(
      +f.time + 62001,
    ).toISOString();
  }
  if (kind === "rollback") {
    original.snapshot.feeQuote.observedAt = new Date(+f.time - 1).toISOString();
    original.snapshot.feeQuote.expiresAt = new Date(
      +f.time + 59999,
    ).toISOString();
  }
  if (kind === "extendedLifetime")
    original.snapshot.feeQuote.expiresAt = new Date(
      +f.time + 61001,
    ).toISOString();
  if (kind === "shortenedLifetime")
    original.snapshot.feeQuote.expiresAt = new Date(
      +f.time + 60999,
    ).toISOString();
  if (kind === "frozenDeadline") {
    original.snapshot.intent.createdAt =
      original.consent.snapshot.preview.expiresAt;
    original.snapshot.intent.updatedAt = original.snapshot.intent.createdAt;
  }
  if (kind === "freshDeadline") {
    original.snapshot.intent.createdAt = original.snapshot.feeQuote.expiresAt;
    original.snapshot.intent.updatedAt = original.snapshot.intent.createdAt;
  }
  expect(() => captureOriginalWithdrawal(original)).toThrow();
});

it("does not infer reviewed maximum acceptance without frozen payout custody", () => {
  const { original } = confirmationWithFreshQuote();
  const presentation = { ...original.consent.snapshot.presentation };
  delete presentation.payout;
  const consentSnapshot = readWithdrawalConsentSnapshot({
    ...original.consent.snapshot,
    preview: {
      ...original.consent.snapshot.preview,
      maskedDestination: "Bank **** 1234",
      payoutRecipientName: undefined,
    },
    presentation: { ...presentation, maskedDestination: "Bank **** 1234" },
  });
  const previewHash = hashWithdrawalConsentSnapshot(consentSnapshot);
  const withoutPayout = {
    ...original,
    consent: { ...original.consent, snapshot: consentSnapshot, previewHash },
    holderBinding: { ...original.holderBinding, consentHash: previewHash },
  };
  expect(() => captureOriginalWithdrawal(withoutPayout)).toThrow(
    "Invalid original withdrawal consent",
  );
});

it("retains strict fee quote timestamp equality for otherwise valid live maximum consent", () => {
  expect(() =>
    captureOriginalWithdrawal(fixture(true, "live").original),
  ).not.toThrow();
  const { original } = confirmationWithFreshQuote(true, "live");
  expect(() => captureOriginalWithdrawal(original)).toThrow(
    "Invalid original withdrawal consent",
  );
});
