import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import {
  PlatformWebhookRegistrationError,
  platformWebhookEvents,
  registerPlatformWebhook,
} from "./platformWebhookRegistration";

const token = "platform-webhook-token-0123456789-abcdef";
const url = "https://api.example.test/v1/webhooks/asaas";

function fixture(
  options: {
    mode?: "sandbox" | "live";
    apiKey?: string;
    remote?: Record<string, unknown>[];
    walletId?: string;
  } = {},
) {
  const mode = options.mode ?? "sandbox";
  const config: GiftPaymentConfig = {
    mode,
    applicationEnvironment: mode === "live" ? "production" : "development",
    platformApiKey:
      options.apiKey ??
      (mode === "live" ? "$aact_prod_private-key" : "$aact_hmlg_private-key"),
    platformAccountId: "platform-account",
    platformWalletId: "platform-wallet",
    platformWebhookTokenHash: createHash("sha256").update(token).digest("hex"),
    credentialKeyId: "key-v1",
    credentialKeyring: new Map([["key-v1", Buffer.alloc(32, 7)]]),
    webhookPublicOrigin: "https://api.example.test",
    webhookUrl: url,
  };
  const remote = options.remote ?? [];
  const stored = new Map<string, Record<string, unknown>>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (target, request) => {
    const { pathname } = new URL(String(target));
    const method = request?.method ?? "GET";
    if (method === "GET" && pathname === "/v3/wallets/")
      return Response.json({
        data: [{ id: options.walletId ?? "platform-wallet" }],
        hasMore: false,
      });
    if (method === "GET" && pathname === "/v3/webhooks")
      return Response.json({ data: remote, hasMore: false });
    if (method === "POST" && pathname === "/v3/webhooks") {
      const body = JSON.parse(String(request?.body));
      const { authToken: _token, ...rest } = body;
      stored.set("webhook-new", {
        ...rest,
        id: "webhook-new",
        hasAuthToken: true,
      });
      return Response.json({ id: "webhook-new" });
    }
    const match = /^\/v3\/webhooks\/([^/]+)$/.exec(pathname);
    if (match && method === "PUT") {
      const body = JSON.parse(String(request?.body));
      const { authToken: _token, ...rest } = body;
      stored.set(match[1], { ...rest, id: match[1], hasAuthToken: true });
      return Response.json({ ...rest, id: match[1], hasAuthToken: true });
    }
    if (match && method === "GET" && stored.has(match[1]))
      return Response.json(stored.get(match[1]));
    return Response.json({ errors: [{ code: "not_found" }] }, { status: 404 });
  });
  return { config, fetch };
}

function calls(fetch: ReturnType<typeof fixture>["fetch"]) {
  return fetch.mock.calls.map(
    ([target, request]) =>
      `${request?.method ?? "GET"} ${new URL(String(target)).pathname}`,
  );
}

describe("registerPlatformWebhook", () => {
  it("plans a creation without writing when no webhook owns the URL", async () => {
    const { config, fetch } = fixture({
      remote: [{ id: "other", name: "other", url: "https://other.test/hook" }],
    });
    const result = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token },
      { fetch },
    );
    expect(result).toEqual({
      action: "CREATE",
      state: "PLANNED",
      providerWebhookId: null,
      name: "entrelacos-platform-sandbox",
      url,
      eventCount: platformWebhookEvents.length,
    });
    expect(calls(fetch)).toEqual(["GET /v3/wallets/", "GET /v3/webhooks"]);
  });

  it("leaves another environment's platform webhook with the same name untouched", async () => {
    const { config, fetch } = fixture({
      remote: [
        {
          id: "dev",
          name: "entrelacos-platform-sandbox",
          url: "https://dev.example.test/v1/webhooks/asaas",
        },
      ],
    });
    const result = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token },
      { fetch },
    );
    expect(result).toMatchObject({
      action: "CREATE",
      providerWebhookId: null,
    });
  });

  it("creates the webhook on apply with the platform key and token", async () => {
    const { config, fetch } = fixture();
    const result = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token, notificationEmail: "ops@example.test" },
      { fetch, apply: true },
    );
    expect(result.state).toBe("REGISTERED");
    expect(result.providerWebhookId).toBe("webhook-new");
    expect(calls(fetch)).toEqual([
      "GET /v3/wallets/",
      "GET /v3/webhooks",
      "POST /v3/webhooks",
      "GET /v3/webhooks/webhook-new",
    ]);
    const post = fetch.mock.calls[2];
    expect(String(post[0])).toBe("https://api-sandbox.asaas.com/v3/webhooks");
    expect(post[1]?.redirect).toBe("error");
    expect(
      (post[1]?.headers as Record<string, string> | undefined)?.access_token,
    ).toBe("$aact_hmlg_private-key");
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      name: "entrelacos-platform-sandbox",
      url,
      email: "ops@example.test",
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: token,
      sendType: "SEQUENTIALLY",
      events: [...platformWebhookEvents],
    });
  });

  it("omits email when no notification email is configured", async () => {
    const { config, fetch } = fixture();
    await registerPlatformWebhook(
      config,
      { platformWebhookToken: token },
      { fetch, apply: true },
    );
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).not.toHaveProperty(
      "email",
    );
  });

  it("updates the existing webhook found by URL instead of creating", async () => {
    const { config, fetch } = fixture({
      mode: "live",
      remote: [{ id: "webhook-old", name: "legacy", url }],
    });
    const planned = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token },
      { fetch },
    );
    expect(planned).toMatchObject({
      action: "UPDATE",
      state: "PLANNED",
      providerWebhookId: "webhook-old",
    });
    fetch.mockClear();
    const result = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token },
      { fetch, apply: true },
    );
    expect(result).toMatchObject({
      action: "UPDATE",
      state: "REGISTERED",
      providerWebhookId: "webhook-old",
      name: "entrelacos-platform-live",
    });
    expect(calls(fetch)).toEqual([
      "GET /v3/wallets/",
      "GET /v3/webhooks",
      "PUT /v3/webhooks/webhook-old",
      "GET /v3/webhooks/webhook-old",
    ]);
    expect(
      String(fetch.mock.calls[2][0]).startsWith("https://api.asaas.com/"),
    ).toBe(true);
  });

  it("refuses two webhooks with this URL", async () => {
    const { config, fetch } = fixture({
      remote: [
        { id: "a", name: "entrelacos-platform-sandbox", url },
        { id: "b", name: "other", url },
      ],
    });
    await expect(
      registerPlatformWebhook(
        config,
        { platformWebhookToken: token },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "WEBHOOK_AMBIGUOUS" });
  });

  it.each([
    ["sandbox", "$aact_prod_private-key"],
    ["live", "$aact_hmlg_private-key"],
    ["sandbox", "private-key"],
  ] as const)(
    "refuses a %s run with a mismatched key prefix",
    async (mode, apiKey) => {
      const { config, fetch } = fixture({ mode, apiKey });
      await expect(
        registerPlatformWebhook(
          config,
          { platformWebhookToken: token },
          { fetch },
        ),
      ).rejects.toMatchObject({ code: "API_KEY_MODE_MISMATCH" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses a token that does not match the configured hash", async () => {
    const { config, fetch } = fixture();
    await expect(
      registerPlatformWebhook(
        config,
        { platformWebhookToken: "x".repeat(40) },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "WEBHOOK_TOKEN_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a key that does not own the platform wallet", async () => {
    const { config, fetch } = fixture({ walletId: "couple-wallet" });
    await expect(
      registerPlatformWebhook(
        config,
        { platformWebhookToken: token },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_WALLET_MISMATCH" });
    expect(calls(fetch)).toEqual(["GET /v3/wallets/"]);
  });

  it("refuses disabled or mismatched environments", async () => {
    const { config, fetch } = fixture();
    await expect(
      registerPlatformWebhook(
        {
          ...config,
          applicationEnvironment: "production",
        } as GiftPaymentConfig,
        { platformWebhookToken: token },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_UNSUPPORTED" });
    await expect(
      registerPlatformWebhook(
        { mode: "disabled" },
        { platformWebhookToken: token },
        { fetch },
      ),
    ).rejects.toBeInstanceOf(PlatformWebhookRegistrationError);
  });

  it("reports sanitized provider rejections without secrets", async () => {
    const { config } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (target, request) => {
      const { pathname } = new URL(String(target));
      if (pathname === "/v3/wallets/")
        return Response.json({ data: [{ id: "platform-wallet" }] });
      if (request?.method === "GET")
        return Response.json({ data: [], hasMore: false });
      return Response.json(
        {
          errors: [
            { code: "invalid_events", description: `bad ${token}` },
            { code: "<script>", description: "x" },
          ],
        },
        { status: 400 },
      );
    });
    const error = await registerPlatformWebhook(
      config,
      { platformWebhookToken: token, notificationEmail: "ops@example.test" },
      { fetch, apply: true },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformWebhookRegistrationError);
    const { code, message } = error as PlatformWebhookRegistrationError;
    expect(code).toBe("PROVIDER_HTTP_400_POST:invalid_events");
    for (const secret of [token, "$aact_hmlg_private-key", "ops@example.test"])
      expect(`${code} ${message}`).not.toContain(secret);
  });

  it("reports UNKNOWN when a write outcome is uncertain", async () => {
    const { config } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (target, request) => {
      const { pathname } = new URL(String(target));
      if (pathname === "/v3/wallets/")
        return Response.json({ data: [{ id: "platform-wallet" }] });
      if (request?.method === "GET")
        return Response.json({ data: [], hasMore: false });
      throw new TypeError("network down");
    });
    await expect(
      registerPlatformWebhook(
        config,
        { platformWebhookToken: token },
        { fetch, apply: true },
      ),
    ).resolves.toMatchObject({ action: "CREATE", state: "UNKNOWN" });
  });

  it("subscribes each platform event exactly once", () => {
    expect(new Set(platformWebhookEvents).size).toBe(
      platformWebhookEvents.length,
    );
    expect(platformWebhookEvents).toContain("PAYMENT_SPLIT_DIVERGENCE_BLOCK");
    expect(Object.isFrozen(platformWebhookEvents)).toBe(true);
  });
});
