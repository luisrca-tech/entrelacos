import { describe, expect, it, vi } from "vitest";
import { type ApiOptions, createApp } from "./app";
import { createAsaasWithdrawalAuthorizationHttpRouter } from "./asaasWithdrawalAuthorizationHttp";

const path = "/v1/webhooks/asaas/withdrawal-authorization";
const token = "fixture-withdrawal-authorization-secret";
const raw = '{"type":"TRANSFER","transfer":{"id":"transfer-one"}}';
function request(body: BodyInit = raw, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "asaas-access-token": token,
      ...headers,
    },
    body,
  };
}

describe("Asaas withdrawal security HTTP boundary", () => {
  it.each(["APPROVED", "REFUSED"] as const)(
    "returns only the documented %s decision after the durable receiver finishes",
    async (status) => {
      const receive = vi.fn(async () => ({ status }));
      const response = await createAsaasWithdrawalAuthorizationHttpRouter({
        receive,
      }).request(path, request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status });
      expect(receive).toHaveBeenCalledExactlyOnceWith(token, raw);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );

  it("refuses when the authorization mode is not configured", async () => {
    const response =
      await createAsaasWithdrawalAuthorizationHttpRouter().request(
        path,
        request(),
      );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "REFUSED" });
  });

  it.each(["", "short", "a".repeat(256), `${"x".repeat(32)} y`])(
    "rejects invalid header credentials (%#)",
    async (header) => {
      const receive = vi.fn();
      const response = await createAsaasWithdrawalAuthorizationHttpRouter({
        receive,
      }).request(path, request(raw, { "asaas-access-token": header }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "REFUSED" });
      expect(receive).not.toHaveBeenCalled();
    },
  );

  it.each(["text/plain", "application/jsonish", "application/json-patch+json"])(
    "rejects media type %s",
    async (contentType) => {
      const receive = vi.fn();
      const response = await createAsaasWithdrawalAuthorizationHttpRouter({
        receive,
      }).request(path, request(raw, { "Content-Type": contentType }));
      expect(response.status).toBe(400);
      expect(receive).not.toHaveBeenCalled();
    },
  );

  it("rejects query parameters without echoing private data", async () => {
    const receive = vi.fn();
    const response = await createAsaasWithdrawalAuthorizationHttpRouter({
      receive,
    }).request(`${path}?token=private-value`, request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "REFUSED" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("bounds streamed bytes even with an incorrect content length", async () => {
    const receive = vi.fn();
    let canceled = false;
    const incoming = new Request(`https://api.example.test${path}`, {
      ...request(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(32768));
            controller.enqueue(new Uint8Array(32769));
          },
          cancel() {
            canceled = true;
          },
        }),
        { "Content-Length": "1" },
      ),
      duplex: "half",
    } as RequestInit);
    const response = await createAsaasWithdrawalAuthorizationHttpRouter({
      receive,
    }).fetch(incoming);
    expect(response.status).toBe(400);
    expect(canceled).toBe(true);
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 without invoking the decision service", async () => {
    const receive = vi.fn();
    const response = await createAsaasWithdrawalAuthorizationHttpRouter({
      receive,
    }).request(path, request(new Uint8Array([0xff])));
    expect(response.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });

  it("refuses a body that never finishes without starting authorization", async () => {
    vi.useFakeTimers();
    try {
      const receive = vi.fn();
      let canceled = false;
      const incoming = new Request(`https://api.example.test${path}`, {
        ...request(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
        duplex: "half",
      } as RequestInit);
      const pending = createAsaasWithdrawalAuthorizationHttpRouter({
        receive,
      }).fetch(incoming);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await Promise.race([
        Promise.resolve(pending),
        Promise.resolve(null),
      ]);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(400);
      expect(canceled).toBe(true);
      expect(receive).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes service exceptions and invalid decisions", async () => {
    for (const receive of [
      vi.fn(async () => {
        throw new Error("private-provider-error");
      }),
      vi.fn(async () => ({ status: "DONE" })),
      vi.fn(async () => ({ status: "APPROVED", secret: "private" })),
      vi.fn(async () => ({ accepted: true })),
    ]) {
      const response = await createAsaasWithdrawalAuthorizationHttpRouter({
        receive,
      } as never).request(path, request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "REFUSED" });
    }
  });

  it("does not acknowledge approval before durable work resolves", async () => {
    let finish!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const receive = vi.fn(async () => {
      start();
      await pending;
      return { status: "APPROVED" as const };
    });
    let responded = false;
    const response = Promise.resolve(
      createAsaasWithdrawalAuthorizationHttpRouter({ receive }).request(
        path,
        request(),
      ),
    ).then((value) => {
      responded = true;
      return value;
    });
    await started;
    expect(responded).toBe(false);
    finish();
    expect((await response).status).toBe(200);
  });

  it("dispatches the actual application security route independently from payment events and browser authentication", async () => {
    const receive = vi.fn(async () => ({ status: "APPROVED" as const }));
    const payment = vi.fn(async () => ({ accepted: true as const }));
    const app = createApp({
      db: {},
      auth: {
        api: {
          getSession: vi.fn(() => {
            throw new Error("Browser auth must not run");
          }),
        },
      },
      asaasWithdrawalAuthorization: { receive },
      asaasWebhook: { receive: payment },
    } as unknown as ApiOptions);
    try {
      const response = await app.request(path, request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "APPROVED" });
      expect(receive).toHaveBeenCalledExactlyOnceWith(token, raw);
      expect(payment).not.toHaveBeenCalled();
      const notification = await app.request("/v1/webhooks/asaas", request());
      expect(await notification.json()).toEqual({ accepted: true });
      expect(payment).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
