import { describe, expect, it } from "vitest";
import {
  createReceivingSetupInputSchema,
  isValidCpf,
  ownerFinanceAlertSchema,
  pagarmeKycStatuses,
  pagarmeKycStatusReasons,
  receivingConsentCoversCreatedRecipient,
  receivingSetupConsentVersion,
  receivingSetupContextSchema,
  receivingSetupDisclosure,
  receivingSetupHolderInputSchema,
  receivingSetupInputSchema,
} from "./index";

const account = {
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
    complement: "Bloco A",
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
    type: "checking",
  },
};

describe("Pagar.me receiving setup contracts", () => {
  it("records consent to Pagar.me only", () => {
    expect(receivingSetupConsentVersion).toBe("pagarme-receiving-v2");
    expect(receivingSetupDisclosure.version).toBe("pagarme-receiving-v2");
    expect(receivingSetupDisclosure.text).toContain("Pagar.me");
    expect(receivingSetupDisclosure.text).not.toMatch(/subconta|BaaS/i);
  });

  it("keeps a recipient created under the previous Pagar.me consent operating", () => {
    expect(receivingConsentCoversCreatedRecipient("pagarme-receiving-v2")).toBe(
      true,
    );
    expect(receivingConsentCoversCreatedRecipient("pagarme-receiving-v1")).toBe(
      true,
    );
    expect(receivingConsentCoversCreatedRecipient("asaas-receiving-v1")).toBe(
      false,
    );
    expect(receivingConsentCoversCreatedRecipient(null)).toBe(false);
  });

  it("carries the holder's own identity declaration and no provider identity check", () => {
    const text = receivingSetupDisclosure.text;
    expect(text).toContain("Declaro que sou o titular do CPF informado");
    expect(text).toContain("da conta bancária cadastrada");
    expect(text).toContain("tenho 18 anos ou mais");
    expect(text).toContain("os dados deste formulário são verdadeiros");
    expect(text).not.toMatch(/selfie|prova de vida|verificação de identidade/i);
    expect(text).not.toMatch(/documentos? (serão|será) solicitad/i);
  });

  it.each([
    ["without the identity declaration", { declareHolderIdentity: undefined }],
    ["with a false identity declaration", { declareHolderIdentity: false }],
    ["without the holder confirmation", { confirmHolder: undefined }],
    ["without the Pagar.me consent", { consentToProvider: undefined }],
    ["without a consent version", { consentVersion: undefined }],
    [
      "with the pre-declaration consent version",
      { consentVersion: "pagarme-receiving-v1" },
    ],
  ])("rejects an acceptance %s", (_label, patch) => {
    expect(
      receivingSetupInputSchema.safeParse({
        policyVersion: "receiving-setup-v1",
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account,
        ...patch,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["the day before the 18th birthday", "2026-04-11", false],
    ["on the 18th birthday", "2026-04-12", true],
    ["the day after the 18th birthday", "2026-04-13", true],
  ])(
    "checks the holder age against the reference date %s",
    (_label, today, accepted) => {
      const schema = createReceivingSetupInputSchema(
        () => new Date(`${today}T12:00:00.000Z`),
      );
      expect(
        schema.safeParse({
          policyVersion: "receiving-setup-v1",
          consentVersion: receivingSetupConsentVersion,
          confirmHolder: true,
          consentToProvider: true,
          declareHolderIdentity: true,
          account: { ...account, birthDate: "2008-04-12" },
        }).success,
      ).toBe(accepted);
    },
  );

  it("counts a 29 February birthday as 18 only on 1 March of a common year", () => {
    const parse = (today: string) =>
      createReceivingSetupInputSchema(
        () => new Date(`${today}T00:00:00.000Z`),
      ).safeParse({
        policyVersion: "receiving-setup-v1",
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account: { ...account, birthDate: "2008-02-29" },
      }).success;
    expect(parse("2026-02-28")).toBe(false);
    expect(parse("2026-03-01")).toBe(true);
  });

  it.each([
    ["a different holder document", "52998224725"],
    ["the recipient CPF as holder document", "12345678909"],
  ])(
    "takes the bank holder document from the recipient CPF and refuses %s from the form",
    (_label, holderDocument) => {
      expect(
        receivingSetupInputSchema.safeParse({
          policyVersion: "receiving-setup-v1",
          consentVersion: receivingSetupConsentVersion,
          confirmHolder: true,
          consentToProvider: true,
          declareHolderIdentity: true,
          account: {
            ...account,
            bankAccount: { ...account.bankAccount, holderDocument },
          },
        }).success,
      ).toBe(false);
    },
  );

  it("accepts the individual recipient data with the couple's own bank account", () => {
    const parsed = receivingSetupInputSchema.parse({
      policyVersion: "receiving-setup-v1",
      consentVersion: receivingSetupConsentVersion,
      confirmHolder: true,
      consentToProvider: true,
      declareHolderIdentity: true,
      account,
    });
    expect(parsed.account.bankAccount.type).toBe("checking");
  });

  it("accepts an address without the optional reference point", () => {
    const { referencePoint: _referencePoint, ...address } = account.address;
    const parsed = receivingSetupInputSchema.parse({
      policyVersion: "receiving-setup-v1",
      consentVersion: receivingSetupConsentVersion,
      confirmHolder: true,
      consentToProvider: true,
      declareHolderIdentity: true,
      account: { ...account, address },
    });
    expect(parsed.account.address.referencePoint).toBeUndefined();
  });

  it.each([
    ["previous provider consent flag", { consentToPreviousProvider: true }],
    ["Pix consent", { pixConsentVersion: "incoming-pix-v1" }],
  ])("rejects the retired %s", (_label, extra) => {
    expect(
      receivingSetupInputSchema.safeParse({
        policyVersion: "receiving-setup-v1",
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account,
        ...extra,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["state", { address: { ...account.address, state: "Rio" } }],
    ["bank code", { bankAccount: { ...account.bankAccount, bank: "34" } }],
    ["account type", { bankAccount: { ...account.bankAccount, type: "pix" } }],
    ["income", { monthlyIncomeCents: 1.5 }],
  ])("rejects an invalid %s", (_label, patch) => {
    expect(
      receivingSetupInputSchema.safeParse({
        policyVersion: "receiving-setup-v1",
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account: { ...account, ...patch },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["CPF check digits", { cpf: "12345678900" }],
    ["repeated-digit CPF", { cpf: "11111111111" }],
    [
      "holder under 18",
      {
        birthDate: new Date(Date.now() - 17 * 366 * 24 * 60 * 60_000)
          .toISOString()
          .slice(0, 10),
      },
    ],
    ["future birth date", { birthDate: "2999-01-01" }],
  ])(
    "rejects a recipient with an invalid %s before calling Pagar.me",
    (_label, patch) => {
      expect(
        receivingSetupInputSchema.safeParse({
          policyVersion: "receiving-setup-v1",
          consentVersion: receivingSetupConsentVersion,
          confirmHolder: true,
          consentToProvider: true,
          declareHolderIdentity: true,
          account: { ...account, ...patch },
        }).success,
      ).toBe(false);
    },
  );

  it("validates CPF check digits", () => {
    expect(isValidCpf("12345678909")).toBe(true);
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("12345678900")).toBe(false);
    expect(isValidCpf("00000000000")).toBe(false);
  });

  it("exposes the recipient status mapped onto the receiving account state", () => {
    const context = receivingSetupContextSchema.parse({
      siteId: "site-1",
      mode: "sandbox",
      policyVersion: "receiving-setup-v1",
      holder: { userId: "user-1", name: "Maria" },
      isHolder: true,
      consentRecorded: true,
      disclosure: receivingSetupDisclosure,
      accountState: "CREATED",
      providerStatus: {
        recipientStatus: "registration",
        accountState: "ONBOARDING",
        receivingEnabled: false,
        observedAt: "2026-11-18T12:00:00.000Z",
      },
    });
    expect(context.providerStatus?.accountState).toBe("ONBOARDING");
  });

  it("exposes the Pagar.me identity check status without personal data", () => {
    const base = {
      siteId: "site-1",
      mode: "sandbox",
      policyVersion: "receiving-setup-v1",
      holder: { userId: "user-1", name: "Maria" },
      isHolder: true,
      consentRecorded: true,
      disclosure: receivingSetupDisclosure,
      accountState: "CREATED",
    };
    const provider = {
      recipientStatus: "affiliation",
      accountState: "UNDER_REVIEW",
      receivingEnabled: false,
      observedAt: "2026-11-18T12:00:00.000Z",
    };
    const parse = (extra: object) =>
      receivingSetupContextSchema.safeParse({
        ...base,
        providerStatus: { ...provider, ...extra },
      });
    for (const kycStatus of pagarmeKycStatuses)
      expect(parse({ kycStatus, kycStatusReason: null }).success).toBe(true);
    for (const kycStatusReason of pagarmeKycStatusReasons)
      expect(parse({ kycStatus: "pending", kycStatusReason }).success).toBe(
        true,
      );
    expect(pagarmeKycStatuses).toEqual([
      "pending",
      "partially_denied",
      "approved",
      "denied",
      "unknown",
    ]);
    expect(pagarmeKycStatusReasons).toEqual([
      "in_analysis",
      "answered_waiting_analysis",
      "waiting_manual_risk_analysis",
      "additional_documents_required",
      "fully_denied",
      "unknown",
    ]);
    // Absent before the API reports it, so older responses still parse.
    expect(parse({}).success).toBe(true);
    expect(parse({ kycStatus: null, kycStatusReason: null }).success).toBe(
      true,
    );
    expect(parse({ kycStatus: "selfie" }).success).toBe(false);
    expect(parse({ kycDetails: { document: "12345678909" } }).success).toBe(
      false,
    );
  });
});

describe("receiving holder designation contract", () => {
  const token = `fr1.${"a".repeat(80)}.${"b".repeat(43)}`;
  it("accepts the owner's bare choice and an administrator's password proof", () => {
    expect(
      receivingSetupHolderInputSchema.parse({ holderUserId: "bride-one" }),
    ).toEqual({ holderUserId: "bride-one" });
    expect(
      receivingSetupHolderInputSchema.parse({
        holderUserId: "bride-one",
        reauthenticationToken: token,
      }),
    ).toEqual({ holderUserId: "bride-one", reauthenticationToken: token });
  });
  it.each(["", "proof", `fr1.a.${"b".repeat(42)}`])(
    "rejects a malformed reauthentication token %#",
    (reauthenticationToken) => {
      expect(
        receivingSetupHolderInputSchema.safeParse({
          holderUserId: "bride-one",
          reauthenticationToken,
        }).success,
      ).toBe(false);
    },
  );
});
describe("owner finance alert contract", () => {
  it("links to the provider payment with a neutral field name", () => {
    expect(Object.keys(ownerFinanceAlertSchema.shape)).toContain(
      "providerPaymentUrl",
    );
    expect(
      Object.keys(ownerFinanceAlertSchema.shape).filter((key) =>
        key.endsWith("PaymentUrl"),
      ),
    ).toEqual(["providerPaymentUrl"]);
  });
});
