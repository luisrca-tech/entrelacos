import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { encryptProviderCredential } from "./providerCredentials";
import {
  registerSandboxWebhook,
  sandboxWebhookEvents,
} from "./sandboxWebhookRegistration";

function fixture() {
  const keyring = new Map([["sandbox-v1", Buffer.alloc(32, 19)]]);
  const context = {
    provider: "ASAAS" as const,
    siteId: "site-one",
    accountBindingId: "account-one",
    environment: "sandbox" as const,
  };
  const credential = encryptProviderCredential(
    "private-subaccount-key",
    context,
    keyring,
    "sandbox-v1",
  );
  const config: GiftPaymentConfig = {
    mode: "sandbox",
    applicationEnvironment: "development",
    platformApiKey: "private-platform-key",
    platformAccountId: "platform-account",
    platformWalletId: "platform-wallet",
    credentialKeyId: "sandbox-v1",
    credentialKeyring: keyring,
    webhookPublicOrigin: "https://tunnel.example.test",
    webhookUrl: "https://tunnel.example.test/v1/webhooks/asaas",
  };
  const input = {
    siteId: "site-one",
    accountId: "account-one",
    notificationEmail: "alerts@example.test",
  };
  const row = {
    id: "account-one",
    siteId: "site-one",
    provider: "ASAAS",
    environment: "sandbox",
    isCurrent: true,
    isDemo: true,
    accountReference: "child-account",
    recipientReference: "child-wallet",
    credentialVersion: 1,
    credentialKeyId: credential.keyId,
    credentialNonce: credential.nonce,
    credentialCiphertext: credential.ciphertext,
    credentialTag: credential.tag,
    webhookTokenHash: null as string | null,
    webhookRegistration: null as Record<string, unknown> | null,
  };
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: SQL) => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.startsWith("SELECT")) return { rows: [structuredClone(row)] };
    if (sql.startsWith("UPDATE")) {
      row.webhookTokenHash = params[0] as string;
      row.webhookRegistration = JSON.parse(params[1] as string);
      return { rows: [{ id: row.id }] };
    }
    throw new Error("Unexpected SQL");
  });
  let tail = Promise.resolve<unknown>(undefined);
  const transaction = vi.fn(
    (operation: (tx: { execute: typeof execute }) => Promise<unknown>) => {
      const result = tail.then(() => operation({ execute }));
      tail = result.catch(() => {});
      return result;
    },
  );
  const db = { execute, transaction } as never;
  const remote: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v3/wallets/")
      return Response.json({ data: [{ id: "child-wallet" }], hasMore: false });
    if (path === "/v3/webhooks" && request?.method === "GET")
      return Response.json({ data: remote, hasMore: false });
    if (path === "/v3/webhooks" && request?.method === "POST") {
      expect(row.webhookRegistration?.state).toBe("ARMED");
      expect(row.webhookTokenHash).toMatch(/^[a-f0-9]{64}$/);
      const body = JSON.parse(request.body as string);
      remote.push({
        ...body,
        id: "webhook-one",
        authToken: undefined,
        hasAuthToken: true,
      });
      return Response.json({ ...body, id: "webhook-one", hasAuthToken: true });
    }
    if (path === "/v3/webhooks/webhook-one" && request?.method === "PUT") {
      expect(row.webhookRegistration?.state).toBe("UPDATING");
      const body = JSON.parse(request.body as string);
      remote[0] = {
        ...body,
        id: "webhook-one",
        authToken: undefined,
        hasAuthToken: true,
      };
      return Response.json({ ...body, id: "webhook-one", hasAuthToken: true });
    }
    throw new Error("Unexpected provider request");
  });
  return { config, input, row, db, execute, transaction, remote, fetch };
}

describe("Sandbox webhook registration operation", () => {
  it("subscribes to refund and dispute facts before enabling financial availability", () => {
    expect(sandboxWebhookEvents).toEqual(
      expect.arrayContaining([
        "PAYMENT_REFUNDED",
        "PAYMENT_PARTIALLY_REFUNDED",
        "PAYMENT_REFUND_IN_PROGRESS",
        "PAYMENT_CHARGEBACK_REQUESTED",
        "PAYMENT_CHARGEBACK_DISPUTE",
        "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
      ]),
    );
  });
  it("restores the stored token through PUT before accepting a reconciled webhook", async () => {
    const values = fixture();
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    values.remote[0].hasAuthToken = false;
    await expect(
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toMatchObject({ state: "REGISTERED" });
    const post = values.fetch.mock.calls.find(
      ([, request]) => request?.method === "POST",
    );
    const put = values.fetch.mock.calls.find(
      ([, request]) => request?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse(put?.[1]?.body as string).authToken).toBe(
      JSON.parse(post?.[1]?.body as string).authToken,
    );
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("updates a restarted tunnel URL on the existing provider ID with the same scoped token", async () => {
    const values = fixture();
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    const originalHash = values.row.webhookTokenHash;
    const config = {
      ...values.config,
      webhookPublicOrigin: "https://restarted.example.test",
      webhookUrl: "https://restarted.example.test/v1/webhooks/asaas",
    };
    await expect(
      registerSandboxWebhook(values.db, config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toEqual({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    expect(values.row.webhookRegistration).toMatchObject({
      state: "REGISTERED",
      url: config.webhookUrl,
      providerWebhookId: "webhook-one",
    });
    expect(values.row.webhookTokenHash).toBe(originalHash);
    expect(values.remote).toHaveLength(1);
    expect(values.remote[0].url).toBe(config.webhookUrl);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "PUT",
      ),
    ).toHaveLength(1);
  });

  it("reapplies the stored token even when the provider reports an authentication token already exists", async () => {
    const values = fixture();
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    const put = values.fetch.mock.calls.find(
      ([, request]) => request?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse(put?.[1]?.body as string).events).toEqual(
      sandboxWebhookEvents,
    );
  });

  it("retries uncertain idempotent updates with the known provider ID and never another POST", async () => {
    const values = fixture();
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    const original = values.fetch.getMockImplementation();
    if (!original) throw new Error("Missing native fixture");
    let failOnce = true;
    values.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1]?.method === "PUT" && failOnce) {
        failOnce = false;
        throw new Error("Lost PUT response");
      }
      return response;
    });
    await expect(
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toEqual({ state: "UNKNOWN", providerWebhookId: "webhook-one" });
    expect(values.row.webhookRegistration?.state).toBe("UPDATING");
    await expect(
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toEqual({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "PUT",
      ),
    ).toHaveLength(2);
  });

  it.each(["foreign-marker", "foreign-provider-id", "conflicting-url"])(
    "refuses to overwrite an unrelated remote configuration (%s)",
    async (conflict) => {
      const values = fixture();
      await registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      });
      if (conflict === "foreign-marker")
        values.remote[0].name = "another-system";
      if (conflict === "foreign-provider-id")
        values.remote[0].id = "another-webhook";
      if (conflict === "conflicting-url")
        values.remote.push({
          ...values.remote[0],
          id: "another-webhook",
          name: "another-system",
        });
      await expect(
        registerSandboxWebhook(values.db, values.config, values.input, {
          fetch: values.fetch,
        }),
      ).rejects.toThrow("Sandbox webhook registration unavailable");
      expect(
        values.fetch.mock.calls.filter(
          ([, request]) => request?.method === "PUT",
        ),
      ).toHaveLength(0);
      expect(
        values.fetch.mock.calls.filter(
          ([, request]) => request?.method === "POST",
        ),
      ).toHaveLength(1);
    },
  );

  it("can retry an unacknowledged URL update when the previous PUT never reached the provider", async () => {
    const values = fixture();
    await registerSandboxWebhook(values.db, values.config, values.input, {
      fetch: values.fetch,
    });
    const config = {
      ...values.config,
      webhookPublicOrigin: "https://restarted.example.test",
      webhookUrl: "https://restarted.example.test/v1/webhooks/asaas",
    };
    const original = values.fetch.getMockImplementation();
    if (!original) throw new Error("Missing native fixture");
    let first = true;
    values.fetch.mockImplementation(async (...args) => {
      if (args[1]?.method === "PUT" && first) {
        first = false;
        throw new Error("Request not acknowledged");
      }
      return original(...args);
    });
    await expect(
      registerSandboxWebhook(values.db, config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toMatchObject({
      state: "UNKNOWN",
      providerWebhookId: "webhook-one",
    });
    expect(values.remote[0].url).toBe(values.config.webhookUrl);
    await expect(
      registerSandboxWebhook(values.db, config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toMatchObject({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    expect(values.remote[0].url).toBe(config.webhookUrl);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("persists an encrypted account token and authentication hash before one native creation with twelve exact events", async () => {
    const values = fixture();
    const result = await registerSandboxWebhook(
      values.db,
      values.config,
      values.input,
      { fetch: values.fetch },
    );
    expect(result).toEqual({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    const calls = values.fetch.mock.calls;
    expect(
      calls.map(([url, request]) => [
        new URL(String(url)).pathname,
        request?.method,
      ]),
    ).toEqual([
      ["/v3/wallets/", "GET"],
      ["/v3/webhooks", "GET"],
      ["/v3/webhooks", "POST"],
    ]);
    const post = JSON.parse(calls[2][1]?.body as string);
    expect(post.events).toEqual([
      "CHECKOUT_CREATED",
      "CHECKOUT_PAID",
      "CHECKOUT_CANCELED",
      "CHECKOUT_EXPIRED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_RECEIVED",
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_REFUND_IN_PROGRESS",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]);
    expect(post.url).toBe(values.config.webhookUrl);
    expect(post.authToken.length).toBeGreaterThanOrEqual(32);
    expect(values.row.webhookTokenHash).toBe(
      createHash("sha256").update(post.authToken).digest("hex"),
    );
    expect(JSON.stringify(values.row.webhookRegistration)).not.toContain(
      post.authToken,
    );
    expect(values.row.webhookRegistration).toMatchObject({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    for (const [, request] of calls)
      expect(request?.headers).toMatchObject({
        access_token: "private-subaccount-key",
      });
    expect(JSON.stringify(result)).not.toMatch(/private|authToken|ciphertext/);
  });

  it("serializes concurrent arm attempts and never creates a second webhook", async () => {
    const values = fixture();
    const original = values.fetch.getMockImplementation();
    if (!original) throw new Error("Missing native fixture");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lists = 0;
    values.fetch.mockImplementation(async (...args) => {
      if (
        args[1]?.method === "GET" &&
        new URL(String(args[0])).pathname === "/v3/webhooks"
      ) {
        lists++;
        if (lists === 2) release();
        await barrier;
        return Response.json({ data: [], hasMore: false });
      }
      return original(...args);
    });
    const results = await Promise.all([
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ]);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(results.some((result) => result.state === "REGISTERED")).toBe(true);
  });

  it("reconciles an uncertain POST through GET without creating again or losing the stored secret", async () => {
    const values = fixture();
    const original = values.fetch.getMockImplementation();
    if (!original) throw new Error("Missing native fixture");
    values.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1]?.method === "POST")
        throw new Error("Timeout after native creation");
      return response;
    });
    await expect(
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toMatchObject({ state: "UNKNOWN" });
    expect(values.row.webhookRegistration?.state).toBe("ARMED");
    const hash = values.row.webhookTokenHash;
    await expect(
      registerSandboxWebhook(values.db, values.config, values.input, {
        fetch: values.fetch,
      }),
    ).resolves.toMatchObject({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    expect(values.row.webhookTokenHash).toBe(hash);
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("never repeats an uncertain POST even when no remote result is visible", async () => {
    const values = fixture();
    const original = values.fetch.getMockImplementation();
    if (!original) throw new Error("Missing native fixture");
    values.fetch.mockImplementation(async (...args) => {
      if (args[1]?.method === "POST") throw new Error("Connection uncertainty");
      return original(...args);
    });
    for (let index = 0; index < 2; index++)
      await expect(
        registerSandboxWebhook(values.db, values.config, values.input, {
          fetch: values.fetch,
        }),
      ).resolves.toMatchObject({ state: "UNKNOWN" });
    expect(
      values.fetch.mock.calls.filter(
        ([, request]) => request?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it.each([
    { mode: "live", applicationEnvironment: "production" },
    { mode: "sandbox", applicationEnvironment: "production" },
    { mode: "disabled" },
    { webhookUrl: "https://other.example.test/v1/webhooks/asaas" },
    {
      webhookPublicOrigin: "http://localhost:8080",
      webhookUrl: "http://localhost:8080/v1/webhooks/asaas",
    },
  ])(
    "rejects invalid operation configuration before private reads or I/O (%#)",
    async (override) => {
      const values = fixture();
      await expect(
        registerSandboxWebhook(
          values.db,
          { ...values.config, ...override } as GiftPaymentConfig,
          values.input,
          { fetch: values.fetch },
        ),
      ).rejects.toThrow("Sandbox webhook registration unavailable");
      expect(values.execute).not.toHaveBeenCalled();
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { siteId: "other-site" },
    { environment: "live" },
    { provider: "OTHER" },
    { isCurrent: false },
    { isDemo: false },
    { recipientReference: "other-wallet" },
  ])(
    "rejects mismatched persisted/provider account scope without native writes (%j)",
    async (override) => {
      const values = fixture();
      Object.assign(values.row, override);
      await expect(
        registerSandboxWebhook(values.db, values.config, values.input, {
          fetch: values.fetch,
        }),
      ).rejects.toThrow("Sandbox webhook registration unavailable");
      expect(
        values.fetch.mock.calls.filter(
          ([, request]) => request?.method === "POST",
        ),
      ).toHaveLength(0);
    },
  );

  it("retains the twelve-event registration contract", () =>
    expect(sandboxWebhookEvents).toHaveLength(12));
});
