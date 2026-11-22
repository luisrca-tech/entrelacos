import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { PagarmeRejectedError } from "./pagarmeHttpClient";
import {
  createReceivingSetupService,
  type ReceivingRecipientObservation,
} from "./receivingSetup";

const actor = {
  userId: "bride-one",
  siteId: "site-one",
  sessionId: "session-one",
};
const holder = {
  id: "holder-one",
  siteId: "site-one",
  environment: "sandbox",
  holderUserId: "bride-one",
  holderName: "Marina",
  consentId: "consent-one",
  consentVersion: receivingSetupConsentVersion,
};
const createdAccount = {
  accountId: "binding-one",
  operatorUserId: actor.userId,
  state: "SUCCEEDED" as const,
  result: {
    accountReference: "rp_fixtureRecipient01",
    recipientReference: "rp_fixtureRecipient01",
  },
};
const kycLink = {
  url: "https://exemplo.com/kyc?token=eyWfwqrnqwrnfoqwntoqwntqw",
  base64QrCode: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHN2Zy8+",
  expiresAt: "2026-11-18T12:20:00.000Z",
};
function fixture() {
  const sessionAuthentication = {
    ...actor,
    proofKind: "SESSION_AUTHENTICATION",
    provenance: "backend",
    verification: "verified",
    authenticatedAt: new Date("2026-10-16T10:00:00Z"),
    expiresAt: new Date("2026-10-23T10:00:00Z"),
  };
  const repository = {
    mode: "sandbox",
    policyVersion: "policy-v1",
    readHolder: vi.fn(async () => holder),
    requireHolder: vi.fn(async () => holder),
    readAccount: vi.fn(async (): Promise<unknown> => null),
    consent: vi.fn(async () => {}),
    designate: vi.fn(async () => {}),
    readSessionAuthentication: vi.fn(async () => sessionAuthentication),
    listHolderCandidates: vi.fn(async () => []),
  };
  const nomination = { accountId: "binding-one", operatorUserId: actor.userId };
  const nominate = vi.fn(async () => nomination);
  const completion = Promise.resolve();
  const begin = vi.fn((_input: unknown) => ({
    feedback: Promise.resolve({ state: "STORED" }),
    completion,
    cancel: vi.fn(),
  }));
  const observe = vi.fn(
    async (): Promise<ReceivingRecipientObservation> => ({
      recipientId: "rp_fixtureRecipient01",
      status: "active",
      observedAt: "2026-11-18T12:00:00.000Z",
    }),
  );
  const recipients = { createKycLink: vi.fn(async () => kycLink) };
  const options = {
    repository,
    nomination: { nominate },
    provisioning: { begin },
    observe,
    recipients,
  } as unknown as Parameters<typeof createReceivingSetupService>[0];
  return {
    repository,
    nominate,
    begin,
    observe,
    recipients,
    service: createReceivingSetupService(options),
  };
}
const input = {
  policyVersion: "policy-v1",
  consentVersion: receivingSetupConsentVersion,
  confirmHolder: true as const,
  consentToProvider: true as const,
  account: {
    name: "Maria da Silva",
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
      accountNumber: "12345",
      accountCheckDigit: "6",
      holderName: "Maria  da Silva",
      type: "checking" as const,
    },
  },
};
const authorization = { actor } as Parameters<
  ReturnType<typeof createReceivingSetupService>["submit"]
>[1];
describe("receiving setup orchestration", () => {
  it("shows a designation as distinct from consent and account creation", async () => {
    const values = fixture();
    expect(await values.service.read(actor)).toMatchObject({
      holder: { userId: "bride-one", name: "Marina" },
      isHolder: true,
      consentRecorded: true,
      accountState: "NOT_CREATED",
      providerStatus: null,
    });
    expect(values.begin).not.toHaveBeenCalled();
    expect(values.observe).not.toHaveBeenCalled();
  });
  it.each([
    ["registration", "ONBOARDING", false],
    ["affiliation", "UNDER_REVIEW", false],
    ["active", "APPROVED", true],
    ["refused", "BLOCKED", false],
    ["suspended", "SUSPENDED", false],
  ] as const)(
    "reports the Pagar.me recipient status %s as %s",
    async (status, accountState, receivingEnabled) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValue(createdAccount);
      values.observe.mockResolvedValueOnce({
        recipientId: "rp_fixtureRecipient01",
        status,
        observedAt: "2026-11-18T12:00:00.000Z",
      });
      expect((await values.service.read(actor)).providerStatus).toEqual({
        recipientStatus: status,
        kycStatus: null,
        kycStatusReason: null,
        accountState,
        receivingEnabled,
        observedAt: "2026-11-18T12:00:00.000Z",
      });
      expect(values.observe).toHaveBeenCalledExactlyOnceWith(
        "site-one",
        createdAccount,
      );
    },
  );
  it.each([
    ["pending", "in_analysis"],
    ["partially_denied", "additional_documents_required"],
    ["approved", null],
    ["denied", "fully_denied"],
    ["unknown", "unknown"],
  ] as const)(
    "reports the Pagar.me identity check %s (%s)",
    async (kycStatus, kycStatusReason) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValue(createdAccount);
      values.observe.mockResolvedValueOnce({
        recipientId: "rp_fixtureRecipient01",
        status: "affiliation",
        kyc: { status: kycStatus, statusReason: kycStatusReason },
        observedAt: "2026-11-18T12:00:00.000Z",
      });
      expect((await values.service.read(actor)).providerStatus).toEqual({
        recipientStatus: "affiliation",
        kycStatus,
        kycStatusReason,
        accountState: "UNDER_REVIEW",
        receivingEnabled: false,
        observedAt: "2026-11-18T12:00:00.000Z",
      });
    },
  );
  it("keeps an unknown provider status unverified without a recipient status", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    values.observe.mockResolvedValueOnce({
      recipientId: "rp_fixtureRecipient01",
      status: "mystery",
      observedAt: "2026-11-18T12:00:00.000Z",
    });
    expect((await values.service.read(actor)).providerStatus).toEqual({
      recipientStatus: null,
      kycStatus: null,
      kycStatusReason: null,
      accountState: "UNVERIFIED",
      receivingEnabled: false,
      observedAt: "2026-11-18T12:00:00.000Z",
    });
  });
  it("never reports the status of another recipient", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    values.observe.mockResolvedValueOnce({
      recipientId: "rp_otherRecipient",
      status: "active",
      observedAt: "2026-11-18T12:00:00.000Z",
    });
    const context = await values.service.read(actor);
    expect(context.accountState).toBe("CREATED");
    expect(context.providerStatus).toBeNull();
  });
  it("never exposes the account registration action to another site administrator", async () => {
    const values = fixture();
    expect(
      await values.service.read({ ...actor, userId: "planner-one" }),
    ).toMatchObject({ isHolder: false, accountState: "NOT_CREATED" });
    values.repository.requireHolder.mockRejectedValueOnce(
      new Error("holder required"),
    );
    await expect(
      values.service.submit(input, {
        ...authorization,
        actor: { ...actor, userId: "planner-one" },
      }),
    ).rejects.toThrow();
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("persists the holder consent before nomination and one-time recipient provisioning", async () => {
    const values = fixture();
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "STORED",
    });
    expect(values.repository.consent.mock.invocationCallOrder[0]).toBeLessThan(
      values.nominate.mock.invocationCallOrder[0],
    );
    expect(values.nominate.mock.invocationCallOrder[0]).toBeLessThan(
      values.begin.mock.invocationCallOrder[0],
    );
    expect(values.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "CREATE",
        confirmNativeCreation: true,
        input: {
          ...input.account,
          name: "MARIA DA SILVA",
          bankAccount: {
            ...input.account.bankAccount,
            holderName: "MARIA DA SILVA",
          },
        },
      }),
    );
    expect(
      values.repository.readSessionAuthentication,
    ).toHaveBeenCalledExactlyOnceWith(actor);
    expect(values.begin.mock.calls[0]?.[0]).toMatchObject({
      authorization: {
        recentAuth: {
          proofKind: "SESSION_AUTHENTICATION",
          authenticatedAt: new Date("2026-10-16T10:00:00Z"),
        },
      },
    });
  });
  it("rejects the former provider and Pix consent fields", async () => {
    const values = fixture();
    const { consentToProvider: _consent, ...legacy } = input;
    await expect(
      values.service.submit(
        { ...legacy, legacyProviderConsent: true, pixConsentVersion: "v1" },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_SETUP_INVALID_INPUT" });
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("refuses a bank holder name over 30 characters without consent or a Pagar.me call", async () => {
    const values = fixture();
    await expect(
      values.service.submit(
        {
          ...input,
          account: {
            ...input.account,
            bankAccount: {
              ...input.account.bankAccount,
              holderName: "MARIA APARECIDA DOS SANTOS LIMA",
            },
          },
        },
        authorization,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECEIVING_SETUP_INVALID_INPUT",
    });
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("dispatches the normalized bank holder name apart from the full name", async () => {
    const values = fixture();
    await values.service.submit(input, authorization);
    expect(values.begin.mock.calls[0]?.[0]).toMatchObject({
      input: {
        name: "MARIA DA SILVA",
        bankAccount: { holderName: "MARIA DA SILVA" },
      },
    });
  });
  it("does not create another provider account when a previous dispatch is uncertain", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValueOnce({
      state: "CLAIMED",
      operatorUserId: actor.userId,
    });
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "UNKNOWN",
    });
    expect(values.nominate).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("reconciles an armed dispatch without a stored result instead of staying uncertain", async () => {
    const values = fixture();
    const record = { sealedResult: null, provision: {} };
    const nomination = { accountId: "binding-one" };
    values.repository.readAccount.mockResolvedValueOnce({
      state: "UNKNOWN",
      operatorUserId: actor.userId,
      nomination,
      record,
    });
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "STORED",
    });
    expect(values.nominate).not.toHaveBeenCalled();
    expect(values.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "RECONCILE",
        record,
        nomination,
        input: {
          ...input.account,
          name: "MARIA DA SILVA",
          bankAccount: {
            ...input.account.bankAccount,
            holderName: "MARIA DA SILVA",
          },
        },
      }),
    );
  });
  it("keeps an uncertain dispatch with a stored result uncertain", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValueOnce({
      state: "UNKNOWN",
      operatorUserId: actor.userId,
      nomination: {},
      record: {
        sealedResult: {
          accountReference: "rp_fixtureRecipient01",
          recipientReference: "rp_fixtureRecipient01",
        },
      },
    });
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "UNKNOWN",
    });
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("turns a definitive Pagar.me refusal into a clear, retryable problem", async () => {
    const values = fixture();
    const rejection = {
      status: 412,
      message: "Recebedor inválido",
      fields: [
        {
          field: "register_information.birthdate",
          messages: ["must be dd/mm/yyyy"],
        },
      ],
    };
    values.begin.mockReturnValueOnce({
      feedback: Promise.resolve({ state: "REJECTED", rejection }),
      completion: Promise.resolve(),
      cancel: vi.fn(),
    } as never);
    await expect(
      values.service.submit(input, authorization),
    ).rejects.toMatchObject({
      status: 422,
      code: "RECEIVING_PROVIDER_REJECTED",
      rejection: {
        message: "Recebedor inválido",
        fields: rejection.fields,
      },
    });
  });
  it("rejects a stale policy without recording consent or dispatching", async () => {
    const values = fixture();
    await expect(
      values.service.submit(
        { ...input, policyVersion: "old-policy" },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_SETUP_POLICY_CHANGED" });
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("does not create the recipient again on a second submit for the same site", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValueOnce(createdAccount);
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "STORED",
    });
    expect(values.nominate).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
});

describe("verifying an uncertain receiving setup", () => {
  const record = { sealedResult: null, provision: {} };
  const nomination = { accountId: "binding-one" };
  const uncertain = {
    state: "UNKNOWN" as const,
    operatorUserId: actor.userId,
    nomination,
    record,
  };
  it.each([
    [{ state: "RELEASED" }, { outcome: "RELEASED" }],
    [{ state: "STORED" }, { outcome: "STORED" }],
    [
      { state: "UNKNOWN", reason: "PROVIDER_UNREACHABLE" },
      { outcome: "UNKNOWN", reason: "PROVIDER_UNREACHABLE" },
    ],
    [
      { state: "UNKNOWN", reason: "WINDOW_NOT_ELAPSED" },
      { outcome: "UNKNOWN", reason: "WINDOW_NOT_ELAPSED" },
    ],
    [{ state: "UNKNOWN" }, { outcome: "UNKNOWN", reason: "UNAVAILABLE" }],
    [{ state: "UNAVAILABLE" }, { outcome: "UNKNOWN", reason: "UNAVAILABLE" }],
  ])(
    "consults the stored dispatch without recipient input: %o answers %o",
    async (feedback, outcome) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValueOnce(uncertain);
      values.begin.mockReturnValueOnce({
        feedback: Promise.resolve(feedback),
        completion: Promise.resolve(),
        cancel: vi.fn(),
      } as never);
      expect(await values.service.reconcile(actor)).toEqual(outcome);
      expect(values.repository.requireHolder).toHaveBeenCalledWith(actor);
      expect(values.repository.readSessionAuthentication).toHaveBeenCalledWith(
        actor,
      );
      expect(values.begin).toHaveBeenCalledExactlyOnceWith({
        action: "VERIFY",
        record,
        nomination,
        authorization: { actor, recentAuth: expect.any(Object) },
        confirmNativeCreation: true,
      });
      expect(values.begin.mock.calls[0][0]).not.toHaveProperty("input");
      expect(values.nominate).not.toHaveBeenCalled();
      expect(values.repository.consent).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ state: "SUCCEEDED" }, { outcome: "STORED" }],
    [{ state: "REQUESTED" }, { outcome: "RELEASED" }],
    [
      { state: "CLAIMED" },
      { outcome: "UNKNOWN", reason: "DISPATCH_IN_PROGRESS" },
    ],
    [
      {
        state: "UNKNOWN",
        nomination,
        record: {
          sealedResult: {
            accountReference: "rp_fixtureRecipient01",
            recipientReference: "rp_fixtureRecipient01",
          },
        },
      },
      { outcome: "UNKNOWN", reason: "UNAVAILABLE" },
    ],
  ])(
    "answers a %o dispatch from the stored state alone",
    async (account, outcome) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValueOnce({
        operatorUserId: actor.userId,
        ...account,
      });
      expect(await values.service.reconcile(actor)).toEqual(outcome);
      expect(values.begin).not.toHaveBeenCalled();
    },
  );
  it("requires an existing account of the same holder", async () => {
    const values = fixture();
    await expect(values.service.reconcile(actor)).rejects.toMatchObject({
      status: 409,
      code: "RECEIVING_ACCOUNT_REQUIRED",
    });
    values.repository.readAccount.mockResolvedValueOnce({
      ...uncertain,
      operatorUserId: "groom-one",
    });
    await expect(values.service.reconcile(actor)).rejects.toMatchObject({
      status: 403,
      code: "RECEIVING_HOLDER_REQUIRED",
    });
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("refuses anyone but the designated holder before reading the account", async () => {
    const values = fixture();
    values.repository.requireHolder.mockRejectedValueOnce(
      Object.assign(new Error("not the holder"), { status: 403 }),
    );
    await expect(values.service.reconcile(actor)).rejects.toThrow(
      "not the holder",
    );
    expect(values.repository.readAccount).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
});

function eligible(values: ReturnType<typeof fixture>) {
  values.observe.mockResolvedValue({
    recipientId: "rp_fixtureRecipient01",
    status: "affiliation",
    kyc: {
      status: "partially_denied",
      statusReason: "additional_documents_required",
    },
    observedAt: "2026-11-18T12:00:00.000Z",
  } as never);
}
describe("receiving identity verification link", () => {
  it.each([
    ["the platform owner", { ...actor, userId: "owner-one" }, "OWNER"],
    ["the account operator", actor, "SITE_ADMIN"],
  ] as const)(
    "returns a fresh link for %s without writing it anywhere",
    async (_label, requester, role) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValue(createdAccount);
      eligible(values);
      const log = vi.spyOn(console, "log");
      const info = vi.spyOn(console, "info");
      expect(await values.service.createKycLink(requester, role)).toEqual(
        kycLink,
      );
      expect(values.recipients.createKycLink).toHaveBeenCalledExactlyOnceWith(
        "rp_fixtureRecipient01",
      );
      expect(values.repository.consent).not.toHaveBeenCalled();
      expect(values.repository.designate).not.toHaveBeenCalled();
      expect(values.begin).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      log.mockRestore();
      info.mockRestore();
    },
  );
  it("refuses another site administrator", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    await expect(
      values.service.createKycLink(
        { ...actor, userId: "planner-one" },
        "SITE_ADMIN",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(values.recipients.createKycLink).not.toHaveBeenCalled();
  });
  it("reports a provider refusal as an unavailable link without provider details", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    eligible(values);
    vi.spyOn(console, "info").mockImplementation(() => {});
    values.recipients.createKycLink.mockRejectedValue(
      new PagarmeRejectedError(
        404,
        null,
        "no kyc with partially_denied status",
      ),
    );
    const error = await values.service
      .createKycLink({ ...actor, userId: "owner-one" }, "OWNER")
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      status: 409,
      code: "RECEIVING_KYC_LINK_UNAVAILABLE",
    });
    expect(String((error as Error).message)).not.toContain("partially_denied");
  });
  it.each([
    ["registration", { status: null, statusReason: null }],
    ["affiliation", { status: "pending", statusReason: "in_analysis" }],
    [
      "affiliation",
      { status: "pending", statusReason: "answered_waiting_analysis" },
    ],
    ["affiliation", { status: "approved", statusReason: null }],
    ["active", { status: "approved", statusReason: null }],
    ["refused", { status: "denied", statusReason: "fully_denied" }],
    ["affiliation", { status: "denied", statusReason: "fully_denied" }],
  ] as const)(
    "refuses before calling Pagar.me while the recipient is %s with KYC %o",
    async (status, kyc) => {
      const values = fixture();
      values.repository.readAccount.mockResolvedValue(createdAccount);
      values.observe.mockResolvedValue({
        recipientId: "rp_fixtureRecipient01",
        status,
        kyc,
        observedAt: "2026-11-18T12:00:00.000Z",
      } as never);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      await expect(
        values.service.createKycLink(
          { ...actor, userId: "owner-one" },
          "OWNER",
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "RECEIVING_KYC_LINK_UNAVAILABLE",
      });
      expect(values.recipients.createKycLink).not.toHaveBeenCalled();
      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
        event: "receiving.kyc_link.unavailable",
        operation: "observe",
        result: `${status}.${kyc.status ?? "none"}`,
        siteId: "site-one",
      });
      info.mockRestore();
    },
  );
  it.each([
    [
      "the observation fails",
      () => Promise.reject(new Error("Pagar.me unreachable")),
    ],
    [
      "Pagar.me sends no KYC details in affiliation",
      async () => ({
        recipientId: "rp_fixtureRecipient01",
        status: "affiliation",
        kyc: { status: null, statusReason: null },
        observedAt: "2026-11-18T12:00:00.000Z",
      }),
    ],
    [
      "the recipient status is undocumented",
      async () => ({
        recipientId: "rp_fixtureRecipient01",
        status: "mystery",
        kyc: { status: "unknown", statusReason: "unknown" },
        observedAt: "2026-11-18T12:00:00.000Z",
      }),
    ],
  ])("lets Pagar.me decide when %s", async (_label, observation) => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    values.observe.mockImplementation(observation as never);
    expect(
      await values.service.createKycLink(
        { ...actor, userId: "owner-one" },
        "OWNER",
      ),
    ).toEqual(kycLink);
  });
  it("logs a Pagar.me refusal with its status, code and redacted reason only", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    eligible(values);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    values.recipients.createKycLink.mockRejectedValue(
      new PagarmeRejectedError(
        404,
        "not_found",
        "rp_fixtureRecipient01 doesn´t have any kyc with partially_denied status. MARIA DA SILVA 123.456.789-09 https://pagar.me/kyc/session-abc",
      ),
    );
    await expect(
      values.service.createKycLink({ ...actor, userId: "owner-one" }, "OWNER"),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECEIVING_KYC_LINK_UNAVAILABLE",
    });
    expect(info).toHaveBeenCalledOnce();
    const logged = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      level: "warn",
      event: "receiving.kyc_link.rejected",
      operation: "createKycLink",
      status: 404,
      providerCode: "not_found",
      errorCode: "PagarmeRejectedError",
      siteId: "site-one",
    });
    expect(JSON.parse(logged).providerMessage).toContain(
      "partially_denied status",
    );
    for (const value of [
      "https://",
      "pagar.me/kyc",
      "MARIA",
      "SILVA",
      "123.456.789-09",
      "12345678909",
      kycLink.url,
      kycLink.base64QrCode,
    ])
      expect(logged).not.toContain(value);
    info.mockRestore();
  });
  it("never lets a failing log change the refusal", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(createdAccount);
    eligible(values);
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("log sink down");
    });
    values.recipients.createKycLink.mockRejectedValue(
      new PagarmeRejectedError(404, null, null),
    );
    await expect(
      values.service.createKycLink({ ...actor, userId: "owner-one" }, "OWNER"),
    ).rejects.toMatchObject({ code: "RECEIVING_KYC_LINK_UNAVAILABLE" });
  });
  it.each([
    ["no account", null],
    [
      "a pending account",
      { ...createdAccount, state: "UNKNOWN", result: null },
    ],
  ])("requires a created recipient (%s)", async (_label, account) => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValue(account);
    await expect(
      values.service.createKycLink({ ...actor, userId: "owner-one" }, "OWNER"),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECEIVING_ACCOUNT_REQUIRED",
    });
    expect(values.recipients.createKycLink).not.toHaveBeenCalled();
  });
});
describe("receiving holder candidates", () => {
  const candidates = [
    { userId: "bride-one", name: "Marina", email: "marina@example.test" },
    { userId: "groom-one", name: "Rafael", email: "rafael@example.test" },
  ];
  it("lists candidates to a site administrator while no holder exists", async () => {
    const values = fixture();
    values.repository.readHolder.mockResolvedValue(null as never);
    values.repository.listHolderCandidates.mockResolvedValue(
      candidates as never,
    );
    const context = await values.service.read(actor, "SITE_ADMIN");
    expect(context.holderCandidates).toEqual(candidates);
    expect(values.repository.listHolderCandidates).toHaveBeenCalledWith(
      "site-one",
    );
  });
  it("stops listing candidates to a site administrator once a holder exists", async () => {
    const values = fixture();
    values.repository.listHolderCandidates.mockResolvedValue(
      candidates as never,
    );
    const context = await values.service.read(actor, "SITE_ADMIN");
    expect(context).not.toHaveProperty("holderCandidates");
    expect(values.repository.listHolderCandidates).not.toHaveBeenCalled();
  });
  it("never lists candidates to an assistant", async () => {
    const values = fixture();
    values.repository.readHolder.mockResolvedValue(null as never);
    const context = await values.service.read(actor, "SITE_ASSISTANT");
    expect(context).not.toHaveProperty("holderCandidates");
    expect(values.repository.listHolderCandidates).not.toHaveBeenCalled();
  });
  it("keeps listing candidates to the owner", async () => {
    const values = fixture();
    values.repository.listHolderCandidates.mockResolvedValue(
      candidates as never,
    );
    const context = await values.service.read(
      { ...actor, userId: "owner-one" },
      "OWNER",
    );
    expect(context.holderCandidates).toEqual(candidates);
  });
});
