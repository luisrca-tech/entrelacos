import { createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPagarmeRecipientClient } from "./pagarmeRecipientClient";
import {
  createReceivingAccountProvisioning,
  deriveReceivingFingerprintKey,
  deriveReceivingProvisioningContext,
  RECEIVING_FINGERPRINT_KEY_ID,
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
const createdRecipient = readFileSync(
  new URL("./__fixtures__/pagarme/recipient-created.json", import.meta.url),
  "utf8",
).replace('"code": "receiving-account-1"', '"code": "account-one"');
function created() {
  return new Response(createdRecipient, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
    name: "MARIA DA SILVA",
    email: "maria@example.test",
    cpf: "26224451990",
    mobilePhone: "21994647568",
    birthDate: "1990-04-12",
    monthlyIncomeCents: 500000,
    professionalOccupation: "Professora",
    address: {
      street: "Av. General Justo",
      streetNumber: "375",
      neighborhood: "Centro",
      city: "Rio de Janeiro",
      state: "RJ",
      zipCode: "20021130",
      referencePoint: "Ao lado da banca",
    },
    bankAccount: {
      bank: "341",
      branchNumber: "1234",
      branchCheckDigit: "6",
      accountNumber: "12345",
      accountCheckDigit: "6",
      type: "checking" as const,
    },
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
  const fetchOriginal = vi.fn<typeof fetch>(async () => created());
  const fingerprintKeys = new Map([["fp-v1", new Uint8Array(32).fill(8)]]);
  const provider = {
    approved: true as const,
    environment: "sandbox" as const,
    parentAccountReference: "rp_platformRecipient",
    policyVersion: scope.policyVersion,
    recipients: createPagarmeRecipientClient({
      secretKey: "sk_test_fixtureSecret0123456789",
      fetch: fetchOriginal,
    }),
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
  it("pins a versioned HKDF/HMAC identity over exact original scope and normalized recipient input", () => {
    const values = fixture();
    const context = deriveReceivingProvisioningContext(
      values.nomination,
      "rp_platformRecipient",
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
          "entrelacos.receiving-provisioning.input.v2",
          "hkdf-hmac-sha256-v1",
          "fp-v1",
          "PAGARME",
          "site-one",
          "account-one",
          "operation-one",
          "request-one",
          values.nomination.requestHash,
          "operator-one",
          "sandbox",
          "policy-one",
          "rp_platformRecipient",
          "MARIA DA SILVA",
          "maria@example.test",
          "26224451990",
          "21994647568",
          "1990-04-12",
          500000,
          "Professora",
          "Av. General Justo",
          "375",
          null,
          "Centro",
          "Rio de Janeiro",
          "RJ",
          "20021130",
          "Ao lado da banca",
          "341",
          "1234",
          "6",
          "12345",
          "6",
          "checking",
        ]),
      )
      .digest("hex");
    expect(context.provider).toBe("PAGARME");
    expect(context.inputFingerprint).toBe(expected);
    expect(JSON.stringify(context)).not.toMatch(
      /MARIA|26224451990|maria@example|12345/,
    );
    expect(
      deriveReceivingProvisioningContext(
        values.nomination,
        "rp_otherPlatform",
        "fp-v1",
        values.input,
        values.fingerprintKeys,
      ).inputFingerprint,
    ).not.toBe(expected);
    expect(() =>
      deriveReceivingProvisioningContext(
        values.nomination,
        "rp_platformRecipient",
        "missing",
        values.input,
        values.fingerprintKeys,
      ),
    ).toThrow();
  });
  it("derives a stable 32-byte fingerprint key from the application secret", () => {
    const key = deriveReceivingFingerprintKey("application-secret");
    expect(RECEIVING_FINGERPRINT_KEY_ID).toBe("receiving-fingerprint-v1");
    expect(key.byteLength).toBe(32);
    expect(Buffer.from(key)).toEqual(
      Buffer.from(deriveReceivingFingerprintKey("application-secret")),
    );
    expect(Buffer.from(key)).not.toEqual(
      Buffer.from(deriveReceivingFingerprintKey("other-secret")),
    );
  });
  it("creates the Pagar.me recipient with the full individual payload keyed by the account id", async () => {
    const values = fixture();
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(values.fetchOriginal).toHaveBeenCalledOnce();
    const [url, init] = values.fetchOriginal.mock.calls[0];
    expect(String(url)).toMatch(/\/recipients$/);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "recipient:account-one",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      code: "account-one",
      register_information: {
        type: "individual",
        name: "MARIA DA SILVA",
        email: "maria@example.test",
        document: "26224451990",
        birthdate: "1990-04-12T00:00:00",
        monthly_income: 500000,
        professional_occupation: "Professora",
        phone_numbers: [{ ddd: "21", number: "994647568", type: "mobile" }],
        address: {
          street: "Av. General Justo",
          street_number: "375",
          neighborhood: "Centro",
          city: "Rio de Janeiro",
          state: "RJ",
          zip_code: "20021130",
          reference_point: "Ao lado da banca",
        },
      },
      default_bank_account: {
        holder_document: "26224451990",
        bank: "341",
        branch_number: "1234",
        branch_check_digit: "6",
        account_number: "12345",
        account_check_digit: "6",
        type: "checking",
      },
    });
    expect(values.repository.attachOriginal.mock.calls[0][1]).toEqual({
      accountReference: "rp_fixtureRecipient01",
      recipientReference: "rp_fixtureRecipient01",
    });
  });
  it("refuses a recipient whose code is not the receiving account id", async () => {
    const values = fixture();
    values.fetchOriginal.mockImplementation(
      async () =>
        new Response(
          createdRecipient.replace('"code": "account-one"', '"code": "other"'),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    await service.close();
    expect(values.repository.attachOriginal).not.toHaveBeenCalled();
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
    response.resolve(created());
    await owner.completion;
    expect(values.getRecord()?.sealedResult?.recipientReference).toBe(
      "rp_fixtureRecipient01",
    );
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
    response.resolve(created());
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
      input: {
        ...values.input,
        address: { ...values.input.address, streetNumber: "376" },
      },
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
        accountReference: "rp_foreignRecipient",
        recipientReference: "rp_foreignRecipient",
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
      response.resolve(created());
      await owner.completion;
      expect(values.getRecord()?.sealedResult).not.toBeNull();
      expect(values.repository.attachOriginal).not.toHaveBeenCalled();
      expect(values.fetchOriginal).toHaveBeenCalledOnce();
    } finally {
      response.resolve(created());
      await owner.completion;
      await service.close();
      vi.useRealTimers();
    }
  });
});
