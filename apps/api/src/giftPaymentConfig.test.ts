import { describe, expect, it } from "vitest";
import { readGiftPaymentConfig } from "./giftPaymentConfig";

const configured = {
  ASAAS_MODE: "sandbox",
  ASAAS_API_KEY: "$aact_fixture-private-key",
  ASAAS_PLATFORM_ACCOUNT_ID: "platform-account",
  ASAAS_PLATFORM_WALLET_ID: "platform-wallet",
  ASAAS_CREDENTIAL_KEY_ID: "sandbox-v1",
  ASAAS_CREDENTIAL_KEY: Buffer.alloc(32, 19).toString("base64"),
  ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test",
};

describe("gift payment runtime configuration", () => {
  it("enables a separate Sandbox withdrawal authorization endpoint only with its own token", () => {
    const authorizationToken = "fixture-withdrawal-authorization-secret";
    const result = readGiftPaymentConfig(
      {
        ...configured,
        ASAAS_WITHDRAWAL_AUTHORIZATION_TOKEN: authorizationToken,
      },
      "development",
    );
    expect(result).toMatchObject({
      withdrawalAuthorization: {
        token: authorizationToken,
        url: "https://webhook.example.test/v1/webhooks/asaas/withdrawal-authorization",
      },
    });
    expect(readGiftPaymentConfig(configured, "development")).not.toHaveProperty(
      "withdrawalAuthorization",
    );
  });

  it.each([
    "",
    "short",
    "x".repeat(256),
    `${"x".repeat(32)} y`,
    `${"x".repeat(32)}\n`,
  ])(
    "rejects malformed withdrawal authorization secrets without echoing them (%#)",
    (token) => {
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, ASAAS_WITHDRAWAL_AUTHORIZATION_TOKEN: token },
          "development",
        ),
      ).toThrow("Gift payment configuration is invalid");
    },
  );

  it("enables the distinct authenticated withdrawal callback in live production", () => {
    expect(
      readGiftPaymentConfig(
        {
          ...configured,
          ASAAS_MODE: "live",
          ASAAS_WITHDRAWAL_AUTHORIZATION_TOKEN:
            "fixture-withdrawal-authorization-secret",
        },
        "production",
      ),
    ).toMatchObject({
      mode: "live",
      withdrawalAuthorization: {
        token: "fixture-withdrawal-authorization-secret",
        url: "https://webhook.example.test/v1/webhooks/asaas/withdrawal-authorization",
      },
    });
  });

  it("loads an exact production live showcase opt-in without changing default config shape", () => {
    const config = readGiftPaymentConfig(
      {
        ...configured,
        ASAAS_MODE: "live",
        ASAAS_LIVE_DEMO_SITE_ID: "demo-wedding",
      },
      "production",
    );
    expect(config).toMatchObject({
      mode: "live",
      applicationEnvironment: "production",
      liveDemoSiteId: "demo-wedding",
    });
    expect(
      readGiftPaymentConfig(
        { ...configured, ASAAS_MODE: "live" },
        "production",
      ),
    ).not.toHaveProperty("liveDemoSiteId");
  });
  it.each(["", " demo-wedding", "demo-wedding/other", "demo-wedding,other"])(
    "rejects invalid showcase IDs (%#)",
    (ASAAS_LIVE_DEMO_SITE_ID) => {
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, ASAAS_MODE: "live", ASAAS_LIVE_DEMO_SITE_ID },
          "production",
        ),
      ).toThrow("Gift payment configuration is invalid");
    },
  );
  it.each(["development", "test"] as const)(
    "rejects showcase opt-in outside live production (%s)",
    (target) => {
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, ASAAS_LIVE_DEMO_SITE_ID: "demo-wedding" },
          target,
        ),
      ).toThrow();
      expect(() =>
        readGiftPaymentConfig(
          { ASAAS_MODE: "disabled", ASAAS_LIVE_DEMO_SITE_ID: "demo-wedding" },
          target,
        ),
      ).toThrow();
    },
  );
  it("defaults to disabled without reading unused secrets", () => {
    const env: Record<string, string | undefined> = {};
    for (const key of Object.keys(configured).filter(
      (key) => key !== "ASAAS_MODE",
    )) {
      Object.defineProperty(env, key, {
        get: () => {
          throw new Error("Unused secret was read");
        },
      });
    }
    expect(readGiftPaymentConfig(env, "development")).toEqual({
      mode: "disabled",
    });
    expect(
      readGiftPaymentConfig(
        { ...configured, ASAAS_MODE: "disabled" },
        "production",
      ),
    ).toEqual({ mode: "disabled" });
  });

  it.each(["development", "test"] as const)(
    "loads sandbox settings in %s with a separate public webhook origin",
    (target) => {
      const result = readGiftPaymentConfig(
        {
          ...configured,
          BETTER_AUTH_URL: "http://localhost:8080",
          SITE_ORIGIN: "http://localhost:4321",
          ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test/",
        },
        target,
      );
      expect(result).toEqual({
        mode: "sandbox",
        applicationEnvironment: target,
        platformApiKey: configured.ASAAS_API_KEY,
        platformAccountId: "platform-account",
        platformWalletId: "platform-wallet",
        credentialKeyId: "sandbox-v1",
        credentialKeyring: new Map([["sandbox-v1", Buffer.alloc(32, 19)]]),
        webhookPublicOrigin: "https://webhook.example.test",
        webhookUrl: "https://webhook.example.test/v1/webhooks/asaas",
      });
    },
  );

  it("allows live only in production and sandbox only outside production", () => {
    expect(
      readGiftPaymentConfig(
        { ...configured, ASAAS_MODE: "live" },
        "production",
      ),
    ).toMatchObject({ mode: "live", applicationEnvironment: "production" });
    expect(() => readGiftPaymentConfig(configured, "production")).toThrow(
      "Gift payment configuration is invalid",
    );
    for (const target of ["development", "test"] as const) {
      expect(() =>
        readGiftPaymentConfig({ ...configured, ASAAS_MODE: "live" }, target),
      ).toThrow("Gift payment configuration is invalid");
    }
    expect(() =>
      readGiftPaymentConfig(configured, "unknown" as "test"),
    ).toThrow("Gift payment configuration is invalid");
  });

  it.each(Object.keys(configured).filter((key) => key !== "ASAAS_MODE"))(
    "requires %s when enabled without revealing private values",
    (key) => {
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, [key]: undefined },
          "development",
        ),
      ).toThrow("Gift payment configuration is invalid");
    },
  );

  it.each([
    { ASAAS_MODE: "fake" },
    { ASAAS_MODE: " sandbox" },
    { ASAAS_API_KEY: " key" },
    { ASAAS_API_KEY: "key\nheader" },
    { ASAAS_API_KEY: "secret\u007f" },
    { ASAAS_API_KEY: "a".repeat(8193) },
    { ASAAS_PLATFORM_ACCOUNT_ID: "account/other" },
    { ASAAS_PLATFORM_WALLET_ID: "wallet.with:punctuation" },
    { ASAAS_CREDENTIAL_KEY_ID: " key" },
    { ASAAS_CREDENTIAL_KEY: Buffer.alloc(31).toString("base64") },
    { ASAAS_CREDENTIAL_KEY: Buffer.alloc(33).toString("base64") },
    { ASAAS_CREDENTIAL_KEY: "!".repeat(44) },
    { ASAAS_CREDENTIAL_KEY: `${configured.ASAAS_CREDENTIAL_KEY}\n` },
    { ASAAS_CREDENTIAL_KEY: configured.ASAAS_CREDENTIAL_KEY.replace(/=$/, "") },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "http://webhook.example.test" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://localhost" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://localhost.localdomain" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://127.0.0.1" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://[::1]" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://10.0.0.1" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://172.16.0.1" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://192.168.1.1" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test/path" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test?key=private" },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test#hash" },
    {
      ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://user:private@webhook.example.test",
    },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: "https://webhook.example.test." },
    { ASAAS_WEBHOOK_PUBLIC_ORIGIN: " https://webhook.example.test" },
  ])("rejects invalid settings with a sanitized error (%#)", (override) => {
    try {
      readGiftPaymentConfig({ ...configured, ...override }, "development");
      expect.fail("Invalid settings were accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Gift payment configuration is invalid",
      );
    }
  });
});

describe("Sandbox buyer homologation configuration", () => {
  it("selects exactly one site only in development Sandbox", () => {
    expect(
      readGiftPaymentConfig(
        {
          ...configured,
          ASAAS_SANDBOX_BUYER_GROSS_UP_SITE_ID: "site-one",
        },
        "development",
      ),
    ).toMatchObject({ sandboxBuyerGrossUpSiteId: "site-one" });
  });
  it.each([
    ["production", "live", "site-one"],
    ["test", "sandbox", "site-one"],
    ["development", "sandbox", ""],
    ["development", "sandbox", "site-one,site-two"],
  ] as const)("rejects out-of-scope opt-in %s/%s/%s", (target, mode, site) => {
    expect(() =>
      readGiftPaymentConfig(
        {
          ...configured,
          ASAAS_MODE: mode,
          ASAAS_SANDBOX_BUYER_GROSS_UP_SITE_ID: site,
        },
        target,
      ),
    ).toThrow("Gift payment configuration is invalid");
  });
});
