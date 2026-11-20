// Common banks for the receiving bank account, by COMPE code. Codes were
// checked against the Central Bank participant list (via BrasilAPI) in
// 2026-11; anything missing goes through "Outro banco".
const banks = [
  { name: "Nubank", code: "260" },
  { name: "Itaú", code: "341" },
  { name: "Bradesco", code: "237" },
  { name: "Caixa", code: "104" },
  { name: "Banco do Brasil", code: "001" },
  { name: "Santander", code: "033" },
  { name: "Inter", code: "077" },
  { name: "C6 Bank", code: "336" },
  { name: "BTG Pactual", code: "208" },
  { name: "Sicoob", code: "756" },
  { name: "Sicredi", code: "748" },
  { name: "PagBank", code: "290" },
  { name: "Mercado Pago", code: "323" },
  { name: "Banrisul", code: "041" },
] as const;

export const brazilianBanks = banks.map((bank) => ({
  ...bank,
  label: `${bank.name} (${bank.code})`,
}));

/** Select value that reveals the free-text bank code field. */
export const otherBankValue = "other";

/**
 * Bank apps such as Nubank show the COMPE code with a leading zero ("0260").
 * Anything that is not 3 digits, or 4 with a leading zero, is returned as is
 * so the contract schema rejects it.
 */
export function normalizeBankCode(value: string): string {
  const code = value.trim();
  return /^0\d{3}$/.test(code) ? code.slice(1) : code;
}
