import { describe, expect, it } from "vitest";
import {
  normalizeReceivingHolderName,
  RECEIVING_HOLDER_NAME_MAX_LENGTH,
  receivingHolderNameSchema,
  receivingSetupAccountSchema,
  receivingSetupConsentVersion,
  receivingSetupInputSchema,
  suggestReceivingHolderName,
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
    neighborhood: "Centro",
    city: "Rio de Janeiro",
    state: "RJ",
    zipCode: "20021130",
  },
  bankAccount: {
    bank: "341",
    branchNumber: "1234",
    accountNumber: "12345",
    accountCheckDigit: "6",
    holderName: "MARIA DA SILVA",
    type: "checking",
  },
};
const withHolder = (holderName: unknown) => ({
  ...account,
  bankAccount: { ...account.bankAccount, holderName },
});

describe("bank account holder name", () => {
  it("is limited to the 30 characters Pagar.me accepts", () => {
    expect(RECEIVING_HOLDER_NAME_MAX_LENGTH).toBe(30);
  });

  it("normalizes spaces and case the way the bank prints it", () => {
    expect(normalizeReceivingHolderName("  luís   d’ávila-souza ")).toBe(
      "LUÍS D'ÁVILA-SOUZA",
    );
    expect(receivingHolderNameSchema.parse("  maria   da  silva  ")).toBe(
      "MARIA DA SILVA",
    );
  });

  it("accepts a 30-character holder name and rejects a 31-character one", () => {
    const thirty = "MARIA APARECIDA DOS SANTOS LIM";
    const thirtyOne = "MARIA APARECIDA DOS SANTOS LIMA";
    expect(thirty).toHaveLength(30);
    expect(thirtyOne).toHaveLength(31);
    expect(
      receivingSetupAccountSchema.safeParse(withHolder(thirty)).success,
    ).toBe(true);
    const refused = receivingSetupAccountSchema.safeParse(
      withHolder(thirtyOne),
    );
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual([
      "bankAccount",
      "holderName",
    ]);
    expect(
      receivingSetupInputSchema.safeParse({
        policyVersion: "receiving-setup-v1",
        consentVersion: receivingSetupConsentVersion,
        confirmHolder: true,
        consentToProvider: true,
        account: withHolder(thirtyOne),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["one letter", "M"],
    ["digits", "MARIA 2"],
    ["a dot", "MARIA S. SILVA"],
    ["only spaces", "   "],
  ])("rejects a holder name with %s", (_label, holderName) => {
    expect(
      receivingSetupAccountSchema.safeParse(withHolder(holderName)).success,
    ).toBe(false);
  });

  it("keeps the full name for the registration, up to 128 characters", () => {
    const parsed = receivingSetupAccountSchema.parse({
      ...withHolder("MARIA A DA S SANTOS"),
      name: `Maria ${"Aparecida ".repeat(11)}Santos`,
    });
    expect(parsed.name.length).toBeGreaterThan(30);
    expect(parsed.bankAccount.holderName).toBe("MARIA A DA S SANTOS");
  });
});

describe("holder name suggestion", () => {
  it("keeps a name that already fits, normalized", () => {
    expect(suggestReceivingHolderName("Luis Felipe Da Rocha")).toBe(
      "LUIS FELIPE DA ROCHA",
    );
    expect(suggestReceivingHolderName("  maria   da silva ")).toBe(
      "MARIA DA SILVA",
    );
  });

  it("turns middle names into initials, keeping first and last names", () => {
    expect(
      suggestReceivingHolderName("Maria Aparecida Fernanda Silva Santos"),
    ).toBe("MARIA A F S SANTOS");
  });

  it("keeps the particles da, de, do, dos, das and e", () => {
    expect(
      suggestReceivingHolderName(
        "João Pedro dos Santos de Oliveira Albuquerque",
      ),
    ).toBe("JOÃO P DOS S DE O ALBUQUERQUE");
    expect(
      suggestReceivingHolderName("Ana Beatriz das Neves e Castro Vasconcelos"),
    ).toBe("ANA B DAS N E C VASCONCELOS");
  });

  it("drops particles, then middle initials, when still too long", () => {
    expect(
      suggestReceivingHolderName(
        "Bartholomew Alexander da Costa e Silva Wolfeschlegel",
      ),
    ).toBe("BARTHOLOMEW A C WOLFESCHLEGEL");
  });

  it("cuts two long words at a word boundary", () => {
    expect(
      suggestReceivingHolderName(
        "Wolfeschlegelsteinhausen Bergerdorffvoralternwaren",
      ),
    ).toBe("WOLFESCHLEGELSTEINHAUSEN");
    expect(suggestReceivingHolderName("A".repeat(40))).toBe("A".repeat(30));
  });

  it("drops characters a bank name does not carry", () => {
    expect(suggestReceivingHolderName("Maria S. Silva Jr. 2")).toBe(
      "MARIA S SILVA JR",
    );
  });

  it.each([
    "Luis Felipe Da Rocha",
    "Maria Aparecida Fernanda da Conceição dos Santos Oliveira Pereira",
    "Pedro de Alcântara Francisco Antônio João Carlos Xavier de Paula Miguel Rafael Joaquim José Gonzaga Pascoal Cipriano Serafim de Bragança e Bourbon",
    "Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaft Schafers",
    "D'Ávila-Souza Mendonça de Albuquerque Cavalcanti Wanderley",
  ])("always suggests a valid holder name for %s", (name) => {
    const suggestion = suggestReceivingHolderName(name);
    expect(suggestion.length).toBeLessThanOrEqual(30);
    expect(receivingHolderNameSchema.safeParse(suggestion).success).toBe(true);
  });

  it("suggests nothing for an empty name", () => {
    expect(suggestReceivingHolderName("   ")).toBe("");
  });
});
