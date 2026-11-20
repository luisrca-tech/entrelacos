import { normalizeBankCode, otherBankValue } from "./brazilianBanks";

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
      referencePoint: text("referencePoint"),
    },
    bankAccount: {
      bank: normalizeBankCode(
        bank === otherBankValue ? text("bankCode") : bank,
      ),
      ...branch,
      ...account,
      type: text("accountType"),
    },
  };
}
