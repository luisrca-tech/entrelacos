import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPagarmeCardToken,
  PagarmeCardTokenError,
  parseCardExpiry,
} from "./pagarmeCardToken";

const card = {
  number: "4000000000000010",
  holderName: "Maria Silva",
  expMonth: 12,
  expYear: 2030,
  cvv: "123",
};

function tokenFetcher(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    response.clone(),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Pagar.me card tokenization", () => {
  it("posts the card straight to Pagar.me with the public key and returns the token id", async () => {
    const fetcher = tokenFetcher(
      Response.json({ id: "token_abc123", type: "card" }),
    );
    await expect(
      createPagarmeCardToken(card, { publicKey: "pk_test_key1", fetcher }),
    ).resolves.toBe("token_abc123");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.pagar.me/core/v5/tokens?appId=pk_test_key1",
    );
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "card",
      card: {
        number: "4000000000000010",
        holder_name: "Maria Silva",
        exp_month: 12,
        exp_year: 2030,
        cvv: "123",
      },
    });
  });

  it("refuses a missing or secret key without sending the card", async () => {
    const fetcher = tokenFetcher(Response.json({ id: "token_x" }));
    for (const publicKey of ["", undefined, "sk_test_secret"]) {
      await expect(
        createPagarmeCardToken(card, { publicKey, fetcher }),
      ).rejects.toMatchObject({ code: "TOKENIZATION_UNAVAILABLE" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies refusals and never leaks or logs card data", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const cases = [
      [Response.json({ message: "invalid" }, { status: 422 }), "CARD_INVALID"],
      [Response.json({}, { status: 500 }), "TOKENIZATION_UNAVAILABLE"],
      [Response.json({ id: "not-a-token" }), "TOKENIZATION_UNAVAILABLE"],
    ] as const;
    for (const [response, code] of cases) {
      const failure = await createPagarmeCardToken(card, {
        publicKey: "pk_test_key1",
        fetcher: tokenFetcher(response),
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(PagarmeCardTokenError);
      expect(failure).toMatchObject({ code });
      expect(JSON.stringify(failure)).not.toContain(card.number);
      expect(String((failure as Error).message)).not.toMatch(/4000|123/);
    }
    const network = await createPagarmeCardToken(card, {
      publicKey: "pk_test_key1",
      fetcher: vi.fn().mockRejectedValue(new TypeError(card.number)),
    }).catch((cause: unknown) => cause);
    expect(network).toMatchObject({ code: "TOKENIZATION_UNAVAILABLE" });
    expect(String((network as Error).message)).not.toContain(card.number);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads MM/AA expiry as a four-digit year", () => {
    expect(parseCardExpiry("07/31")).toEqual({ expMonth: 7, expYear: 2031 });
    expect(parseCardExpiry("12 / 2030")).toEqual({
      expMonth: 12,
      expYear: 2030,
    });
    expect(parseCardExpiry("13/30")).toBeNull();
    expect(parseCardExpiry("1230")).toEqual({ expMonth: 12, expYear: 2030 });
    expect(parseCardExpiry("ab")).toBeNull();
  });
});
