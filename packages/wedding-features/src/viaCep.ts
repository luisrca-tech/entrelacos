/** Address parts ViaCEP can fill; number and complement stay with the guest. */
export type CepAddress = {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
};

/**
 * `not_found`: ViaCEP answered that the CEP does not exist.
 * `unavailable`: no usable answer (network, timeout, 5xx, rate limit, odd body).
 */
export type CepLookupResult = CepAddress | "not_found" | "unavailable";

export const VIA_CEP_TIMEOUT_MS = 5_000;

export function viaCepUrl(cep: string): string {
  return `https://viacep.com.br/ws/${cep}/json/`;
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 64) : "";

/**
 * Looks up a CEP on ViaCEP to save typing. Any failure returns a status and
 * the guest fills the address by hand, so the checkout never depends on this
 * service. The request carries no referrer, gives up after 5 seconds and stops
 * when `signal` aborts.
 */
export async function lookupCep(
  value: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CepLookupResult> {
  const cep = value.replace(/[^0-9]/g, "");
  if (cep.length !== 8) return "not_found";
  // A plain controller instead of AbortSignal.any/timeout keeps older mobile
  // browsers supported.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, VIA_CEP_TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetcher(viaCepUrl(cep), {
      headers: { accept: "application/json" },
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return "unavailable";
    if ("erro" in body) return "not_found";
    const fields = body as Record<string, unknown>;
    const state = text(fields.uf).toUpperCase();
    const city = text(fields.localidade);
    if (!/^[A-Z]{2}$/.test(state) || !city) return "unavailable";
    return {
      street: text(fields.logradouro),
      neighborhood: text(fields.bairro),
      city,
      state,
    };
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
