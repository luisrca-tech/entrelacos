import { receivingProviderRejectionSchema } from "@entrelacos/contracts";

export type LabeledProviderRejection = {
  message: string | null;
  fields: { field: string; label: string; messages: string[] }[];
};

// Pagar.me field paths (POST /recipients) named as the registration form
// names them, so the holder knows which input to fix.
const fieldLabels: [RegExp, string][] = [
  [/^register_information\.name$/, "Nome completo do titular"],
  [/^register_information\.email$/, "E-mail do titular"],
  [/^register_information\.document$/, "CPF"],
  [/^register_information\.birthdate$/, "Data de nascimento"],
  [/^register_information\.monthly_income$/, "Renda mensal aproximada"],
  [/^register_information\.professional_occupation$/, "Profissão"],
  [/^register_information\.phone_numbers\b/, "Celular com DDD"],
  [/^register_information\.address\.zip_code$/, "CEP"],
  [/^register_information\.address\.street$/, "Endereço"],
  [/^register_information\.address\.street_number$/, "Número"],
  [/^register_information\.address\.complementary$/, "Complemento"],
  [/^register_information\.address\.neighborhood$/, "Bairro"],
  [/^register_information\.address\.city$/, "Cidade"],
  [/^register_information\.address\.state$/, "Estado (UF)"],
  [/^register_information\.address\.reference_point$/, "Ponto de referência"],
  [/^default_bank_account\.bank$/, "Código do banco"],
  [/^default_bank_account\.branch_(?:number|check_digit)$/, "Agência"],
  [
    /^default_bank_account\.account_(?:number|check_digit)$/,
    "Conta com dígito",
  ],
  [/^default_bank_account\.type$/, "Tipo de conta"],
  [/^default_bank_account\.holder_(?:name|document|type)$/, "Titular da conta"],
];

function label(field: string): string {
  return fieldLabels.find(([path]) => path.test(field))?.[1] ?? "Outro dado";
}

/** Reads the `provider` part of a RECEIVING_PROVIDER_REJECTED problem. */
export function readProviderRejection(
  problem: unknown,
): LabeledProviderRejection | null {
  const provider =
    problem && typeof problem === "object" && "provider" in problem
      ? (problem as { provider: unknown }).provider
      : undefined;
  const parsed = receivingProviderRejectionSchema.safeParse(provider);
  if (!parsed.success) return null;
  return {
    message: parsed.data.message,
    fields: parsed.data.fields.map((field) => ({
      ...field,
      label: label(field.field),
    })),
  };
}
