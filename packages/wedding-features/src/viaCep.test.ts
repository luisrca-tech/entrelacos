import { describe, expect, it, vi } from "vitest";
import { lookupCep, viaCepUrl } from "./viaCep";

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("ViaCEP lookup", () => {
  it("reads street, neighborhood, city and UF for an 8-digit CEP", async () => {
    const fetcher = respond(200, {
      cep: "01310-100",
      logradouro: "Avenida Paulista",
      complemento: "de 612 a 1510 - lado par",
      bairro: "Bela Vista",
      localidade: "São Paulo",
      uf: "SP",
    });
    expect(await lookupCep("01310-100", fetcher)).toEqual({
      street: "Avenida Paulista",
      neighborhood: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://viacep.com.br/ws/01310100/json/",
    );
    expect(viaCepUrl("01310100")).toBe(
      "https://viacep.com.br/ws/01310100/json/",
    );
  });

  it("keeps empty parts empty for a city-wide CEP", async () => {
    const fetcher = respond(200, {
      cep: "78890-000",
      logradouro: "",
      bairro: "",
      localidade: "Sorriso",
      uf: "MT",
    });
    expect(await lookupCep("78890000", fetcher)).toEqual({
      street: "",
      neighborhood: "",
      city: "Sorriso",
      state: "MT",
    });
  });

  it.each([
    ["an unknown CEP", respond(200, { erro: "true" })],
    ["a server error", respond(500, {})],
    ["a malformed UF", respond(200, { localidade: "X", uf: "Sao" })],
    [
      "a network failure",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("offline");
      }),
    ],
  ])(
    "returns null on %s, so the guest types the address",
    async (_label, fetcher) => {
      expect(await lookupCep("01310100", fetcher)).toBeNull();
    },
  );

  it("does not call ViaCEP for an incomplete CEP", async () => {
    const fetcher = respond(200, {});
    expect(await lookupCep("0131010", fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
