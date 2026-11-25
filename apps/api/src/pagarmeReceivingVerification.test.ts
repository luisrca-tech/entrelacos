import { createHash } from "node:crypto";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createPagarmeReceivingVerification,
  preparePagarmeReceivingVerification,
} from "./pagarmeReceivingVerification";
import type { PagarmeRecipient } from "./pagarmeRecipientClient";
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import { readReceivingNominationSnapshot } from "./receivingNomination";
import {
  prepareReceivingVerificationObservation,
  type ReceivingVerificationFence,
  readReceivingVerificationCandidate,
} from "./receivingVerification";

const observedAt = "2026-11-19T09:30:00.000Z";
function fixture(environment: "sandbox" | "live" = "live") {
  const keyring = new Map([["key-one", new Uint8Array(32).fill(12)]]);
  const nomination = readReceivingNominationSnapshot({
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: "request-one",
    operatorUserId: "holder-one",
    environment,
    policyVersion: "policy-one",
    accountId: "account-one",
    operationId: "operation-one",
    createdAt: "2026-10-13T00:00:00.000Z",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "request-one",
          "holder-one",
          environment,
          "policy-one",
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      userId: "holder-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T23:59:30.000Z",
      expiresAt: "2026-10-13T00:04:00.000Z",
    },
  });
  const provision = deriveReceivingProvisioningContext(
    nomination,
    "rp_platformRecipient",
    "key-one",
    {
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
        accountNumber: "12345",
        accountCheckDigit: "6",
        holderName: "MARIA DA SILVA",
        type: "checking",
      },
    },
    keyring,
  );
  const scope = {
    provider: "PAGARME" as const,
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "holder-one",
    environment,
    operatorReference: null as string | null,
    accountReference: "rp_fixtureRecipient01",
    recipientReference: "rp_fixtureRecipient01",
  };
  const fence: ReceivingVerificationFence = {
    scope,
    account: {},
    operation: {
      request_snapshot: {
        version: "receiving.account-provisioning.v1",
        nomination,
        provision: {
          ...provision,
          dispatch: {
            leaseOwner: "owner-one",
            leaseToken: "token-one",
            leaseExpiresAtMicroseconds: "1791849660000000",
            possibleDispatch: true,
          },
        },
        sealedResult: null,
      },
    },
    destinations: [],
    evidence: [],
  };
  const recipient: PagarmeRecipient = {
    id: "rp_fixtureRecipient01",
    code: "account-one",
    status: "active",
    kyc: { status: "approved", statusReason: null },
    document: "12345678909",
    bankAccount: {
      id: "ba_fixtureBankAcct01",
      holderDocument: "12345678909",
      maskedAccount: "Conta **** 3456",
    },
  };
  return { fence, recipient, provision };
}
function selected(
  fence: ReceivingVerificationFence,
  bankReference = "ba_fixtureBankAcct01",
): ReceivingVerificationFence {
  return {
    ...fence,
    scope: {
      ...fence.scope,
      operatorReference: preparePagarmeReceivingVerification(
        fence,
        fixture().recipient,
        observedAt,
      ).candidate.scope.operatorReference,
    },
    destinations: [
      {
        id: "destination-one",
        version: 1,
        bank_reference: bankReference,
        is_current: true,
      },
    ],
  };
}

describe("Pagar.me recipient receiving verification", () => {
  it("selects the recipient default bank account as the masked current destination", () => {
    const v = fixture();
    const { candidate, observation } = preparePagarmeReceivingVerification(
      v.fence,
      v.recipient,
      observedAt,
    );
    expect(observation).toBeNull();
    expect(readReceivingVerificationCandidate(candidate)).toEqual(candidate);
    expect(candidate).toMatchObject({
      bankReference: "ba_fixtureBankAcct01",
      maskedDescriptor: "Conta **** 3456",
      scope: {
        provider: "PAGARME",
        accountReference: "rp_fixtureRecipient01",
        recipientReference: "rp_fixtureRecipient01",
        operatorReference: `pagarme-holder-${v.provision.inputFingerprint}`,
      },
    });
  });
  it("keeps the CPF out of the stored mapping reference (no brute-forceable hash)", () => {
    const v = fixture();
    const first = preparePagarmeReceivingVerification(
      v.fence,
      v.recipient,
      observedAt,
    ).candidate.mappingReference;
    const otherCpf = preparePagarmeReceivingVerification(
      v.fence,
      {
        ...v.recipient,
        document: "52998224725",
        bankAccount: {
          ...(v.recipient.bankAccount as NonNullable<
            PagarmeRecipient["bankAccount"]
          >),
          holderDocument: "52998224725",
        },
      },
      observedAt,
    ).candidate.mappingReference;
    expect(otherCpf).toBe(first);
    // A different holder on the bank account still changes the reference.
    const foreignHolder = preparePagarmeReceivingVerification(
      v.fence,
      {
        ...v.recipient,
        bankAccount: {
          ...(v.recipient.bankAccount as NonNullable<
            PagarmeRecipient["bankAccount"]
          >),
          holderDocument: "52998224725",
        },
      },
      observedAt,
    ).candidate.mappingReference;
    expect(foreignHolder).not.toBe(first);
  });
  it("approves an active recipient whose bank holder is the recipient", () => {
    const v = fixture();
    const { observation } = preparePagarmeReceivingVerification(
      selected(v.fence),
      v.recipient,
      observedAt,
    );
    expect(observation).toMatchObject({
      destination: { bankReference: "ba_fixtureBankAcct01", version: 1 },
      account: {
        state: "APPROVED",
        receiving: true,
        withdrawal: true,
        commercial: true,
        observedAt,
      },
      bank: { state: "VERIFIED", observedAt },
    });
    if (!observation) throw new Error("Missing observation");
    expect(prepareReceivingVerificationObservation(observation).scope).toEqual(
      selected(v.fence).scope,
    );
  });
  it.each([
    ["registration", "ONBOARDING"],
    ["affiliation", "UNDER_REVIEW"],
    ["refused", "BLOCKED"],
    ["suspended", "SUSPENDED"],
    ["blocked", "BLOCKED"],
    ["inactive", "SUSPENDED"],
    ["mystery", "UNVERIFIED"],
  ])("maps a %s recipient to %s without capabilities", (status, state) => {
    const v = fixture();
    const { observation } = preparePagarmeReceivingVerification(
      selected(v.fence),
      { ...v.recipient, status },
      observedAt,
    );
    expect(observation).toMatchObject({
      account: {
        state,
        receiving: false,
        withdrawal: false,
        commercial: false,
      },
      bank: { state: "PENDING" },
    });
  });
  it("rejects a bank account held by someone else and blocks withdrawals", () => {
    const v = fixture();
    const { observation } = preparePagarmeReceivingVerification(
      selected(v.fence),
      {
        ...v.recipient,
        bankAccount: {
          id: "ba_fixtureBankAcct01",
          holderDocument: "11144477735",
          maskedAccount: "Conta **** 3456",
        },
      },
      observedAt,
    );
    expect(observation).toMatchObject({
      account: { state: "APPROVED", withdrawal: false },
      bank: { state: "REJECTED" },
    });
  });
  it("does not observe a changed default bank account against the stored destination", () => {
    const v = fixture();
    expect(
      preparePagarmeReceivingVerification(
        selected(v.fence, "ba_previousAccount"),
        v.recipient,
        observedAt,
      ).observation,
    ).toBeNull();
  });
  it.each([
    ["another recipient", { id: "rp_otherRecipient" }],
    ["another code", { code: "other-account" }],
    ["no code", { code: null }],
    ["no bank account", { bankAccount: null }],
  ])("refuses %s", (_label, change) => {
    const v = fixture();
    expect(() =>
      preparePagarmeReceivingVerification(
        v.fence,
        { ...v.recipient, ...change },
        observedAt,
      ),
    ).toThrow();
  });
});

describe("Pagar.me receiving verification observer", () => {
  function observer(mode: "sandbox" | "live" = "live") {
    const v = fixture(mode);
    const getRecipient = vi.fn(async () => v.recipient);
    const verification = createPagarmeReceivingVerification({
      mode,
      applicationEnvironment: mode === "live" ? "production" : "development",
      platformRecipientId: "rp_platformRecipient",
      recipients: { getRecipient },
      now: () => new Date(observedAt),
    });
    return { ...v, getRecipient, verification };
  }
  it("reads the bound recipient and proves the exact candidate to the policy", async () => {
    const v = observer();
    const owner = v.verification.observer.acquire(
      "SELECT",
      v.fence,
      new AbortController().signal,
    );
    const candidate = await owner.result;
    await owner.completion;
    expect(v.getRecipient).toHaveBeenCalledExactlyOnceWith(
      "rp_fixtureRecipient01",
    );
    const holder = {
      holderUserId: "holder-one",
      consentId: "consent-one",
      consentVersion: receivingSetupConsentVersion,
      consentAt: new Date("2026-11-18T00:00:00.000Z"),
    };
    const tx = { execute: vi.fn(async () => ({ rows: [holder] })) };
    expect(
      await v.verification.readCurrentPolicy(
        "SELECT",
        v.fence,
        tx as never,
        candidate as never,
      ),
    ).toBe(true);
    expect(
      await v.verification.readCurrentPolicy(
        "SELECT",
        v.fence,
        tx as never,
        { ...candidate, bankReference: "ba_forgedAccount" } as never,
      ),
    ).toBe(false);
    // A recipient created under the pre-declaration Pagar.me consent keeps
    // receiving; only a new registration requires the current version.
    tx.execute.mockResolvedValueOnce({
      rows: [{ ...holder, consentVersion: "pagarme-receiving-v1" }],
    });
    expect(
      await v.verification.readCurrentPolicy(
        "SELECT",
        v.fence,
        tx as never,
        candidate as never,
      ),
    ).toBe(true);
    tx.execute.mockResolvedValueOnce({
      rows: [{ ...holder, consentVersion: "legacy-receiving-v1" }],
    });
    expect(
      await v.verification.readCurrentPolicy(
        "SELECT",
        v.fence,
        tx as never,
        null,
      ),
    ).toBe(false);
  });
  it("never reads the platform recipient as a couple's account", async () => {
    const v = observer();
    const fence = {
      ...v.fence,
      scope: {
        ...v.fence.scope,
        accountReference: "rp_platformRecipient",
        recipientReference: "rp_platformRecipient",
      },
    };
    expect(await v.verification.readObserverPolicy(fence.scope)).toBe(false);
    const owner = v.verification.observer.acquire(
      "SELECT",
      fence,
      new AbortController().signal,
    );
    await expect(owner.result).rejects.toThrow();
    expect(v.getRecipient).not.toHaveBeenCalled();
  });
});
