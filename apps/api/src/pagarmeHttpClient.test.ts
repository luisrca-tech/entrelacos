import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPagarmeHttpClient,
  PAGARME_API_BASE_URL,
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";

const secretKey = "sk_test_fixtureSecret0123456789";

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
    "utf8",
  );
}

function respond(status: number, body: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function client(fetch: typeof globalThis.fetch, timeoutMs?: number) {
  return createPagarmeHttpClient({ secretKey, fetch, timeoutMs });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a rejection");
}

describe("Pagar.me HTTP client", () => {
  it("sends JSON with Basic auth (secret key, empty password) and an idempotency key", async () => {
    const fetch = respond(200, fixture("order-pix-pending"));
    const order = await client(fetch).request<{ id: string; status: string }>(
      "POST",
      "/orders",
      { body: { code: "checkout-fixture-1" }, idempotencyKey: "checkout-1" },
    );
    expect(order).toMatchObject({
      id: "or_fixtureOrder0001",
      status: "pending",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${PAGARME_API_BASE_URL}/orders`);
    expect(PAGARME_API_BASE_URL).toBe("https://api.pagar.me/core/v5");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("checkout-1");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "checkout-fixture-1",
    });
  });

  it("sends GET requests without body or idempotency key", async () => {
    const fetch = respond(200, fixture("order-pix-pending"));
    await client(fetch).request("GET", "/orders/or_fixtureOrder0001");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${PAGARME_API_BASE_URL}/orders/or_fixtureOrder0001`);
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("idempotency-key")).toBe(false);
  });

  it.each([
    "orders",
    "/../admin",
    "//evil.example/orders",
    "/orders?x=https://evil",
    "/orders\n",
  ])("refuses the unsafe path %j before any request", async (path) => {
    const fetch = respond(200, "{}");
    await expect(client(fetch).request("GET", path)).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an invalid idempotency key", async () => {
    const fetch = respond(200, "{}");
    await expect(
      client(fetch).request("POST", "/orders", { idempotencyKey: "a b" }),
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a 422 into a typed rejection with the provider message", async () => {
    const error = await failure(
      client(respond(422, fixture("error-422-validation"))).request(
        "POST",
        "/orders",
        { body: {} },
      ),
    );
    expect(error).toBeInstanceOf(PagarmeRejectedError);
    expect(error).toMatchObject({
      outcome: "rejected",
      status: 422,
      providerCode: "order.customer.document",
      providerMessage: "The request is invalid.",
    });
  });

  it("reads typed error arrays", async () => {
    const error = await failure(
      client(respond(400, fixture("error-400-typed"))).request(
        "GET",
        "/recipients/rp_missing",
      ),
    );
    expect(error).toMatchObject({
      outcome: "rejected",
      status: 400,
      providerCode: "not_found_error",
      providerMessage: "Recipient não encontrado.",
    });
  });

  it("never exposes the secret key in a rejection", async () => {
    const leaking = JSON.stringify({
      message: `Invalid key ${secretKey}`,
    });
    const error = await failure(
      client(respond(401, leaking)).request("GET", "/orders"),
    );
    expect(error).toBeInstanceOf(PagarmeRejectedError);
    expect(error).toMatchObject({ status: 401 });
    expect(
      JSON.stringify({ ...error, message: error.message, stack: error.stack }),
    ).not.toContain(secretKey);
    const unauthorized = await failure(
      client(respond(401, fixture("error-401-unauthorized"))).request(
        "GET",
        "/orders",
      ),
    );
    expect(unauthorized).toMatchObject({
      providerCode: null,
      providerMessage: "Authorization has been denied for this request.",
    });
  });

  it("rejects without a provider message on a non-JSON 4xx body", async () => {
    const error = await failure(
      client(respond(404, "<html>not found</html>")).request("GET", "/orders"),
    );
    expect(error).toMatchObject({
      outcome: "rejected",
      status: 404,
      providerCode: null,
      providerMessage: null,
    });
  });

  it("treats a 5xx as an unknown outcome", async () => {
    const error = await failure(
      client(respond(502, fixture("error-500"))).request("POST", "/orders", {
        body: {},
      }),
    );
    expect(error).toBeInstanceOf(PagarmeUnknownOutcomeError);
    expect(error).toMatchObject({
      outcome: "unknown",
      reason: "server",
      status: 502,
    });
  });

  it("treats a network failure as an unknown outcome without leaking the cause", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(`connect failed with ${secretKey}`);
    });
    const error = await failure(client(fetch).request("GET", "/orders"));
    expect(error).toBeInstanceOf(PagarmeUnknownOutcomeError);
    expect(error).toMatchObject({ outcome: "unknown", reason: "network" });
    expect(String(error)).not.toContain(secretKey);
  });

  it("aborts and reports an unknown outcome after the timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const error = await failure(client(fetch, 20).request("GET", "/orders"));
    expect(signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(PagarmeUnknownOutcomeError);
    expect(error).toMatchObject({ outcome: "unknown", reason: "timeout" });
  });

  it("treats an unreadable success body as an unknown outcome", async () => {
    const error = await failure(
      client(respond(200, "not json")).request("POST", "/orders", { body: {} }),
    );
    expect(error).toMatchObject({
      outcome: "unknown",
      reason: "invalid_response",
      status: 200,
    });
  });

  it("refuses an invalid secret key at construction", () => {
    for (const key of ["", "pk_test_public", "sk_test_ with space"])
      expect(() => createPagarmeHttpClient({ secretKey: key })).toThrow(
        "Pagar.me client configuration is invalid",
      );
  });
});
