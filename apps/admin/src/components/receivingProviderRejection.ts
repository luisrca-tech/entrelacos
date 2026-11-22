import {
  RECEIVING_HOLDER_NAME_MAX_LENGTH,
  receivingProviderRejectionSchema,
} from "@entrelacos/contracts";
import {
  type ReceivingFormField,
  receivingFormLabels,
} from "./receivingSetupForm";

export type LabeledProviderRejection = {
  /** pt-BR text for Pagar.me's general message, if it says anything. */
  message: string | null;
  fields: {
    field: string;
    label: string;
    formField: ReceivingFormField | null;
    /** pt-BR texts, without the label. */
    messages: string[];
  }[];
  /** Form inputs Pagar.me's refusal points at, to highlight. */
  formFields: ReceivingFormField[];
};

/** The bound of a provider message the API already applies (#89). */
const PROVIDER_DETAIL_LIMIT = 240;

// Pagar.me field paths (POST /recipients) and the form input they come from.
const fieldPaths: [RegExp, ReceivingFormField][] = [
  [/^register_information\.name$/, "name"],
  [/^register_information\.email$/, "email"],
  [/^register_information\.document$/, "cpf"],
  [/^register_information\.birthdate$/, "birthDate"],
  [/^register_information\.monthly_income$/, "monthlyIncome"],
  [/^register_information\.professional_occupation$/, "professionalOccupation"],
  [/^register_information\.phone_numbers\b/, "mobilePhone"],
  [/^register_information\.address\.zip_code$/, "zipCode"],
  [/^register_information\.address\.street$/, "street"],
  [/^register_information\.address\.street_number$/, "streetNumber"],
  [/^register_information\.address\.complementary$/, "complement"],
  [/^register_information\.address\.neighborhood$/, "neighborhood"],
  [/^register_information\.address\.city$/, "city"],
  [/^register_information\.address\.state$/, "state"],
  [/^register_information\.address\.reference_point$/, "referencePoint"],
  [/^default_bank_account\.bank$/, "bank"],
  [/^default_bank_account\.branch_(?:number|check_digit)$/, "branch"],
  [/^default_bank_account\.account_(?:number|check_digit)$/, "account"],
  [/^default_bank_account\.type$/, "accountType"],
  [/^default_bank_account\.holder_name$/, "holderName"],
  [/^default_bank_account\.holder_(?:document|type)$/, "cpf"],
];

// Known Pagar.me messages (English, values already redacted by the API),
// most specific first, with what to fix in pt-BR.
const knownMessages: [RegExp, ReceivingFormField | null, string][] = [
  [/request is invalid/i, null, "A Pagar.me recusou alguns dados do cadastro."],
  [
    /holder.?name/i,
    "holderName",
    `use até ${RECEIVING_HOLDER_NAME_MAX_LENGTH} caracteres, como aparece no banco.`,
  ],
  [
    /holder.?document/i,
    "cpf",
    "a conta bancária precisa estar no CPF do titular.",
  ],
  [/\b(?:document|cpf)\b/i, "cpf", "confira os 11 números do CPF do titular."],
  [
    /birth.?date|dd\/mm\/yyyy/i,
    "birthDate",
    "use uma data válida; o titular precisa ter 18 anos ou mais.",
  ],
  [
    /phone|\bddd\b/i,
    "mobilePhone",
    "informe o DDD e o número do celular, como (11) 90000-0000.",
  ],
  [/zip.?code|postal|\bcep\b/i, "zipCode", "informe os 8 números do CEP."],
  [/e-?mail/i, "email", "confira o endereço de e-mail."],
  [
    /\baccount\b/i,
    "account",
    "confira o número da conta e o dígito, como aparecem no app do banco.",
  ],
  [
    /\bbranch\b/i,
    "branch",
    "confira o número da agência e o dígito, se houver.",
  ],
  [/\bbank\b/i, "bank", "confira o banco escolhido ou o código de 3 números."],
];

function fieldFor(path: string): ReceivingFormField | null {
  return fieldPaths.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

function detail(message: string): string {
  return `Detalhe da Pagar.me: ${message.slice(0, PROVIDER_DETAIL_LIMIT)}`;
}

/** What to fix, in pt-BR, for a Pagar.me message about `path` (optional). */
function explain(message: string, path?: string) {
  const pathField = path ? fieldFor(path) : null;
  const known = knownMessages.find(
    ([pattern, field]) =>
      pattern.test(message) &&
      (field !== null || !pathField) &&
      (!pathField || field === pathField),
  );
  // A path that names the field wins over the wording of its message.
  const formField = pathField ?? known?.[1] ?? null;
  if (known) return { formField, hint: known[2], recognized: true };
  return {
    formField,
    hint: formField
      ? `confira este dado. ${detail(message)}`
      : `A Pagar.me recusou um dado do cadastro. Confira os dados e envie de novo. ${detail(message)}`,
    recognized: false,
  };
}

/**
 * Pagar.me's message in pt-BR, naming the field and what to fix; an unknown
 * message keeps its (already redacted and bounded) original as a detail.
 */
export function describePagarmeMessage(
  message: string,
  path?: string,
): { formField: ReceivingFormField | null; text: string } {
  const { formField, hint } = explain(message, path);
  return {
    formField,
    text: formField ? `${receivingFormLabels[formField]}: ${hint}` : hint,
  };
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
  const fields = parsed.data.fields.map(({ field, messages }) => {
    const formField = fieldFor(field);
    return {
      field,
      label: formField ? receivingFormLabels[formField] : "Outro dado",
      formField,
      messages: messages.map((message) => explain(message, field).hint),
    };
  });
  const general = parsed.data.message
    ? describePagarmeMessage(parsed.data.message)
    : null;
  // The generic "request is invalid" adds nothing when fields explain it.
  const message =
    general &&
    !(fields.length && /request is invalid/i.test(parsed.data.message ?? ""))
      ? general.text
      : null;
  const formFields = [
    ...new Set(
      [...fields.map((field) => field.formField), general?.formField].filter(
        (field): field is ReceivingFormField => !!field,
      ),
    ),
  ];
  return { message, fields, formFields };
}

/** The pt-BR error to show under each input the refusal points at. */
export function rejectionFieldErrors(
  rejection: LabeledProviderRejection,
): Partial<Record<ReceivingFormField, string>> {
  const errors: Partial<Record<ReceivingFormField, string>> = {};
  for (const formField of rejection.formFields) {
    const hints = rejection.fields
      .filter((field) => field.formField === formField)
      .flatMap((field) => field.messages);
    // Pointed at only by the general message, which already names it.
    if (!rejection.fields.some((field) => field.formField === formField)) {
      errors[formField] = rejection.message ?? receivingFormLabels[formField];
      continue;
    }
    errors[formField] = `${receivingFormLabels[formField]}: ${
      hints.length ? hints.join(" ") : "confira este dado."
    }`;
  }
  return errors;
}
