export const setupAccountFields = [
  "name",
  "email",
  "cpfCnpj",
  "birthDate",
  "mobilePhone",
  "incomeValue",
  "postalCode",
  "address",
  "addressNumber",
  "province",
] as const;

const digitsOnly = new Set(["cpfCnpj", "mobilePhone", "postalCode"]);

// Parses a Brazilian money value such as "R$ 3.500,50"; returns NaN when unsure.
export function parseIncome(value: string): number {
  const text = value.replace(/R\$/i, "").replace(/\s+/g, "");
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(text))
    return Number(text.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
  if (/^\d+(\.\d{1,2})?$/.test(text)) return Number(text);
  return Number.NaN;
}

// Accepts the masks people type; the contract schema still validates the result.
export function normalizeSetupAccount(
  values: Partial<Record<(typeof setupAccountFields)[number], unknown>>,
) {
  return Object.fromEntries(
    setupAccountFields.map((name) => {
      const raw = values[name];
      const text = typeof raw === "string" ? raw.trim() : "";
      if (name === "incomeValue") return [name, parseIncome(text)];
      return [name, digitsOnly.has(name) ? text.replace(/\D/g, "") : text];
    }),
  );
}

// People type CPF, CNPJ and phone keys with masks; the API expects digits.
export function normalizePixKey(
  type: "CPF" | "CNPJ" | "PHONE" | "EMAIL" | "EVP",
  key: string,
) {
  return ["CPF", "CNPJ", "PHONE"].includes(type)
    ? key.replace(/\D/g, "")
    : key.trim();
}
