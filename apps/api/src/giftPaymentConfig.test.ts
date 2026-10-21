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

  it("does not enable the Sandbox withdrawal callback in live mode", () => {
    expect(() =>
      readGiftPaymentConfig(
        {
          ...configured,
          ASAAS_MODE: "live",
          ASAAS_WITHDRAWAL_AUTHORIZATION_TOKEN:
            "fixture-withdrawal-authorization-secret",
        },
        "production",
      ),
    ).toThrow("Gift payment configuration is invalid");
  });

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
