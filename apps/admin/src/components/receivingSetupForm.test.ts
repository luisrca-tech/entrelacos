import { receivingSetupAccountSchema } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  normalizePixKey,
  normalizeSetupAccount,
  parseIncome,
} from "./receivingSetupForm";

describe("receiving setup form", () => {
  it("accepts masked documents and a Brazilian income value", () => {
    const account = normalizeSetupAccount({
      name: "  Ana Souza ",
      email: "ana@example.test",
      cpfCnpj: "123.456.789-00",
      mobilePhone: "(11) 98765-4321",
      incomeValue: "R$ 3.500,50",
      postalCode: "01310-100",
      address: "Avenida Paulista",
      addressNumber: "1000",
      province: "Bela Vista",
      birthDate: "1990-05-20",
    });
    expect(account).toEqual({
      name: "Ana Souza",
      email: "ana@example.test",
      cpfCnpj: "12345678900",
      mobilePhone: "11987654321",
      incomeValue: 3500.5,
      postalCode: "01310100",
      address: "Avenida Paulista",
      addressNumber: "1000",
      province: "Bela Vista",
      birthDate: "1990-05-20",
    });
    expect(receivingSetupAccountSchema.safeParse(account).success).toBe(true);
  });

  it("keeps invalid input invalid instead of guessing", () => {
    expect(parseIncome("")).toBeNaN();
    expect(parseIncome("abc")).toBeNaN();
    expect(parseIncome("1,234")).toBeNaN();
    expect(parseIncome("1.000")).toBe(1000);
    expect(parseIncome("0")).toBe(0);
    expect(parseIncome("2500.75")).toBe(2500.75);
    const account = normalizeSetupAccount({ cpfCnpj: null, incomeValue: "x" });
    expect(receivingSetupAccountSchema.safeParse(account).success).toBe(false);
  });
});

describe("Pix key input", () => {
  it("removes masks only from numeric key types", () => {
    expect(normalizePixKey("CPF", " 123.456.789-00 ")).toBe("12345678900");
    expect(normalizePixKey("CNPJ", "12.345.678/0001-90")).toBe(
      "12345678000190",
    );
    expect(normalizePixKey("PHONE", "(11) 98765-4321")).toBe("11987654321");
    expect(normalizePixKey("EMAIL", " Ana@Email.com ")).toBe("Ana@Email.com");
    expect(
      normalizePixKey("EVP", " 0f8fad5b-d9cb-469f-a165-70867728950e "),
    ).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });
});
