import { describe, expect, it, vi } from "vitest";
import {
  createReceivingVerification,
  encodeReceivingVerificationReceipt,
  prepareReceivingVerificationObservation,
  type ReceivingVerificationObservation,
  type ReceivingVerificationRepository,
  readReceivingVerificationCandidate,
  readReceivingVerificationReceipt,
  verificationTimestamp,
} from "./receivingVerification";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}
function serviceFixture() {
  const scope = {
    provider: "ASAAS" as const,
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "operator-one",
    environment: "sandbox" as const,
    operatorReference: "native-operator",
    accountReference: "native-account",
    recipientReference: "native-wallet",
  };
  const observation: ReceivingVerificationObservation = {
    kind: "OBSERVATION",
    profile: "rv1",
    verifiable: true,
    scope,
    destination: {
      id: "selection-one",
      version: 1,
      bankReference: "native-bank",
    },
    account: {
      sourceId: "account-source-one",
      sourceOrder: "9007199254740993",
      state: "UNVERIFIED",
      observedAt: "2026-10-13T00:00:01.000123Z",
      receiving: false,
      withdrawal: false,
      commercial: false,
    },
    bank: {
      sourceId: "bank-source-one",
      sourceOrder: "9007199254740995",
      state: "VERIFIED",
      observedAt: "2026-10-13T00:00:00.000321Z",
    },
  };
  const fence = {
    scope,
    account: {},
    operation: {},
    destinations: [
      {
        id: "selection-one",
        version: 1,
        bank_reference: "native-bank",
        is_current: true,
      },
    ],
    evidence: [],
  };
  const repository = {
    captureSelection: vi.fn<
      ReceivingVerificationRepository["captureSelection"]
    >(async () => fence),
    selectDestination: vi.fn<
      ReceivingVerificationRepository["selectDestination"]
    >(async () => {}),
    captureObservation: vi.fn<
      ReceivingVerificationRepository["captureObservation"]
    >(async () => fence),
    appendObservation: vi.fn<
      ReceivingVerificationRepository["appendObservation"]
    >(async () => {}),
    consultSelection: vi.fn<
      ReceivingVerificationRepository["consultSelection"]
    >(async () => true),
    consultObservation: vi.fn<
      ReceivingVerificationRepository["consultObservation"]
    >(async () => true),
  } satisfies ReceivingVerificationRepository;
  const native = {
    result: Promise.resolve(observation),
    completion: Promise.resolve(),
    cancel: vi.fn(),
  };
  const observer = {
    profile: "rv1" as const,
    acquire: vi.fn(() => native),
    close: vi.fn(async () => {}),
  };
  const options = {
    profile: "rv1" as const,
    readObserverPolicy: vi.fn(async () => true),
    repository,
    observer,
    now: () => new Date("2026-10-13T00:00:02.000Z"),
  };
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
      authenticatedAt: new Date("2026-10-12T23:59:30Z"),
      expiresAt: new Date("2026-10-13T00:04:00Z"),
    },
  };
  const candidate = {
    kind: "DESTINATION" as const,
    profile: "rv1" as const,
    verifiable: true as const,
    scope,
    bankReference: "native-bank-two",
    maskedDescriptor: "Bank **** 1234",
    mappingReference: "mapping-one",
  };
  return {
    scope,
    observation,
    fence,
    repository,
    native,
    observer,
    options,
    authorization,
    candidate,
  };
}
describe("captured private verification service", () => {
  it.each([true, false])(
    "keeps session-only selection isolated behind the setup opt-in (%s)",
    async (enabled) => {
      const v = serviceFixture();
      v.observer.acquire.mockReturnValue({
        ...v.native,
        result: Promise.resolve(v.candidate),
      } as never);
      const service = createReceivingVerification({
        ...v.options,
        setupSessionSelection: enabled,
      });
      const owner = service.begin({
        action: "SELECT",
        scope: v.scope,
        selectionId: "selection-new",
        confirmDestinationSelection: true,
        authorization: {
          ...v.authorization,
          recentAuth: {
            ...v.authorization.recentAuth,
            proofKind: "SESSION_AUTHENTICATION",
          },
        },
      });
      expect((await owner.feedback).state).toBe(
        enabled ? "STORED" : "UNAVAILABLE",
      );
      await owner.completion;
      if (!enabled)
        expect(v.repository.captureSelection).not.toHaveBeenCalled();
      await service.close();
    },
  );

  it.each(["Account 123456789012", "123456789012", "Bank ending 1234"])(
    "unsafe native descriptor %s cannot reach the destination writer",
    async (maskedDescriptor) => {
      const values = serviceFixture();
      values.native.result = Promise.resolve({
        ...values.candidate,
        maskedDescriptor,
      } as never);
      const service = createReceivingVerification(values.options);
      const owner = service.begin({
        action: "SELECT",
        scope: values.scope,
        selectionId: "selection-two",
        authorization: values.authorization,
        confirmDestinationSelection: true,
      });
      expect((await owner.feedback).state).toBe("UNAVAILABLE");
      await owner.completion;
      expect(values.repository.selectDestination).not.toHaveBeenCalled();
      await service.close();
    },
  );
  it.each([null, "Bank **** 1234", "Bank •••• 1234"])(
    "retains the original safe or unavailable mask %s without transformation",
    (maskedDescriptor) => {
      expect(
        readReceivingVerificationCandidate({
          ...serviceFixture().candidate,
          maskedDescriptor,
        }).maskedDescriptor,
      ).toBe(maskedDescriptor);
    },
  );
  it("retains the normalized original fact snapshot while actual native drain remains pending", async () => {
    const values = serviceFixture();
    const drain = deferred();
    values.native.completion = drain.promise;
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    await flush();
    Object.assign(values.observation.account, {
      state: "APPROVED",
      receiving: true,
      withdrawal: true,
      commercial: true,
    });
    drain.resolve();
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    expect(
      values.repository.appendObservation.mock.calls[0]?.[1].account,
    ).toMatchObject({
      state: "UNVERIFIED",
      receiving: false,
      withdrawal: false,
      commercial: false,
    });
    await service.close();
  });
  it("captures a native owner factory getter exactly once before dispatch", async () => {
    const values = serviceFixture();
    const acquire = values.observer.acquire;
    const getter = vi.fn(() => acquire);
    Object.defineProperty(values.observer, "acquire", { get: getter });
    const service = createReceivingVerification(values.options);
    expect(getter).toHaveBeenCalledOnce();
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(getter).toHaveBeenCalledOnce();
  });
  it("keeps bundle identity independent of mutable orders, native facts and source times", () => {
    const values = serviceFixture();
    const original = prepareReceivingVerificationObservation(
      values.observation,
    );
    const changed = prepareReceivingVerificationObservation({
      ...values.observation,
      account: {
        ...values.observation.account,
        sourceOrder: "9007199254740994",
        state: "BLOCKED",
        observedAt: "2026-10-13T00:00:01.000124Z",
      },
    });
    expect(changed.evidenceId).toBe(original.evidenceId);
    expect(changed.verificationReference).not.toBe(
      original.verificationReference,
    );
    const replacement = prepareReceivingVerificationObservation({
      ...values.observation,
      destination: {
        ...values.observation.destination,
        id: "selection-two",
        version: 2,
      },
    });
    expect(replacement.evidenceId).not.toBe(original.evidenceId);
  });
  it("is unavailable before private repository/observer reads without the selected profile/policy", async () => {
    let reads = 0;
    const options = {
      profile: "rv2",
      get repository() {
        reads++;
        throw new Error("private repository");
      },
      get observer() {
        reads++;
        throw new Error("private observer");
      },
    };
    const service = createReceivingVerification(options as never);
    expect(service.available).toBe(false);
    expect(reads).toBe(0);
    await service.close();
  });
  it("captures unavailable configuration failure without a private exception", async () => {
    const values = serviceFixture();
    Object.defineProperty(values.options, "profile", {
      get() {
        throw new Error("private provider configuration");
      },
    });
    let service: ReturnType<typeof createReceivingVerification> | undefined;
    expect(() => {
      service = createReceivingVerification(values.options);
    }).not.toThrow();
    expect(service?.available).toBe(false);
    expect(values.observer.acquire).not.toHaveBeenCalled();
    await service?.close();
  });
  it("stores a verifiable account UNVERIFIED with the exact original bank proof and no public private references", async () => {
    const values = serviceFixture();
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    const prepared = values.repository.appendObservation.mock.calls[0]?.[1];
    expect(prepared).toMatchObject({
      account: { state: "UNVERIFIED" },
      bank: values.observation.bank,
    });
    expect(JSON.stringify(await owner.feedback)).not.toMatch(
      /native-bank|native-wallet|native-operator|SourceOrder/,
    );
    expect(values.observer.acquire).toHaveBeenCalledOnce();
    await service.close();
  });
  it("current observer-policy denial cannot read a DB fence or native work", async () => {
    const values = serviceFixture();
    values.options.readObserverPolicy.mockResolvedValue(false);
    const service = createReceivingVerification(values.options);
    expect(
      (await service.begin({ action: "OBSERVE", scope: values.scope }).feedback)
        .state,
    ).toBe("UNAVAILABLE");
    expect(values.repository.captureObservation).not.toHaveBeenCalled();
    expect(values.observer.acquire).not.toHaveBeenCalled();
    await service.close();
  });
  it("nonverifiable native result cannot create an authoritative evidence row", async () => {
    const values = serviceFixture();
    values.native.result = Promise.resolve({
      ...values.observation,
      verifiable: false,
    } as never);
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    expect((await owner.feedback).state).toBe("UNAVAILABLE");
    await owner.completion;
    expect(values.repository.appendObservation).not.toHaveBeenCalled();
    await service.close();
  });
  it("selects only the original server-issued selection ID after a trusted candidate and exact consent", async () => {
    const values = serviceFixture();
    values.native.result = Promise.resolve(values.candidate as never);
    const service = createReceivingVerification(values.options);
    const owner = service.begin({
      action: "SELECT",
      scope: values.scope,
      selectionId: "selection-two",
      authorization: values.authorization,
      confirmDestinationSelection: true,
    });
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    expect(values.repository.selectDestination).toHaveBeenCalledWith(
      values.fence,
      "selection-two",
      values.candidate,
      expect.objectContaining({ actor: values.authorization.actor }),
    );
    await service.close();
  });
  it("missing destination consent sends no native request", async () => {
    const values = serviceFixture();
    const service = createReceivingVerification(values.options);
    const owner = service.begin({
      action: "SELECT",
      scope: values.scope,
      selectionId: "selection-two",
      authorization: values.authorization,
      confirmDestinationSelection: false,
    } as never);
    expect((await owner.feedback).state).toBe("UNAVAILABLE");
    expect(values.observer.acquire).not.toHaveBeenCalled();
    await service.close();
  });
  it.each(["OBSERVE", "SELECT"] as const)(
    "lost %s commit ACK consults only the exact original prepared result and never retries",
    async (action) => {
      const values = serviceFixture();
      if (action === "SELECT") {
        values.native.result = Promise.resolve(values.candidate as never);
        values.repository.selectDestination.mockRejectedValue(
          new Error("private lost ACK"),
        );
      } else
        values.repository.appendObservation.mockRejectedValue(
          new Error("private lost ACK"),
        );
      const service = createReceivingVerification(values.options);
      const command =
        action === "SELECT"
          ? {
              action,
              scope: values.scope,
              selectionId: "selection-two",
              authorization: values.authorization,
              confirmDestinationSelection: true as const,
            }
          : { action, scope: values.scope };
      const owner = service.begin(command);
      expect((await owner.feedback).state).toBe("STORED");
      await owner.completion;
      expect(values.observer.acquire).toHaveBeenCalledOnce();
      expect(
        action === "SELECT"
          ? values.repository.selectDestination
          : values.repository.appendObservation,
      ).toHaveBeenCalledOnce();
      expect(
        action === "SELECT"
          ? values.repository.consultSelection
          : values.repository.consultObservation,
      ).toHaveBeenCalledOnce();
      await service.close();
    },
  );
  it("uncertain original result consultation keeps UNKNOWN with no native/write retry", async () => {
    const values = serviceFixture();
    values.repository.appendObservation.mockRejectedValue(
      new Error("private ACK"),
    );
    values.repository.consultObservation.mockResolvedValue(false);
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    expect(values.observer.acquire).toHaveBeenCalledOnce();
    expect(values.repository.appendObservation).toHaveBeenCalledOnce();
    await service.close();
  });
  it("close waits for actual late native body/normalizer completion and prevents late positive persistence", async () => {
    const values = serviceFixture();
    const result = deferred<ReceivingVerificationObservation>();
    const completion = deferred();
    values.native.result = result.promise;
    values.native.completion = completion.promise;
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    await flush();
    const closing = service.close();
    let closed = false;
    let completed = false;
    void closing.then(() => {
      closed = true;
    });
    void owner.completion.then(() => {
      completed = true;
    });
    await flush();
    expect(closed).toBe(false);
    expect(completed).toBe(false);
    result.resolve(values.observation);
    await flush();
    expect(closed).toBe(false);
    completion.resolve();
    await closing;
    await owner.completion;
    expect(values.repository.appendObservation).not.toHaveBeenCalled();
    expect(values.native.cancel).toHaveBeenCalled();
    expect(values.observer.close).toHaveBeenCalledOnce();
  });
  it("caller feedback does not settle a still-owned transaction or its exact ACK read", async () => {
    const values = serviceFixture();
    const commit = deferred();
    values.repository.appendObservation.mockImplementation(
      () => commit.promise,
    );
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    await flush();
    owner.cancel();
    expect((await owner.feedback).state).toBe("UNKNOWN");
    let completed = false;
    void owner.completion.then(() => {
      completed = true;
    });
    const closing = service.close();
    await flush();
    expect(completed).toBe(false);
    commit.resolve();
    await owner.completion;
    await closing;
    expect(values.repository.appendObservation).toHaveBeenCalledOnce();
  });
  it("the original native completion must finish before any authoritative write", async () => {
    const values = serviceFixture();
    const nativeCompletion = deferred();
    values.native.completion = nativeCompletion.promise;
    const service = createReceivingVerification(values.options);
    const owner = service.begin({ action: "OBSERVE", scope: values.scope });
    await flush();
    expect(values.repository.appendObservation).not.toHaveBeenCalled();
    nativeCompletion.resolve();
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
  });
});
describe("immutable private rv1 receipt profile", () => {
  it("formats exact captured database microseconds without losing one-microsecond fences", () => {
    const microseconds =
      BigInt(Date.parse("2026-10-13T00:00:00.000Z")) * 1000n + 123n;
    expect(verificationTimestamp(microseconds)).toBe(
      "2026-10-13T00:00:00.000123Z",
    );
    expect(verificationTimestamp(microseconds + 1n)).toBe(
      "2026-10-13T00:00:00.000124Z",
    );
  });
  const receipt = {
    accountSourceId: "a".repeat(64),
    accountSourceOrder: "18446744073709551615",
    bankSourceId: "b".repeat(64),
    bankSourceOrder: "18446744073709551615",
  };
  it("retains both original source identities and exact uint64 orders in 246 printable bytes", () => {
    const encoded = encodeReceivingVerificationReceipt(receipt);
    expect(Buffer.byteLength(encoded)).toBe(246);
    expect(encoded).toMatch(/^rv1\.[A-Za-z0-9_-]+$/);
    expect(readReceivingVerificationReceipt(encoded)).toEqual(receipt);
    expect(
      encodeReceivingVerificationReceipt(
        readReceivingVerificationReceipt(encoded),
      ),
    ).toBe(encoded);
  });
  it("represents an absent bank source only as an exact paired null", () => {
    const original = { ...receipt, bankSourceId: null, bankSourceOrder: null };
    expect(
      readReceivingVerificationReceipt(
        encodeReceivingVerificationReceipt(original),
      ),
    ).toEqual(original);
  });
  it.each([
    "zero",
    "leading-zero",
    "overflow",
    "partial-null",
    "oversize-id",
    "unknown-field",
  ])(
    "rejects %s without changing or hashing the original receipt",
    (change) => {
      const original = { ...receipt } as Record<string, unknown>;
      if (change === "zero") original.accountSourceOrder = "0";
      if (change === "leading-zero") original.accountSourceOrder = "01";
      if (change === "overflow")
        original.accountSourceOrder = "18446744073709551616";
      if (change === "partial-null") original.bankSourceId = null;
      if (change === "oversize-id") original.accountSourceId = "a".repeat(65);
      if (change === "unknown-field") original.accountSourceTime = "2026-10-13";
      expect(() =>
        encodeReceivingVerificationReceipt(original as never),
      ).toThrow("Receiving verification unavailable");
    },
  );
  it.each([
    "unknown-profile",
    "padded",
    "noncanonical-json",
    "wrong-arity",
    "partial-null",
    "overflow",
    "oversize",
  ])("rejects %s on decode", (change) => {
    let payload = JSON.stringify(["source-a", "1", "source-b", "2"]);
    if (change === "noncanonical-json")
      payload = '["source-a", "1","source-b","2"]';
    if (change === "wrong-arity") payload = '["source-a","1",null]';
    if (change === "partial-null") payload = '["source-a","1",null,"2"]';
    if (change === "overflow")
      payload = '["source-a","18446744073709551616",null,null]';
    let value = `rv1.${Buffer.from(payload).toString("base64url")}`;
    if (change === "unknown-profile") value = value.replace("rv1.", "rv2.");
    if (change === "padded") value += "=";
    if (change === "oversize") value += "a".repeat(257);
    expect(() => readReceivingVerificationReceipt(value)).toThrow(
      "Receiving verification unavailable",
    );
  });
});
