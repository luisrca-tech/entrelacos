import { createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { receivingProviderRejectionSchema } from "@entrelacos/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeObservabilityEvent } from "./observability";
import { createPagarmeRecipientClient } from "./pagarmeRecipientClient";
import {
  createReceivingAccountProvisioning,
  deriveReceivingFingerprintKey,
  deriveReceivingProvisioningContext,
  RECEIVING_FINGERPRINT_KEY_ID,
  ReceivingAccountProvisioningError,
} from "./receivingAccountProvisioning";
import {
  type ReceivingProvisioningRecord,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";
import { ReceivingProviderRejectedError } from "./receivingSetup";

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
    cpf: "12345678909",
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
      holderName: "MARIA DA SILVA",
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
  let attempts = 0;
  let lastErrorCode: string | null = null;
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
              ...(attempts > 0 ? { attempt: attempts + 1 } : {}),
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
    releaseOriginal: vi.fn(
      async (claim: ReceivingProvisioningRecord, reason: string) => {
        if (
          state !== "UNKNOWN" ||
          !record ||
          record.sealedResult !== null ||
          !claim.provision.dispatch.possibleDispatch
        )
          throw new Error("release refused");
        attempts = claim.provision.dispatch.attempt ?? 1;
        lastErrorCode = reason;
        record = undefined;
        state = "REQUESTED";
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
    getAttempts: () => attempts,
    getLastErrorCode: () => lastErrorCode,
  };
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const rejectionBody = {
  message: "Recebedor inválido para 'MARIA DA SILVA'",
  errors: {
    "register_information.birthdate": [
      "The field birthdate must be dd/mm/yyyy, got 1990-04-12.",
    ],
    "register_information.phone_numbers": [
      "Phone 21994647568 of MARIA DA SILVA is invalid",
    ],
  },
};
async function settleUnknown(values: ReturnType<typeof fixture>) {
  values.fetchOriginal.mockImplementationOnce(async () => json(500, {}));
  const service = createReceivingAccountProvisioning(values.options);
  const owner = service.begin(values.command);
  expect((await owner.feedback).state).toBe("UNKNOWN");
  await owner.completion;
  await service.close();
  expect(values.getState()).toBe("UNKNOWN");
  const record = values.getRecord();
  if (!record) throw new Error("missing armed record");
  values.fetchOriginal.mockReset();
  return record;
}
describe("definitive Pagar.me rejection", () => {
  it.each([400, 412, 422])(
    "releases the dispatch and reports a %s as a retryable refusal",
    async (status) => {
      const values = fixture();
      values.fetchOriginal.mockImplementationOnce(async () =>
        json(status, rejectionBody),
      );
      const service = createReceivingAccountProvisioning({
        ...values.options,
        observe: () => {},
      });
      const owner = service.begin(values.command);
      const feedback = await owner.feedback;
      await owner.completion;
      expect(feedback.state).toBe("REJECTED");
      expect(feedback.rejection?.status).toBe(status);
      expect(feedback.rejection?.fields.map((field) => field.field)).toEqual([
        "register_information.birthdate",
        "register_information.phone_numbers",
      ]);
      const exposed = JSON.stringify(feedback.rejection);
      for (const value of ["MARIA", "SILVA", "21994647568", "1990-04-12"])
        expect(exposed).not.toContain(value);
      expect(values.repository.releaseOriginal).toHaveBeenCalledOnce();
      const [released, reason] =
        values.repository.releaseOriginal.mock.calls[0];
      expect(reason).toBe("PROVIDER_REJECTED");
      expect(released.provision.dispatch.possibleDispatch).toBe(true);
      expect(values.repository.quarantineOriginal).not.toHaveBeenCalled();
      expect(values.repository.attachOriginal).not.toHaveBeenCalled();
      expect(values.getState()).toBe("REQUESTED");

      // The corrected resubmission dispatches again with a new key.
      values.fetchOriginal.mockImplementationOnce(async () => created());
      const retry = service.begin(values.command);
      expect((await retry.feedback).state).toBe("STORED");
      await retry.completion;
      await service.close();
      expect(values.fetchOriginal).toHaveBeenCalledTimes(2);
      const [, init] = values.fetchOriginal.mock.calls[1];
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        "recipient:account-one:2",
      );
      expect(JSON.parse(String(init?.body)).code).toBe("account-one");
    },
  );

  it.each([401, 403, 404, 409, 429, 500, 503])(
    "keeps a %s uncertain without releasing the dispatch",
    async (status) => {
      const values = fixture();
      values.fetchOriginal.mockImplementationOnce(async () =>
        json(status, rejectionBody),
      );
      const service = createReceivingAccountProvisioning({
        ...values.options,
        observe: () => {},
      });
      const owner = service.begin(values.command);
      expect((await owner.feedback).state).toBe("UNKNOWN");
      await owner.completion;
      await service.close();
      expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
      expect(values.getState()).toBe("UNKNOWN");
    },
  );

  it("stays uncertain when the rejected dispatch cannot be released", async () => {
    const values = fixture();
    values.fetchOriginal.mockImplementationOnce(async () =>
      json(412, rejectionBody),
    );
    values.repository.releaseOriginal.mockRejectedValueOnce(
      new Error("private release failure"),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    await service.close();
  });
});
describe("reconciling an armed dispatch without a stored result", () => {
  function reconcile(
    values: ReturnType<typeof fixture>,
    record: ReceivingProvisioningRecord,
  ) {
    return { ...values.command, action: "RECONCILE" as const, record };
  }
  const listed = (items: unknown[]) =>
    json(200, { data: items, paging: { total: items.length } });
  const platform = {
    id: "rp_platformRecipient",
    code: "platform",
    status: "active",
  };

  it("attaches the recipient Pagar.me already holds under the account code", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal
      .mockImplementationOnce(async () =>
        listed([
          platform,
          {
            id: "rp_fixtureRecipient01",
            code: "account-one",
            status: "registration",
          },
        ]),
      )
      .mockImplementationOnce(async () => created());
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(reconcile(values, record));
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(
      values.fetchOriginal.mock.calls.every(
        ([, init]) => init?.method === "GET",
      ),
    ).toBe(true);
    expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
    expect(values.repository.attachOriginal.mock.calls.at(-1)?.[1]).toEqual({
      accountReference: "rp_fixtureRecipient01",
      recipientReference: "rp_fixtureRecipient01",
    });
  });

  it("releases a dispatch Pagar.me confirms absent and creates again with the next key", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal
      .mockImplementationOnce(async () => listed([platform]))
      .mockImplementationOnce(async () => created());
    const service = createReceivingAccountProvisioning(values.options);
    const owner = service.begin(reconcile(values, record));
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(values.repository.releaseOriginal).toHaveBeenCalledOnce();
    expect(values.repository.releaseOriginal.mock.calls[0][1]).toBe(
      "PROVIDER_ABSENT",
    );
    const posts = values.fetchOriginal.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(new Headers(posts[0][1]?.headers).get("idempotency-key")).toBe(
      "recipient:account-one:2",
    );
  });

  it.each([
    ["a failed consultation", async () => json(500, {})],
    ["a rejected consultation", async () => json(429, {})],
  ])(
    "stays uncertain after %s without releasing or creating",
    async (_label, answer) => {
      const values = fixture();
      const record = await settleUnknown(values);
      values.fetchOriginal.mockImplementation(answer);
      const service = createReceivingAccountProvisioning({
        ...values.options,
        observe: () => {},
      });
      const owner = service.begin(reconcile(values, record));
      expect((await owner.feedback).state).toBe("UNKNOWN");
      await owner.completion;
      await service.close();
      expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
      expect(
        values.fetchOriginal.mock.calls.some(
          ([, init]) => init?.method === "POST",
        ),
      ).toBe(false);
    },
  );

  it("stays uncertain when the release is refused, so it never creates", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal.mockImplementation(async () => listed([platform]));
    values.repository.releaseOriginal.mockRejectedValueOnce(
      new Error("lease still live"),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const owner = service.begin(reconcile(values, record));
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    await service.close();
    expect(
      values.fetchOriginal.mock.calls.some(
        ([, init]) => init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("never reconciles a record that already holds a sealed result", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    const sealed = readReceivingProvisioningRecord({
      ...record,
      sealedResult: {
        accountReference: "rp_fixtureRecipient01",
        recipientReference: "rp_fixtureRecipient01",
      },
    });
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const owner = service.begin(reconcile(values, sealed));
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    await service.close();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
    expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
  });
});
describe("verifying an uncertain dispatch without recipient input", () => {
  const listed = (items: unknown[]) =>
    json(200, { data: items, paging: { total: items.length } });
  const platform = {
    id: "rp_platformRecipient",
    code: "platform",
    status: "active",
  };
  function verify(
    values: ReturnType<typeof fixture>,
    record: ReceivingProvisioningRecord,
  ) {
    return {
      action: "VERIFY" as const,
      nomination: values.nomination,
      authorization: values.authorization,
      confirmNativeCreation: true as const,
      record,
    };
  }
  /** A clock this many minutes after the dispatch lease ended. */
  function afterLease(record: ReceivingProvisioningRecord, minutes: number) {
    const leaseEnd =
      Number(BigInt(record.provision.dispatch.leaseExpiresAtMicroseconds)) /
      1000;
    return () => new Date(leaseEnd + minutes * 60_000);
  }
  /** Verifies with a clock past the absence window, without logging. */
  function verifier(
    values: ReturnType<typeof fixture>,
    record: ReceivingProvisioningRecord,
  ) {
    return createReceivingAccountProvisioning({
      ...values.options,
      now: afterLease(record, 7),
      observe: () => {},
    });
  }
  const posts = (values: ReturnType<typeof fixture>) =>
    values.fetchOriginal.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );

  it("demo-wedding: releases an UNKNOWN 412 dispatch Pagar.me never received, then the next submit creates exactly one recipient with key :2", async () => {
    const values = fixture();
    // Before #89 a 412 left the armed dispatch UNKNOWN: emulate the release
    // that never happened.
    values.fetchOriginal.mockImplementationOnce(async () =>
      json(412, rejectionBody),
    );
    values.repository.releaseOriginal.mockRejectedValueOnce(
      new Error("pre-#89 kept the dispatch uncertain"),
    );
    const original = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const first = original.begin(values.command);
    expect((await first.feedback).state).toBe("UNKNOWN");
    await first.completion;
    await original.close();
    const record = values.getRecord();
    if (!record) throw new Error("missing armed record");
    expect(values.getState()).toBe("UNKNOWN");
    expect(record.provision.dispatch.possibleDispatch).toBe(true);
    expect(record.provision.dispatch.attempt).toBeUndefined();
    expect(record.sealedResult).toBeNull();
    values.fetchOriginal.mockReset();
    values.repository.releaseOriginal.mockClear();

    // "Verificar situação": the list holds only the platform recipient.
    values.fetchOriginal.mockImplementation(async () => listed([platform]));
    const verification = verifier(values, record);
    const verified = verification.begin(verify(values, record));
    expect(await verified.feedback).toMatchObject({ state: "RELEASED" });
    await verified.completion;
    await verification.close();
    expect(posts(values)).toHaveLength(0);
    expect(
      values.fetchOriginal.mock.calls.every(
        ([, init]) => init?.method === "GET",
      ),
    ).toBe(true);
    expect(values.repository.releaseOriginal).toHaveBeenCalledOnce();
    expect(values.repository.releaseOriginal.mock.calls[0][1]).toBe(
      "PROVIDER_ABSENT",
    );
    expect(values.getState()).toBe("REQUESTED");
    expect(values.getAttempts()).toBe(1);
    expect(values.getLastErrorCode()).toBe("PROVIDER_ABSENT");

    // The holder's next submit dispatches once, with the next attempt key.
    values.fetchOriginal.mockReset();
    values.fetchOriginal.mockImplementation(async () => created());
    const submitting = createReceivingAccountProvisioning(values.options);
    const submit = submitting.begin(values.command);
    expect((await submit.feedback).state).toBe("STORED");
    await submit.completion;
    await submitting.close();
    expect(posts(values)).toHaveLength(1);
    expect(
      new Headers(posts(values)[0][1]?.headers).get("idempotency-key"),
    ).toBe("recipient:account-one:2");
  });

  it("binds the recipient Pagar.me holds under the account code without creating one", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal
      .mockImplementationOnce(async () =>
        listed([
          platform,
          {
            id: "rp_fixtureRecipient01",
            code: "account-one",
            status: "registration",
          },
        ]),
      )
      .mockImplementationOnce(async () => created());
    const service = verifier(values, record);
    const owner = service.begin(verify(values, record));
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(posts(values)).toHaveLength(0);
    expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
    expect(values.repository.attachOriginal.mock.calls.at(-1)?.[1]).toEqual({
      accountReference: "rp_fixtureRecipient01",
      recipientReference: "rp_fixtureRecipient01",
    });
    expect(values.getState()).toBe("SUCCEEDED");
  });

  it("needs no recipient creation capability at all", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal.mockImplementation(async () => listed([platform]));
    const createRecipient = vi.fn();
    const service = createReceivingAccountProvisioning({
      ...values.options,
      now: afterLease(record, 7),
      observe: () => {},
      readProvider: async () => ({
        ...values.provider,
        recipients: {
          findRecipientByCode: values.provider.recipients.findRecipientByCode,
          createRecipient,
        },
      }),
    });
    const owner = service.begin(verify(values, record));
    expect((await owner.feedback).state).toBe("RELEASED");
    await owner.completion;
    await service.close();
    expect(createRecipient).not.toHaveBeenCalled();
  });

  it.each([
    ["a failed consultation", async () => json(500, {})],
    ["a refused consultation", async () => json(429, {})],
    ["an unexpected list shape", async () => json(200, { data: "none" })],
    [
      "an incomplete pagination",
      async () => json(200, { data: [platform], paging: { total: 9999 } }),
    ],
  ])(
    "stays UNKNOWN as PROVIDER_UNREACHABLE after %s, releasing and creating nothing",
    async (_label, answer) => {
      const values = fixture();
      const record = await settleUnknown(values);
      values.fetchOriginal.mockImplementation(answer);
      const service = verifier(values, record);
      const owner = service.begin(verify(values, record));
      expect(await owner.feedback).toMatchObject({
        state: "UNKNOWN",
        reason: "PROVIDER_UNREACHABLE",
      });
      await owner.completion;
      await service.close();
      expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
      expect(posts(values)).toHaveLength(0);
      expect(values.getState()).toBe("UNKNOWN");
    },
  );

  it("stays UNKNOWN as WINDOW_NOT_ELAPSED before the absence window, without asking Pagar.me", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    const service = createReceivingAccountProvisioning({
      ...values.options,
      now: afterLease(record, 4),
      observe: () => {},
    });
    const owner = service.begin(verify(values, record));
    expect(await owner.feedback).toMatchObject({
      state: "UNKNOWN",
      reason: "WINDOW_NOT_ELAPSED",
    });
    await owner.completion;
    await service.close();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
    expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
    expect(values.getState()).toBe("UNKNOWN");
  });

  it("lets only one of two concurrent verifications release; the other stays UNKNOWN as STATE_CHANGED", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal.mockImplementation(async () => listed([platform]));
    const service = verifier(values, record);
    const left = service.begin(verify(values, record));
    const right = service.begin(verify(values, record));
    const outcomes = await Promise.all([left.feedback, right.feedback]);
    await Promise.all([left.completion, right.completion]);
    await service.close();
    expect(outcomes.map((outcome) => outcome.state).sort()).toEqual([
      "RELEASED",
      "UNKNOWN",
    ]);
    expect(
      outcomes.find((outcome) => outcome.state === "UNKNOWN"),
    ).toMatchObject({ reason: "STATE_CHANGED" });
    expect(values.repository.releaseOriginal).toHaveBeenCalledTimes(2);
    expect(values.getState()).toBe("REQUESTED");
    expect(values.getAttempts()).toBe(1);
    expect(posts(values)).toHaveLength(0);
  });

  it("creates at most one recipient when a verification races a submit of the same dispatch", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    values.fetchOriginal.mockImplementation(async (_url, init) =>
      init?.method === "POST" ? created() : listed([platform]),
    );
    const verification = verifier(values, record);
    const submitting = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const verified = verification.begin(verify(values, record));
    const submitted = submitting.begin({
      ...values.command,
      action: "RECONCILE" as const,
      record,
    });
    const [verifyOutcome, submitOutcome] = await Promise.all([
      verified.feedback,
      submitted.feedback,
    ]);
    await Promise.all([verified.completion, submitted.completion]);
    await Promise.all([verification.close(), submitting.close()]);
    expect(values.repository.releaseOriginal).toHaveBeenCalledTimes(2);
    expect(posts(values).length).toBeLessThanOrEqual(1);
    if (verifyOutcome.state === "RELEASED") {
      expect(submitOutcome.state).toBe("UNKNOWN");
      expect(posts(values)).toHaveLength(0);
      expect(values.getState()).toBe("REQUESTED");
    } else {
      expect(verifyOutcome).toMatchObject({
        state: "UNKNOWN",
        reason: "STATE_CHANGED",
      });
      expect(submitOutcome.state).toBe("STORED");
      expect(posts(values)).toHaveLength(1);
      expect(
        new Headers(posts(values)[0][1]?.headers).get("idempotency-key"),
      ).toBe("recipient:account-one:2");
    }
  });

  it("never verifies a record that already holds a sealed result", async () => {
    const values = fixture();
    const record = await settleUnknown(values);
    const sealed = readReceivingProvisioningRecord({
      ...record,
      sealedResult: {
        accountReference: "rp_fixtureRecipient01",
        recipientReference: "rp_fixtureRecipient01",
      },
    });
    const service = verifier(values, sealed);
    const owner = service.begin(verify(values, sealed));
    expect((await owner.feedback).state).toBe("UNKNOWN");
    await owner.completion;
    await service.close();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
    expect(values.repository.releaseOriginal).not.toHaveBeenCalled();
  });
});
describe("rejection details within the contract", () => {
  it("bounds each sanitized field message so the refusal stays RECEIVING_PROVIDER_REJECTED", async () => {
    const values = fixture();
    // Each echoed "ana" grows to "[valor]" after the input redaction.
    const input = { ...values.input, name: "ANA LUZ" };
    values.fetchOriginal.mockImplementationOnce(async () =>
      json(412, {
        message: `${"ana ".repeat(80)}`,
        errors: { "register_information.name": ["ana ".repeat(50)] },
      }),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe: () => {},
    });
    const owner = service.begin({ ...values.command, input });
    const feedback = await owner.feedback;
    await owner.completion;
    await service.close();
    expect(feedback.state).toBe("REJECTED");
    const rejection = feedback.rejection;
    if (!rejection) throw new Error("missing rejection");
    expect(rejection.fields[0].messages[0].length).toBeLessThanOrEqual(240);
    expect(rejection.fields[0].messages[0]).not.toMatch(/ana/i);
    expect((rejection.message ?? "").length).toBeLessThanOrEqual(300);
    const error = new ReceivingProviderRejectedError(
      receivingProviderRejectionSchema.parse({
        message: rejection.message,
        fields: rejection.fields,
      }),
    );
    expect(error.code).toBe("RECEIVING_PROVIDER_REJECTED");
    expect(error.status).toBe(422);
  });
});
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
          "entrelacos.receiving-provisioning.input.v3",
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
          "12345678909",
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
          "MARIA DA SILVA",
          "checking",
        ]),
      )
      .digest("hex");
    expect(context.provider).toBe("PAGARME");
    expect(context.inputFingerprint).toBe(expected);
    expect(JSON.stringify(context)).not.toMatch(
      /MARIA|12345678909|maria@example|12345/,
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
        document: "12345678909",
        birthdate: "12/04/1990",
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
        holder_document: "12345678909",
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

describe("provisioning failure observability", () => {
  const PII = [
    "MARIA",
    "maria@example.test",
    "12345678909",
    "21994647568",
    "General Justo",
    "20021130",
    "12345",
    "sk_test",
    "token-one",
    "session-one",
  ];
  function expectNoPii(observe: ReturnType<typeof vi.fn>) {
    const logged = JSON.stringify(observe.mock.calls);
    for (const value of PII) expect(logged).not.toContain(value);
    for (const [event] of observe.mock.calls)
      expect(sanitizeObservabilityEvent(event)).toEqual(event);
  }

  it("records the refused claim stage without personal data", async () => {
    const values = fixture();
    const observe = vi.fn();
    values.repository.claimOriginal.mockRejectedValueOnce(
      new ReceivingAccountProvisioningError(),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe,
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("UNAVAILABLE");
    await owner.completion;
    await service.close();
    expect(values.fetchOriginal).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      level: "warn",
      event: "receiving.provisioning.failed",
      operation: "claim",
      result: "unavailable",
      errorCode: "ReceivingAccountProvisioningError",
      siteId: "site-one",
    });
    expectNoPii(observe);
  });

  it("records a Pagar.me rejection with its status, code and redacted reason", async () => {
    const values = fixture();
    const observe = vi.fn();
    values.fetchOriginal.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                type: "invalid_document",
                message: "CPF 12345678909 of MARIA DA SILVA is invalid",
              },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe,
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("REJECTED");
    await owner.completion;
    await service.close();
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      level: "warn",
      event: "receiving.provisioning.failed",
      operation: "create_recipient",
      result: "rejected",
      errorCode: "PagarmeRejectedError",
      siteId: "site-one",
      status: 422,
      providerCode: "invalid_document",
      providerMessage: "CPF [número] of [valor] is invalid",
    });
    expectNoPii(observe);
  });

  it("logs the field paths of a 412 without echoed personal data", async () => {
    const values = fixture();
    const observe = vi.fn();
    values.fetchOriginal.mockImplementation(async () =>
      json(412, {
        message: "Dados de Rio de Janeiro, Av. General Justo inválidos",
        errors: {
          "register_information.address.street": [
            "Street Av. General Justo is invalid",
          ],
          "register_information.name": ["Name Maria da Silva is invalid"],
          "default_bank_account.account_number": ["12345 is invalid"],
        },
      }),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe,
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("REJECTED");
    await owner.completion;
    await service.close();
    const [event] = observe.mock.calls[0];
    expect(event).toMatchObject({
      operation: "create_recipient",
      result: "rejected",
      status: 412,
    });
    expect(event.providerFields).toEqual([
      expect.stringMatching(/^register_information\.address\.street: /),
      expect.stringMatching(/^register_information\.name: /),
      expect.stringMatching(/^default_bank_account\.account_number: /),
    ]);
    const logged = JSON.stringify(observe.mock.calls);
    for (const value of ["Maria", "Silva", "General Justo", "Rio de Janeiro"])
      expect(logged).not.toContain(value);
    expectNoPii(observe);
  });

  it("flags Pagar.me's platform anticipation permission 412 for the operator", async () => {
    const values = fixture();
    const observe = vi.fn();
    values.fetchOriginal.mockImplementation(async () =>
      json(412, {
        message:
          "The recipient could not be created : action_forbidden | | this company doesn't have permission to change the anticipation parameters from default values",
      }),
    );
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe,
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("REJECTED");
    await owner.completion;
    await service.close();
    expect(values.repository.releaseOriginal).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    const [[failed], [denied]] = observe.mock.calls;
    expect(failed).toMatchObject({
      level: "warn",
      event: "receiving.provisioning.failed",
      operation: "create_recipient",
      result: "rejected",
      status: 412,
    });
    expect(denied).toEqual({
      ...failed,
      level: "error",
      event: "pagarme_recipient_platform_permission_denied",
    });
    expect(denied.providerMessage).toMatch(/action_forbidden/);
    expectNoPii(observe);
  });

  it("records a recovered attachment failure before consulting the stored result", async () => {
    const values = fixture();
    const observe = vi.fn();
    values.controls.attachLostAck = true;
    const service = createReceivingAccountProvisioning({
      ...values.options,
      observe,
    });
    const owner = service.begin(values.command);
    expect((await owner.feedback).state).toBe("STORED");
    await owner.completion;
    await service.close();
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      level: "warn",
      event: "receiving.provisioning.failed",
      operation: "attach",
      result: "recovering",
      errorCode: "Error",
      siteId: "site-one",
    });
    expectNoPii(observe);
  });
});
