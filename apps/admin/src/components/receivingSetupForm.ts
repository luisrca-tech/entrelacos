import { RECEIVING_HOLDER_NAME_MAX_LENGTH } from "@entrelacos/contracts";
import type { z } from "zod";
import { normalizeBankCode, otherBankValue } from "./brazilianBanks";

/** The registration form inputs, by `name`. */
export const receivingFormLabels = {
  name: "Nome completo do titular",
  cpf: "CPF",
  birthDate: "Data de nascimento",
  email: "E-mail do titular",
  mobilePhone: "Celular com DDD",
  monthlyIncome: "Renda mensal aproximada",
  professionalOccupation: "Profissão",
  zipCode: "CEP",
  street: "Endereço",
  streetNumber: "Número",
  complement: "Complemento",
  neighborhood: "Bairro",
  city: "Cidade",
  state: "Estado (UF)",
  referencePoint: "Ponto de referência",
  bank: "Banco",
  accountType: "Tipo de conta",
  branch: "Agência",
  account: "Conta com dígito",
  holderName: "Nome do titular da conta",
} as const;
export type ReceivingFormField = keyof typeof receivingFormLabels;

// What each input accepts, in pt-BR, from the contract bounds
// (receivingSetupAccountSchema): shown before anything is sent.
const fieldHints: Record<ReceivingFormField, string> = {
  name: "preencha o nome completo, com até 128 caracteres.",
  cpf: "informe um CPF válido, com 11 números.",
  birthDate: "informe uma data válida; o titular precisa ter 18 anos ou mais.",
  email: "informe um e-mail válido, com até 254 caracteres.",
  mobilePhone: "informe o DDD e o número, com 10 ou 11 números.",
  monthlyIncome: "informe um valor em reais, como 3.500,00.",
  professionalOccupation: "preencha a profissão, com até 128 caracteres.",
  zipCode: "informe os 8 números do CEP.",
  street: "preencha o endereço, com até 256 caracteres.",
  streetNumber: "preencha o número, com até 32 caracteres.",
  complement: "use até 128 caracteres.",
  neighborhood: "preencha o bairro, com até 128 caracteres.",
  city: "preencha a cidade, com até 128 caracteres.",
  state: "use a sigla do estado, com 2 letras, como SP.",
  referencePoint: "use até 256 caracteres.",
  bank: "escolha o banco ou informe o código de 3 números.",
  accountType: "escolha o tipo de conta.",
  branch: "use até 4 números; o dígito, se houver, vai depois do hífen.",
  account: "informe a conta, com até 13 números, e o dígito.",
  holderName: `use de 2 a ${RECEIVING_HOLDER_NAME_MAX_LENGTH} caracteres, só letras, espaços, apóstrofo ou hífen, como aparece no banco.`,
};

// Contract paths (receivingSetupAccountSchema) to the input that holds them.
const contractFields: Record<string, ReceivingFormField> = {
  monthlyIncomeCents: "monthlyIncome",
  "address.street": "street",
  "address.streetNumber": "streetNumber",
  "address.complement": "complement",
  "address.neighborhood": "neighborhood",
  "address.city": "city",
  "address.state": "state",
  "address.zipCode": "zipCode",
  "address.referencePoint": "referencePoint",
  "bankAccount.bank": "bank",
  "bankAccount.branchNumber": "branch",
  "bankAccount.branchCheckDigit": "branch",
  "bankAccount.accountNumber": "account",
  "bankAccount.accountCheckDigit": "account",
  "bankAccount.type": "accountType",
  "bankAccount.holderName": "holderName",
};

/** One pt-BR error per input, from the contract's validation issues. */
export function accountFieldErrors(
  issues: readonly z.core.$ZodIssue[],
): Partial<Record<ReceivingFormField, string>> {
  const errors: Partial<Record<ReceivingFormField, string>> = {};
  for (const issue of issues) {
    const path = issue.path.join(".");
    const field =
      contractFields[path] ??
      (path in receivingFormLabels ? (path as ReceivingFormField) : null);
    if (field && !errors[field])
      errors[field] = `${receivingFormLabels[field]}: ${fieldHints[field]}`;
  }
  return errors;
}

// Parses a Brazilian money value such as "R$ 3.500,50"; returns NaN when unsure.
export function parseIncome(value: string): number {
  const text = value.replace(/R\$/i, "").replace(/\s+/g, "");
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(text))
    return Number(text.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
  if (/^\d+(\.\d{1,2})?$/.test(text)) return Number(text);
  return Number.NaN;
}

// Converts reais to integer cents through the decimal text to avoid float drift.
export function incomeToCents(value: string): number {
  const reais = parseIncome(value);
  if (!Number.isFinite(reais)) return Number.NaN;
  const [whole, fraction = ""] = reais.toFixed(2).split(".");
  return Number(whole) * 100 + Number(fraction);
}

/** "1234-5" or "0001"; only a hyphen separates the optional check digit. */
export function parseBranch(value: string) {
  const match = /^(\d{1,4})(?:-(\d))?$/.exec(value.replace(/\s/g, ""));
  if (!match) return null;
  const [, branchNumber, branchCheckDigit] = match;
  return branchCheckDigit
    ? { branchNumber, branchCheckDigit }
    : { branchNumber };
}

/** The last character (digit or X) is the check digit, hyphen optional. */
export function parseAccount(value: string) {
  const match = /^(\d+)-?([0-9X])$/i.exec(value.replace(/[\s.]/g, ""));
  if (!match) return null;
  return {
    accountNumber: match[1],
    accountCheckDigit: match[2].toUpperCase(),
  };
}

type SetupFormValues = Partial<Record<string, unknown>>;

// Accepts the masks people type; the contract schema still validates the result.
export function normalizeSetupAccount(values: SetupFormValues) {
  const text = (name: string) => {
    const raw = values[name];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const digits = (name: string) => text(name).replace(/\D/g, "");
  const complement = text("complement");
  const referencePoint = text("referencePoint");
  const bank = text("bank");
  // Unparseable input is kept raw so the contract schema rejects it.
  const branch = parseBranch(text("branch")) ?? {
    branchNumber: text("branch"),
  };
  const account = parseAccount(text("account")) ?? {
    accountNumber: text("account"),
    accountCheckDigit: "",
  };
  return {
    name: text("name"),
    email: text("email"),
    cpf: digits("cpf"),
    mobilePhone: digits("mobilePhone"),
    birthDate: text("birthDate"),
    monthlyIncomeCents: incomeToCents(text("monthlyIncome")),
    professionalOccupation: text("professionalOccupation"),
    address: {
      street: text("street"),
      streetNumber: text("streetNumber"),
      ...(complement ? { complement } : {}),
      neighborhood: text("neighborhood"),
      city: text("city"),
      state: text("state").toUpperCase(),
      zipCode: digits("zipCode"),
      ...(referencePoint ? { referencePoint } : {}),
    },
    bankAccount: {
      bank: normalizeBankCode(
        bank === otherBankValue ? text("bankCode") : bank,
      ),
      ...branch,
      ...account,
      holderName: text("holderName"),
      type: text("accountType"),
    },
  };
}
