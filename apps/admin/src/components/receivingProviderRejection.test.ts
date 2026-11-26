import { describe, expect, it } from "vitest";
import {
  describePagarmeMessage,
  readProviderRejection,
} from "./receivingProviderRejection";

const problem = (provider: unknown) => ({
  code: "RECEIVING_PROVIDER_REJECTED",
  provider,
});

describe("Pagar.me refusal in pt-BR", () => {
  it.each([
    [
      "Bank account holder name must be lower than 30 characters",
      "holderName",
      "Nome do titular da conta: use até 29 caracteres, como aparece no banco.",
    ],
    [
      "The document field is not a valid number.",
      "cpf",
      "CPF: confira os 11 números do CPF do titular.",
    ],
    [
      "Holder document must be equal to the recipient document",
      "cpf",
      "CPF: a conta bancária precisa estar no CPF do titular.",
    ],
    [
      "The field birthdate must be dd/mm/yyyy, got [valor].",
      "birthDate",
      "Data de nascimento: use uma data válida; o titular precisa ter 18 anos ou mais.",
    ],
    [
      "must be dd/mm/yyyy",
      "birthDate",
      "Data de nascimento: use uma data válida; o titular precisa ter 18 anos ou mais.",
    ],
    [
      "Phone [valor] is invalid",
      "mobilePhone",
      "Celular com DDD: informe o DDD e o número do celular, como (11) 90000-0000.",
    ],
    [
      "The zip_code field is invalid.",
      "zipCode",
      "CEP: informe os 8 números do CEP.",
    ],
    [
      "Invalid bank code",
      "bank",
      "Banco: confira o banco escolhido ou o código de 3 números.",
    ],
    [
      "Branch number is invalid",
      "branch",
      "Agência: confira o número da agência e o dígito, se houver.",
    ],
    [
      "Account [valor] at branch [valor] is invalid",
      "account",
      "Conta com dígito: confira o número da conta e o dígito, como aparecem no app do banco.",
    ],
    [
      "The email field is not a valid e-mail address.",
      "email",
      "E-mail do titular: confira o endereço de e-mail.",
    ],
  ])("explains %j", (message, formField, text) => {
    expect(describePagarmeMessage(message)).toEqual({ formField, text });
  });

  it("names the field and keeps the original detail for an unknown message", () => {
    expect(describePagarmeMessage("Recebedor inválido")).toEqual({
      formField: null,
      text: "A Pagar.me recusou um dado do cadastro. Confira os dados e envie de novo. Detalhe da Pagar.me: Recebedor inválido",
    });
    expect(
      describePagarmeMessage(
        "Something odd happened",
        "register_information.address.street",
      ),
    ).toEqual({
      formField: "street",
      text: "Endereço: confira este dado. Detalhe da Pagar.me: Something odd happened",
    });
  });

  it("keeps the original detail within the 240-character bound", () => {
    const long = "x".repeat(400);
    const { text } = describePagarmeMessage(long);
    expect(text.endsWith(`Detalhe da Pagar.me: ${"x".repeat(240)}`)).toBe(true);
  });

  it("highlights the holder field from the path or the message", () => {
    const byPath = readProviderRejection(
      problem({
        message: "The request is invalid.",
        fields: [
          {
            field: "default_bank_account.holder_name",
            messages: [
              "Bank account holder name must be lower than 30 characters",
            ],
          },
        ],
      }),
    );
    expect(byPath).toEqual({
      message: null,
      fields: [
        {
          field: "default_bank_account.holder_name",
          formField: "holderName",
          label: "Nome do titular da conta",
          messages: ["use até 29 caracteres, como aparece no banco."],
        },
      ],
      formFields: ["holderName"],
    });
    const byMessage = readProviderRejection(
      problem({
        message: "Bank account holder name must be lower than 30 characters",
        fields: [],
      }),
    );
    expect(byMessage).toEqual({
      message:
        "Nome do titular da conta: use até 29 caracteres, como aparece no banco.",
      fields: [],
      formFields: ["holderName"],
    });
  });

  it("tells the couple a platform anticipation permission is not their data", () => {
    const text =
      "Não conseguimos concluir o cadastro por um ajuste da conta do Entrelaços na Pagar.me, não por um dado seu. Seus dados estão certos: fale com o suporte do Entrelaços pelo WhatsApp e nós resolvemos.";
    const sandbox =
      "The recipient could not be created : action_forbidden | | this company doesn't have permission to change the anticipation parameters from default values";
    expect(describePagarmeMessage(sandbox)).toEqual({ formField: null, text });
    for (const message of [
      sandbox,
      "The automatic anticipation settings could not be updated.",
      "ACTION_FORBIDDEN on the bank account",
    ]) {
      const rejection = readProviderRejection(problem({ message, fields: [] }));
      expect(rejection).toEqual({
        message: text,
        fields: [],
        formFields: [],
        contactSupport: true,
      });
      expect(rejection?.message).not.toContain("Detalhe da Pagar.me");
    }
  });

  it("does not offer support for a refusal the couple can fix", () => {
    const rejection = readProviderRejection(
      problem({ message: "Something odd happened", fields: [] }),
    );
    expect(rejection).not.toHaveProperty("contactSupport");
  });

  it("refuses a problem without a valid provider part", () => {
    expect(readProviderRejection({ code: "X" })).toBeNull();
  });
});
