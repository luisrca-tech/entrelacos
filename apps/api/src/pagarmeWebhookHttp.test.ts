import { describe, expect, it, vi } from "vitest";
import { PagarmeWebhookError } from "./pagarmeWebhook";
import { createPagarmeWebhookHttpRouter } from "./pagarmeWebhookHttp";

const url = "http://api.test/v1/webhooks/pagarme";
const body = JSON.stringify({ id: "hook_1", type: "order.paid", data: {} });

function post(
  init: { headers?: Record<string, string>; body?: string; url?: string } = {},
) {
  return new Request(init.url ?? url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic dXNlcjpwYXNz",
      ...init.headers,
    },
    body: init.body ?? body,
  });
}

describe("POST /v1/webhooks/pagarme", () => {
  it("passes the Authorization header and the raw body to the receiver", async () => {
    const receive = vi.fn(async () => ({ accepted: true as const }));
    const response = await createPagarmeWebhookHttpRouter({ receive }).fetch(
      post(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(receive).toHaveBeenCalledWith("Basic dXNlcjpwYXNz", body);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 401 when the receiver denies the credentials", async () => {
    const receive = vi.fn(async () => {
      throw new PagarmeWebhookError(401, "WEBHOOK_AUTH_DENIED");
    });
    const response = await createPagarmeWebhookHttpRouter({ receive }).fetch(
      post({ headers: { authorization: "" } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="pagarme-webhook"',
    );
    expect((await response.json()).code).toBe("WEBHOOK_AUTH_DENIED");
  });

  it("rejects query strings, other media types and oversized bodies", async () => {
    const receive = vi.fn(async () => ({ accepted: true as const }));
    const router = createPagarmeWebhookHttpRouter({ receive });
    expect((await router.fetch(post({ url: `${url}?x=1` }))).status).toBe(400);
    expect(
      (await router.fetch(post({ headers: { "content-type": "text/plain" } })))
        .status,
    ).toBe(400);
    expect(
      (await router.fetch(post({ body: `"${"x".repeat(70_000)}"` }))).status,
    ).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });

  it("is unavailable (503) when payments are disabled", async () => {
    expect((await createPagarmeWebhookHttpRouter().fetch(post())).status).toBe(
      503,
    );
  });
});
