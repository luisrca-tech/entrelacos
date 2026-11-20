import { receivingSetupAccountSchema } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  incomeToCents,
  normalizeSetupAccount,
  parseIncome,
} from "./receivingSetupForm";

describe("receiving setup form", () => {
  const masked = {
    name: "  Ana Souza ",
    email: "ana@example.test",
    cpf: "123.456.789-09",
    mobilePhone: "(11) 98765-4321",
    birthDate: "1990-05-20",
    monthlyIncome: "R$ 3.500,50",
    professionalOccupation: " Designer ",
    street: "Avenida Paulista",
    streetNumber: "1000",
    complement: "",
    neighborhood: "Bela Vista",
    city: "São Paulo",
    state: "sp",
    zipCode: "01310-100",
    referencePoint: "Perto do metrô",
    bank: "341",
    branchNumber: "1234",
    branchCheckDigit: "",
    accountNumber: "12.345",
    accountCheckDigit: "x",
    accountType: "checking",
  };

  it("builds the Pagar.me recipient from masked form values", () => {
    const account = normalizeSetupAccount(masked);
    expect(account).toEqual({
      name: "Ana Souza",
      email: "ana@example.test",
      cpf: "12345678909",
      mobilePhone: "11987654321",
      birthDate: "1990-05-20",
      monthlyIncomeCents: 350050,
      professionalOccupation: "Designer",
      address: {
        street: "Avenida Paulista",
        streetNumber: "1000",
        neighborhood: "Bela Vista",
        city: "São Paulo",
        state: "SP",
        zipCode: "01310100",
        referencePoint: "Perto do metrô",
      },
      bankAccount: {
        bank: "341",
        branchNumber: "1234",
        accountNumber: "12345",
        accountCheckDigit: "X",
        type: "checking",
      },
    });
    expect(receivingSetupAccountSchema.safeParse(account).success).toBe(true);
  });

  it("keeps optional complement and branch check digit when given", () => {
    const account = normalizeSetupAccount({
      ...masked,
      complement: " Apto 12 ",
      branchCheckDigit: "7",
      accountType: "savings",
    });
    expect(account.address.complement).toBe("Apto 12");
    expect(account.bankAccount.branchCheckDigit).toBe("7");
    expect(account.bankAccount.type).toBe("savings");
    expect(receivingSetupAccountSchema.safeParse(account).success).toBe(true);
  });

  it("converts income in reais to integer cents without float drift", () => {
    expect(incomeToCents("R$ 1.234,56")).toBe(123456);
    expect(incomeToCents("0,29")).toBe(29);
    expect(incomeToCents("2500.75")).toBe(250075);
    expect(incomeToCents("0")).toBe(0);
    expect(incomeToCents("abc")).toBeNaN();
  });

  it("keeps invalid input invalid instead of guessing", () => {
    expect(parseIncome("")).toBeNaN();
    expect(parseIncome("abc")).toBeNaN();
    expect(parseIncome("1,234")).toBeNaN();
    expect(parseIncome("1.000")).toBe(1000);
    expect(parseIncome("0")).toBe(0);
    expect(parseIncome("2500.75")).toBe(2500.75);
    for (const values of [
      { cpf: null, monthlyIncome: "x" },
      { ...masked, monthlyIncome: "x" },
      { ...masked, accountType: "salary" },
      { ...masked, state: "São Paulo" },
    ])
      expect(
        receivingSetupAccountSchema.safeParse(normalizeSetupAccount(values))
          .success,
      ).toBe(false);
  });
});
