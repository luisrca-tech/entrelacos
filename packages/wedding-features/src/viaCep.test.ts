import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A fetch that never answers and rejects only when its signal aborts. */
function hanging() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("sends no referrer, so ViaCEP does not learn the couple site", async () => {
    const fetcher = respond(200, { localidade: "Sorriso", uf: "MT" });
    await lookupCep("78890000", fetcher);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      referrerPolicy: "no-referrer",
    });
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

  it("cuts each part to 64 characters", async () => {
    const fetcher = respond(200, {
      logradouro: ` ${"r".repeat(80)} `,
      bairro: "b".repeat(65),
      localidade: "c".repeat(64),
      uf: "SP",
    });
    expect(await lookupCep("01310100", fetcher)).toEqual({
      street: "r".repeat(64),
      neighborhood: "b".repeat(64),
      city: "c".repeat(64),
      state: "SP",
    });
  });

  it.each([
    ["an unknown CEP (erro as text)", respond(200, { erro: "true" })],
    ["an unknown CEP (erro as boolean)", respond(200, { erro: true })],
  ])("reports not_found on %s", async (_label, fetcher) => {
    expect(await lookupCep("01310100", fetcher)).toBe("not_found");
  });

  it.each([
    ["a server error", respond(500, {})],
    ["rate limiting", respond(429, {})],
    ["a malformed UF", respond(200, { localidade: "X", uf: "Sao" })],
    ["a null body", respond(200, null)],
    ["an array body", respond(200, [{ localidade: "X", uf: "SP" }])],
    [
      "a body that is not JSON",
      vi.fn<typeof fetch>(async () => new Response("<html>busy</html>")),
    ],
    [
      "a network failure",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("offline");
      }),
    ],
  ])(
    "reports unavailable on %s, so the guest types the address",
    async (_label, fetcher) => {
      expect(await lookupCep("01310100", fetcher)).toBe("unavailable");
    },
  );

  it("gives up after 5 seconds", async () => {
    vi.useFakeTimers();
    const fetcher = hanging();
    const result = lookupCep("01310100", fetcher);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await result).toBe("unavailable");
  });

  it("aborts the request when the caller cancels it", async () => {
    const fetcher = hanging();
    const controller = new AbortController();
    const result = lookupCep("01310100", fetcher, controller.signal);
    controller.abort();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await result).toBe("unavailable");
  });

  it("does not call ViaCEP for an incomplete CEP", async () => {
    const fetcher = respond(200, {});
    expect(await lookupCep("0131010", fetcher)).toBe("not_found");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
