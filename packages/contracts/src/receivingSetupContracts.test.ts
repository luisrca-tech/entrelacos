import { describe, expect, it } from "vitest";
import {
  ownerFinanceAlertSchema,
  receivingKycLinkSchema,
  receivingSetupConsentVersion,
  receivingSetupContextSchema,
  receivingSetupDisclosure,
  receivingSetupInputSchema,
} from "./index";

const account = {
  name: "Maria da Silva",
  email: "maria@example.test",
  cpf: "26224451990",
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
    type: "checking",
  },
};

describe("Pagar.me receiving setup contracts", () => {
  it("records consent to Pagar.me, never to Asaas", () => {
    expect(receivingSetupConsentVersion).toBe("pagarme-receiving-v1");
    expect(receivingSetupDisclosure.text).toContain("Pagar.me");
    expect(JSON.stringify(receivingSetupDisclosure)).not.toMatch(/asaas/i);
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

  it.each([
    ["Asaas consent flag", { consentToAsaas: true }],
    ["Pix consent", { pixConsentVersion: "asaas-incoming-pix-v1" }],
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

describe("owner finance alert contract", () => {
  it("links to the provider payment without naming Asaas", () => {
    expect(Object.keys(ownerFinanceAlertSchema.shape)).toContain(
      "providerPaymentUrl",
    );
    expect(Object.keys(ownerFinanceAlertSchema.shape)).not.toContain(
      "asaasPaymentUrl",
    );
  });
});
