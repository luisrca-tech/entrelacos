import { createHash, createHmac, hkdfSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAsaasAccountProvisioningClient } from "./asaasAccountProvisioningClient";
import {
  createReceivingAccountProvisioning,
  deriveReceivingProvisioningContext,
} from "./receivingAccountProvisioning";
import {
  type ReceivingProvisioningRecord,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";

const nonceState = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, ++nonceState.value),
}));
beforeEach(() => {
  nonceState.value = 0;
});

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
function fixture() {
  const now = new Date("2026-10-13T00:00:00.000Z");
  const scope = {
    siteId: "site-one",
    accountId: "account-one",
    operationId: "operation-one",
    requestId: "request-one",
    operatorUserId: "operator-one",
    environment: "sandbox" as const,
    policyVersion: "policy-one",
  };
  const nomination = readReceivingNominationSnapshot({
    state: "AWAITING_PROVIDER_VERIFICATION",
    ...scope,
    createdAt: now.toISOString(),
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          scope.siteId,
          scope.requestId,
          scope.operatorUserId,
          scope.environment,
          scope.policyVersion,
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      userId: scope.operatorUserId,
      siteId: scope.siteId,
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: new Date(now.getTime() - 30000).toISOString(),
      expiresAt: new Date(now.getTime() + 270000).toISOString(),
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
  const authorization = {
    actor: {
      userId: scope.operatorUserId,
      siteId: scope.siteId,
      sessionId: "session-one",
    },
    recentAuth: {
      userId: scope.operatorUserId,
      siteId: scope.siteId,
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION" as const,
      provenance: "backend" as const,
      verification: "verified" as const,
      authenticatedAt: new Date(nomination.authentication.authenticatedAt),
      expiresAt: new Date(nomination.authentication.expiresAt),
    },
  };
  let record: ReceivingProvisioningRecord | undefined;
  let state = "REQUESTED";
  let attached: ReceivingProvisioningResult | null = null;
  const controls = {
    armLostAck: false,
    confirmationDenied: false,
    claimLostAck: false,
    quarantineLostAck: false,
    attachLostAck: false,
    consultedUncertain: false,
    attachmentDenied: false,
  };
  const repository = {
    claimOriginal: vi.fn(
      async (context: {
        nomination: typeof nomination;
        provision: unknown;
        leaseOwner: string;
        leaseToken: string;
      }) => {
        if (state !== "REQUESTED") throw new Error("existing operation");
        record = readReceivingProvisioningRecord({
          version: "receiving.account-provisioning.v1",
          nomination: context.nomination,
          provision: {
            ...(context.provision as object),
            dispatch: {
              leaseOwner: context.leaseOwner,
              leaseToken: context.leaseToken,
              leaseExpiresAtMicroseconds: (
                BigInt(now.getTime()) * 1000n +
                60000000n
              ).toString(),
              possibleDispatch: false,
            },
          },
          sealedResult: null,
        });
        state = "CLAIMED";
        if (controls.claimLostAck) throw new Error("private claim ACK");
        return record;
      },
    ),
    armOriginal: vi.fn(async (claim: ReceivingProvisioningRecord) => {
      if (state !== "CLAIMED") throw new Error("already armed");
      record = claim;
      state = "UNKNOWN";
      if (controls.armLostAck) throw new Error("private arm ACK");
    }),
    confirmOriginalArmForDispatch: vi.fn(
      async (
        _claim: ReceivingProvisioningRecord,
        _authorization: typeof authorization,
      ) => {
        if (controls.confirmationDenied || state !== "UNKNOWN")
          throw new Error("current confirmation denied");
      },
    ),
    quarantineOriginal: vi.fn(
      async (
        _claim: ReceivingProvisioningRecord,
        result: ReceivingProvisioningResult,
      ) => {
        record = readReceivingProvisioningRecord({
          ...record,
          sealedResult: result,
        });
        if (controls.quarantineLostAck)
          throw new Error("private quarantine ACK");
      },
    ),
    attachOriginal: vi.fn(
      async (
        _claim: ReceivingProvisioningRecord,
        result: ReceivingProvisioningResult,
      ) => {
        if (controls.attachmentDenied) throw new Error("revoked attachment");
        record = readReceivingProvisioningRecord({
          ...record,
          sealedResult: null,
        });
        attached = result;
        state = "SUCCEEDED";
        if (controls.attachLostAck) throw new Error("private attachment ACK");
      },
    ),
    consultOriginal: vi.fn(
      async (
        _claim: ReceivingProvisioningRecord,
        _expected: ReceivingProvisioningResult | null,
      ) => {
        if (controls.consultedUncertain || !record)
          throw new Error("private unavailable consultation");
        return { record, state, result: attached ?? record.sealedResult };
      },
    ),
  };
  const fetchOriginal = vi.fn(async () => new Response("{}", { status: 201 }));
  const fingerprintKeys = new Map([["fp-v1", new Uint8Array(32).fill(8)]]);
  const credentialKeys = new Map([
    ["credential-v1", new Uint8Array(32).fill(21)],
  ]);
  const provider = {
    approved: true as const,
    environment: "sandbox" as const,
    parentAccountReference: "fictional-parent",
    policyVersion: scope.policyVersion,
    createClient: vi.fn(
      (context: {
        provider: "ASAAS";
        siteId: string;
        accountBindingId: string;
        environment: "sandbox" | "live";
      }) =>
        createAsaasAccountProvisioningClient({
          environment: context.environment,
          parentAccountReference: "fictional-parent",
          parentCredential: "fictional-parent-key",
          credentialContext: context,
          credentialKeys,
          activeCredentialKeyId: "credential-v1",
          fetch: fetchOriginal as unknown as typeof fetch,
          normalizeOriginalResult: async () => ({
            accountReference: "fictional-child",
            recipientReference: "fictional-wallet",
            credential: "fictional-child-key",
          }),
        }),
    ),
  };
  const options = {
    repository: repository as never,
    readProvider: vi.fn(async () => provider),
    fingerprintKeys,
    activeFingerprintKeyId: "fp-v1",
    now: () => new Date(now),
    generateId: vi.fn((kind: string) => `${kind}-one`),
  };
  const command = {
    action: "CREATE" as const,
    nomination,
    input,
    authorization,
    confirmNativeCreation: true as const,
  };
  return {
    now,
    nomination,
    input,
    authorization,
    repository,
    controls,
    fetchOriginal,
    fingerprintKeys,
    options,
    provider,
    command,
    getRecord: () => record,
    getState: () => state,
  };
}
describe("completion-owned original account provisioning", () => {
  it("configuration getter failure cannot expose a private error or read a provider", async () => {
    const values = fixture();
    Object.defineProperty(values.options, "generateId", {
      get: () => {
        throw new Error("private generator configuration");
      },
    });
    let service:
      | ReturnType<typeof createReceivingAccountProvisioning>
      | undefined;
    expect(() => {
      service = createReceivingAccountProvisioning(values.options);
    }).not.toThrow();
    expect((await service?.begin(values.command).feedback)?.state).toBe(
      "UNAVAILABLE",
    );
    expect(values.options.readProvider).not.toHaveBeenCalled();
    await service?.close();
  });
  it("unsupported configuration is unavailable without DB/provider/secret work", async () => {
    const values = fixture();
    const service = createReceivingAccountProvisioning();
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("UNAVAILABLE");
    await owner.completion;
    await service.close();
    expect(values.repository.claimOriginal).not.toHaveBeenCalled();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
  });
  it("pins a versioned HKDF/HMAC identity over exact original scope and normalized input", () => {
    const values = fixture();
    const context = deriveReceivingProvisioningContext(
      values.nomination,
      "fictional-parent",
      "fp-v1",
      values.input,
      values.fingerprintKeys,
    );
    const derived = hkdfSync(
      "sha256",
      new Uint8Array(32).fill(8),
      Buffer.from("entrelacos.receiving-provisioning.hkdf.v1"),
      Buffer.from("entrelacos.receiving-provisioning.input-fingerprint.v1"),
      32,
    );
    const expected = createHmac("sha256", Buffer.from(derived))
      .update(
        JSON.stringify([
          "entrelacos.receiving-provisioning.input.v1",
          "hkdf-hmac-sha256-v1",
          "fp-v1",
          "ASAAS",
          "site-one",
          "account-one",
          "operation-one",
          "request-one",
          values.nomination.requestHash,
          "operator-one",
          "sandbox",
          "policy-one",
          "fictional-parent",
          "Fictional Operator",
          "fictional@example.test",
          "12345678909",
          "11999999999",
          1000,
          "Fictional Street",
          "1",
          "Fictional District",
          "12345678",
          "1990-01-01",
        ]),
      )
      .digest("hex");
    expect(context.inputFingerprint).toBe(expected);
    expect(JSON.stringify(context)).not.toMatch(
      /Fictional Operator|12345678909|fictional@example/,
    );
    expect(
      deriveReceivingProvisioningContext(
        values.nomination,
        "other-parent",
        "fp-v1",
        values.input,
        values.fingerprintKeys,
      ).inputFingerprint,
    ).not.toBe(expected);
    expect(() =>
      deriveReceivingProvisioningContext(
        values.nomination,
        "fictional-parent",
        "missing",
        values.input,
        values.fingerprintKeys,
      ),
    ).toThrow();
  });
  it("creates exactly once, preserves identity and atomically attaches only the original envelope", async () => {
    const values = fixture();
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    const prepared = values.repository.quarantineOriginal.mock.calls[0][1];
    expect(values.repository.attachOriginal.mock.calls[0][1]).toBe(prepared);
    expect(values.getRecord()?.nomination).toEqual(values.nomination);
    expect(values.getRecord()?.sealedResult).toBeNull();
    const repeated = service.begin(values.command);
    expect((await repeated.feedback).state).not.toBe("STORED");
    await repeated.completion;
    await service.close();
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
  });
  it("concurrent owners cannot acquire another original claim", async () => {
    const values = fixture();
    const service = createReceivingAccountProvisioning(values.options);
    const first = service.begin(values.command);
    const second = service.begin(values.command);
    await Promise.all([first.completion, second.completion]);
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    expect(values.getState()).toBe("SUCCEEDED");
    await service.close();
  });
  it("lost claim acknowledgement never grants confirmation or dispatch", async () => {
    const values = fixture();
    values.controls.claimLostAck = true;
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    await owner.completion;
    expect(
      values.repository.confirmOriginalArmForDispatch,
    ).not.toHaveBeenCalled();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
    expect(values.getState()).toBe("CLAIMED");
    await service.close();
  });
  it.each([false, true])(
    "original arm ACK loss uses fresh current confirmation; denied=%s",
    async (denied) => {
      const values = fixture();
      values.controls.armLostAck = true;
      values.controls.confirmationDenied = denied;
      const service = createReceivingAccountProvisioning(values.options);
      const owner = service.begin(values.command);
      await owner.completion;
      expect(
        values.repository.confirmOriginalArmForDispatch,
      ).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ nomination: values.nomination }),
        expect.objectContaining({ actor: values.authorization.actor }),
      );
      expect(values.fetchOriginal).toHaveBeenCalledTimes(denied ? 0 : 1);
      await service.close();
    },
  );
  it("revocation during actual create retains original capsule without attachment or another create", async () => {
    const values = fixture();
    values.controls.attachmentDenied = true;
    const response = deferred<Response>();
    values.fetchOriginal.mockImplementation(() => response.promise);
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    await flush();
    expect(values.getState()).toBe("UNKNOWN");
    response.resolve(new Response("{}", { status: 201 }));
    await owner.completion;
    expect(values.getRecord()?.sealedResult?.credential).toBeDefined();
    expect((await owner.feedback).state).toBe("UNKNOWN");
    const repeated = service.begin(values.command);
    await repeated.completion;
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    await service.close();
  });
  it("close retains actual late transport and quarantine commit after cancellation", async () => {
    const values = fixture();
    const response = deferred<Response>();
    const commit = deferred();
    values.fetchOriginal.mockImplementation(() => response.promise);
    const write = values.repository.quarantineOriginal.getMockImplementation();
    if (!write) throw new Error("Missing synthetic custody writer");
    values.repository.quarantineOriginal.mockImplementation(
      async (claim, result) => {
        await commit.promise;
        return write(claim, result);
      },
    );
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    await flush();
    owner.cancel();
    const closing = service.close();
    expect(service.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    response.resolve(new Response("{}", { status: 201 }));
    await flush();
    expect(closed).toBe(false);
    expect(values.repository.attachOriginal).not.toHaveBeenCalled();
    commit.resolve();
    await owner.completion;
    await closing;
    expect(values.getRecord()?.sealedResult).not.toBeNull();
    expect(closed).toBe(true);
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
  });
  it.each(["quarantineLostAck", "attachLostAck"] as const)(
    "lost %s consults the same prepared envelope without another native request",
    async (caseName) => {
      const values = fixture();
      values.controls[caseName] = true;
      const service = createReceivingAccountProvisioning(values.options);
      const owner = service.begin(values.command);
      expect((await owner.feedback).state).toBe("STORED");
      await owner.completion;
      const prepared = values.repository.quarantineOriginal.mock.calls[0][1];
      expect(
        values.repository.consultOriginal.mock.calls.some(
          (call) => call[1] === prepared,
        ),
      ).toBe(true);
      expect(values.fetchOriginal).toHaveBeenCalledOnce();
      await service.close();
    },
  );
  it("unavailable acknowledgement consultation retains UNKNOWN and cannot rearm", async () => {
    const values = fixture();
    values.controls.quarantineLostAck = true;
    values.controls.consultedUncertain = true;
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    await owner.completion;
    expect((await owner.feedback).state).toBe("UNKNOWN");
    expect(values.repository.attachOriginal).not.toHaveBeenCalled();
    const retry = service.begin(values.command);
    await retry.completion;
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    await service.close();
  });
  it("expired original result can be settled with a new authorized caller without dispatch", async () => {
    const values = fixture();
    values.controls.attachmentDenied = true;
    const service = createReceivingAccountProvisioning(values.options);
    const first = service.begin(values.command);
    await first.completion;
    const claim = values.getRecord();
    if (!claim) throw new Error("Missing original stored claim");
    values.controls.attachmentDenied = false;
    values.now.setTime(values.now.getTime() + 120000);
    const settlement = service.begin({
      ...values.command,
      action: "SETTLE",
      record: claim,
    });
    expect((await settlement.feedback).state).toBe("STORED");
    await settlement.completion;
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    expect(values.repository.armOriginal).toHaveBeenCalledOnce();
    await service.close();
  });
  it("changed resupplied private input cannot settle a retained original capsule", async () => {
    const values = fixture();
    values.controls.attachmentDenied = true;
    const service = createReceivingAccountProvisioning(values.options);
    await service.begin(values.command).completion;
    const claim = values.getRecord();
    if (!claim) throw new Error("Missing original stored claim");
    values.controls.attachmentDenied = false;
    const calls = values.repository.attachOriginal.mock.calls.length;
    const settlement = service.begin({
      ...values.command,
      action: "SETTLE",
      record: claim,
      input: { ...values.input, addressNumber: "2" },
    });
    await settlement.completion;
    expect(values.repository.attachOriginal).toHaveBeenCalledTimes(calls);
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    await service.close();
  });
  it("cancelled settlement preserves original UNKNOWN feedback and never dispatches", async () => {
    const values = fixture();
    values.controls.attachmentDenied = true;
    const service = createReceivingAccountProvisioning(values.options);
    await service.begin(values.command).completion;
    const record = values.getRecord();
    if (!record) throw new Error("Missing original result");
    const lookup = deferred<{
      record: ReceivingProvisioningRecord;
      state: string;
      result: ReceivingProvisioningResult | null;
    }>();
    values.repository.consultOriginal.mockImplementation(() => lookup.promise);
    const owner = service.begin({
      ...values.command,
      action: "SETTLE",
      record,
    });
    await flush();
    owner.cancel();
    try {
      expect((await owner.feedback).state).toBe("UNKNOWN");
    } finally {
      lookup.resolve({ record, state: "UNKNOWN", result: record.sealedResult });
      await owner.completion;
      await service.close();
    }
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
  });
  it("settlement never adopts a conflicting capsule over a retained original envelope", async () => {
    const values = fixture();
    values.controls.attachmentDenied = true;
    const service = createReceivingAccountProvisioning(values.options);
    await service.begin(values.command).completion;
    const record = values.getRecord();
    if (!record?.sealedResult) throw new Error("Missing original capsule");
    values.controls.attachmentDenied = false;
    const conflicting = {
      ...record,
      sealedResult: {
        ...record.sealedResult,
        accountReference: "foreign-child",
      },
    };
    const count = values.repository.attachOriginal.mock.calls.length;
    const owner = service.begin({
      ...values.command,
      action: "SETTLE",
      record: conflicting,
    });
    await owner.completion;
    expect((await owner.feedback).state).toBe("UNKNOWN");
    expect(values.repository.attachOriginal).toHaveBeenCalledTimes(count);
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    await service.close();
  });
  it("caller deadline never settles actual transport or prevents original late-result custody", async () => {
    vi.useFakeTimers();
    const values = fixture();
    const response = deferred<Response>();
    values.fetchOriginal.mockImplementation(() => response.promise);
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    let complete = false;
    void owner.completion.then(() => {
      complete = true;
    });
    try {
      await flush();
      await vi.advanceTimersByTimeAsync(45000);
      expect((await owner.feedback).state).toBe("UNKNOWN");
      expect(complete).toBe(false);
      response.resolve(new Response("{}", { status: 201 }));
      await owner.completion;
      expect(values.getRecord()?.sealedResult).not.toBeNull();
      expect(values.repository.attachOriginal).not.toHaveBeenCalled();
      expect(values.fetchOriginal).toHaveBeenCalledOnce();
    } finally {
      response.resolve(new Response("{}", { status: 201 }));
      await owner.completion;
      await service.close();
      vi.useRealTimers();
    }
  });
});
