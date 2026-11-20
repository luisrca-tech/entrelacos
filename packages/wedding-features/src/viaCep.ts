/** Address parts ViaCEP can fill; number and complement stay with the guest. */
export type CepAddress = {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
};

export function viaCepUrl(cep: string): string {
  return `https://viacep.com.br/ws/${cep}/json/`;
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 64) : "";

/**
 * Looks up a CEP on ViaCEP to save typing. Any failure (unknown CEP, network,
 * odd answer) returns null and the guest fills the address by hand, so the
 * checkout never depends on this service.
 */
export async function lookupCep(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<CepAddress | null> {
  const cep = value.replace(/[^0-9]/g, "");
  if (cep.length !== 8) return null;
  try {
    const response = await fetcher(viaCepUrl(cep), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || "erro" in body) return null;
    const state = text(body.uf).toUpperCase();
    const city = text(body.localidade);
    if (!/^[A-Z]{2}$/.test(state) || !city) return null;
    return {
      street: text(body.logradouro),
      neighborhood: text(body.bairro),
      city,
      state,
    };
  } catch {
    return null;
  }
}
