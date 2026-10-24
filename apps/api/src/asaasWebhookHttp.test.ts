import { describe, expect, it, vi } from "vitest";
import { AsaasWebhookError } from "./asaasWebhook";
import { createAsaasWebhookHttpRouter } from "./asaasWebhookHttp";

const path = "/v1/webhooks/asaas";
const token = "local-test-secret-webhook-token-for-http";
const raw = JSON.stringify({
  id: "evt_one",
  event: "PAYMENT_RECEIVED",
  account: { id: "account-one" },
  payment: { id: "pay_one" },
});
function request(body: string = raw, headers: Record<string, string> = {}) {
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
describe("dedicated Asaas webhook HTTP boundary", () => {
  it("stays unavailable when no durable receiver is configured", async () => {
    const response = await createAsaasWebhookHttpRouter().request(
      path,
      request(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "WEBHOOK_UNAVAILABLE",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("passes only the header token/raw body to the server receiver without a browser session or CORS", async () => {
    const receive = vi.fn(async () => ({ accepted: true as const }));
    const response = await createAsaasWebhookHttpRouter({ receive }).request(
      path,
      request(raw, { "Content-Type": "application/json; charset=utf-8" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(receive).toHaveBeenCalledExactlyOnceWith(token, raw);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["text/plain", "application/jsonish", "application/json-patch+json"])(
    "rejects unsupported content type %s without invoking the receiver",
    async (contentType) => {
      const receive = vi.fn();
      const response = await createAsaasWebhookHttpRouter({ receive }).request(
        path,
        request(raw, { "Content-Type": contentType }),
      );
      expect(response.status).toBe(400);
      expect(receive).not.toHaveBeenCalled();
    },
  );
  it("rejects query capabilities and never echoes token/payload in failures", async () => {
    const receive = vi.fn();
    const response = await createAsaasWebhookHttpRouter({ receive }).request(
      `${path}?token=${token}`,
      request(),
    );
    expect(response.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("pay_one");
  });
  it.each(["", "short", "a".repeat(256), `${"x".repeat(32)} y`])(
    "rejects invalid header authentication without invoking receiver: %s",
    async (header) => {
      const receive = vi.fn();
      const response = await createAsaasWebhookHttpRouter({ receive }).request(
        path,
        request(raw, { "asaas-access-token": header }),
      );
      expect(response.status).toBe(401);
      expect(receive).not.toHaveBeenCalled();
    },
  );
  it("enforces the byte limit while streaming even with misleading Content-Length", async () => {
    const receive = vi.fn();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32_768));
        controller.enqueue(new Uint8Array(32_769));
      },
      cancel() {
        canceled = true;
      },
    });
    const incoming = new Request(`https://api.example.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "1",
        "asaas-access-token": token,
      },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await createAsaasWebhookHttpRouter({ receive }).fetch(
      incoming,
    );
    expect(response.status).toBe(400);
    expect(canceled).toBe(true);
    expect(receive).not.toHaveBeenCalled();
  });
  it("rejects malformed UTF-8 before passing body to receiver", async () => {
    const receive = vi.fn();
    const response = await createAsaasWebhookHttpRouter({ receive }).request(
      path,
      { ...request(), body: new Uint8Array([0xff]) },
    );
    expect(response.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });
  it.each([
    new AsaasWebhookError(401, "WEBHOOK_AUTH_DENIED"),
    new AsaasWebhookError(400, "WEBHOOK_INVALID"),
    new Error("private-key"),
  ])("sanitizes receiver failure %s", async (error) => {
    const receive = vi.fn(async () => {
      throw error;
    });
    const response = await createAsaasWebhookHttpRouter({ receive }).request(
      path,
      request(),
    );
    expect(response.status).toBe(
      error instanceof AsaasWebhookError ? error.status : 503,
    );
    expect(await response.json()).toMatchObject({
      code:
        error instanceof AsaasWebhookError ? error.code : "WEBHOOK_UNAVAILABLE",
    });
  });
  it("waits for durable acknowledgement and rejects malformed acceptance", async () => {
    let release!: (result: { accepted: true }) => void;
    const pending = new Promise<{ accepted: true }>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let replied = false;
    const receive = vi.fn(() => {
      started();
      return pending;
    });
    const responsePromise = Promise.resolve(
      createAsaasWebhookHttpRouter({ receive }).request(path, request()),
    ).then((response) => {
      replied = true;
      return response;
    });
    await gate;
    expect(replied).toBe(false);
    release({ accepted: true });
    expect((await responsePromise).status).toBe(200);
    const invalid = vi.fn(async () => ({
      accepted: true as const,
      privateKey: "secret",
    }));
    expect(
      (
        await createAsaasWebhookHttpRouter({ receive: invalid }).request(
          path,
          request(),
        )
      ).status,
    ).toBe(503);
  });
});
