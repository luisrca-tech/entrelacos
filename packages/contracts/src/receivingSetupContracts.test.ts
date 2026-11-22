import { describe, expect, it } from "vitest";
import {
  isValidCpf,
  ownerFinanceAlertSchema,
  receivingKycLinkSchema,
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
    expect(receivingSetupConsentVersion).toBe("pagarme-receiving-v1");
    expect(receivingSetupDisclosure.text).toContain("Pagar.me");
    expect(receivingSetupDisclosure.text).not.toMatch(/subconta|BaaS/i);
  });

  it("accepts the individual recipient data with the couple's own bank account", () => {
    const parsed = receivingSetupInputSchema.parse({
      policyVersion: "receiving-setup-v1",
      consentVersion: receivingSetupConsentVersion,
      confirmHolder: true,
      consentToProvider: true,
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

  it("returns a KYC link with its QR code and expiry", () => {
    expect(
      receivingKycLinkSchema.parse({
        url: "https://exemplo.com/kyc?token=abc",
        base64QrCode: "PD94bWw=",
        expiresAt: "2026-11-18T12:20:00.000Z",
      }).url,
    ).toBe("https://exemplo.com/kyc?token=abc");
    expect(
      receivingKycLinkSchema.safeParse({
        url: "http://exemplo.com/kyc",
        base64QrCode: "PD94bWw=",
        expiresAt: "2026-11-18T12:20:00.000Z",
      }).success,
    ).toBe(false);
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
