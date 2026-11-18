import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readGiftPaymentConfig } from "./giftPaymentConfig";

const configured = {
  PAGARME_MODE: "test",
  PAGARME_SECRET_KEY: "sk_test_fixture0123456789abcdef",
  PAGARME_PLATFORM_RECIPIENT_ID: "rp_fixturePlatform01",
  PAGARME_WEBHOOK_BASIC_USER: "entrelacos-webhook",
  PAGARME_WEBHOOK_BASIC_PASSWORD: "fixture-webhook-password-0123456789abcdef",
};
const liveKey = "sk_fixtureLive0123456789abcdef";
const webhookCredentialsHash = createHash("sha256")
  .update(
    `${configured.PAGARME_WEBHOOK_BASIC_USER}:${configured.PAGARME_WEBHOOK_BASIC_PASSWORD}`,
  )
  .digest("hex");

describe("Pagar.me gift payment configuration", () => {
  it.each(["development", "test"] as const)(
    "loads test mode in %s as the sandbox environment",
    (target) => {
      expect(readGiftPaymentConfig(configured, target)).toEqual({
        mode: "sandbox",
        providerMode: "test",
        applicationEnvironment: target,
        secretKey: configured.PAGARME_SECRET_KEY,
        platformRecipientId: "rp_fixturePlatform01",
        webhookBasicUser: "entrelacos-webhook",
        webhookCredentialsHash,
      });
    },
  );

  it("keeps only a hash of the webhook credentials, never the raw password", () => {
    const result = readGiftPaymentConfig(configured, "development");
    expect(JSON.stringify(result)).not.toContain(
      configured.PAGARME_WEBHOOK_BASIC_PASSWORD,
    );
  });

  it("loads live mode only in production with a live key", () => {
    expect(
      readGiftPaymentConfig(
        {
          ...configured,
          PAGARME_MODE: "live",
          PAGARME_SECRET_KEY: liveKey,
          PAGARME_LIVE_DEMO_SITE_ID: "demo-wedding, demo-wedding-cartas",
          PAGARME_BACKGROUND_PROCESSING: "true",
        },
        "production",
      ),
    ).toMatchObject({
      mode: "live",
      providerMode: "live",
      applicationEnvironment: "production",
      secretKey: liveKey,
      backgroundProcessing: true,
      liveDemoSiteIds: ["demo-wedding", "demo-wedding-cartas"],
    });
    for (const target of ["development", "test"] as const)
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, PAGARME_MODE: "live", PAGARME_SECRET_KEY: liveKey },
          target,
        ),
      ).toThrow("Gift payment configuration is invalid");
    expect(() => readGiftPaymentConfig(configured, "production")).toThrow(
      "Gift payment configuration is invalid",
    );
    expect(() =>
      readGiftPaymentConfig(configured, "unknown" as "test"),
    ).toThrow("Gift payment configuration is invalid");
  });

  it("rejects a secret key whose prefix does not match the mode", () => {
    expect(() =>
      readGiftPaymentConfig(
        { ...configured, PAGARME_SECRET_KEY: liveKey },
        "development",
      ),
    ).toThrow("Gift payment configuration is invalid");
    expect(() =>
      readGiftPaymentConfig(
        {
          ...configured,
          PAGARME_MODE: "live",
          PAGARME_SECRET_KEY: configured.PAGARME_SECRET_KEY,
        },
        "production",
      ),
    ).toThrow("Gift payment configuration is invalid");
    for (const key of ["pk_test_public0123", "ak_test_x", "sk_test_"])
      expect(() =>
        readGiftPaymentConfig(
          { ...configured, PAGARME_SECRET_KEY: key },
          "development",
        ),
      ).toThrow("Gift payment configuration is invalid");
  });

  it("never echoes the secret key in configuration errors", () => {
    const secret = "sk_privateLiveValue0123456789";
    try {
      readGiftPaymentConfig(
        { ...configured, PAGARME_SECRET_KEY: secret },
        "development",
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("defaults to disabled without reading unused secrets", () => {
    const env: Record<string, string | undefined> = {};
    for (const key of [
      ...Object.keys(configured).filter((key) => key !== "PAGARME_MODE"),
      "PAGARME_BACKGROUND_PROCESSING",
    ])
      Object.defineProperty(env, key, {
        get: () => {
          throw new Error("Unused secret was read");
        },
      });
    expect(readGiftPaymentConfig(env, "development")).toEqual({
      mode: "disabled",
    });
    expect(
      readGiftPaymentConfig(
        { ...configured, PAGARME_MODE: "disabled" },
        "production",
      ),
    ).toEqual({ mode: "disabled" });
  });

  it("reads only PAGARME_* settings", () => {
    const read = new Set<string>();
    const env = new Proxy(
      { ...configured },
      {
        get(target, key) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key);
        },
      },
    );
    expect(readGiftPaymentConfig(env, "development")).toMatchObject({
      mode: "sandbox",
    });
    expect([...read].every((key) => key.startsWith("PAGARME_"))).toBe(true);
    expect(
      readGiftPaymentConfig(
        { LEGACY_PROVIDER_MODE: "sandbox", LEGACY_PROVIDER_API_KEY: "x" },
        "development",
      ),
    ).toEqual({ mode: "disabled" });
  });

  it.each(Object.keys(configured).filter((key) => key !== "PAGARME_MODE"))(
    "requires %s when enabled",
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
    { PAGARME_MODE: "sandbox" },
    { PAGARME_MODE: " test" },
    { PAGARME_MODE: "TEST" },
    { PAGARME_SECRET_KEY: " sk_test_fixture" },
    { PAGARME_SECRET_KEY: "sk_test_fixture\nheader" },
    { PAGARME_SECRET_KEY: `sk_test_${"a".repeat(8192)}` },
    { PAGARME_PLATFORM_RECIPIENT_ID: "re_fixture" },
    { PAGARME_PLATFORM_RECIPIENT_ID: "rp_fixture/other" },
    { PAGARME_WEBHOOK_BASIC_USER: "user:with-colon" },
    { PAGARME_WEBHOOK_BASIC_USER: "user name" },
    { PAGARME_WEBHOOK_BASIC_PASSWORD: "short" },
    { PAGARME_WEBHOOK_BASIC_PASSWORD: "x".repeat(256) },
    { PAGARME_WEBHOOK_BASIC_PASSWORD: `${"x".repeat(32)} y` },
    { PAGARME_BACKGROUND_PROCESSING: "typo" },
    { PAGARME_LIVE_DEMO_SITE_ID: "demo-wedding" },
  ])("rejects invalid setting %j", (override) => {
    expect(() =>
      readGiftPaymentConfig({ ...configured, ...override }, "development"),
    ).toThrow("Gift payment configuration is invalid");
  });

  it("accepts explicit background processing flags", () => {
    expect(
      readGiftPaymentConfig(
        { ...configured, PAGARME_BACKGROUND_PROCESSING: "true" },
        "development",
      ),
    ).toMatchObject({ backgroundProcessing: true });
    expect(
      readGiftPaymentConfig(
        { ...configured, PAGARME_BACKGROUND_PROCESSING: "false" },
        "development",
      ),
    ).not.toHaveProperty("backgroundProcessing");
  });

  it.each(["demo-wedding,demo-wedding", "demo-wedding,", "Invalid Site"])(
    "rejects invalid showcase IDs %j",
    (PAGARME_LIVE_DEMO_SITE_ID) => {
      expect(() =>
        readGiftPaymentConfig(
          {
            ...configured,
            PAGARME_MODE: "live",
            PAGARME_SECRET_KEY: liveKey,
            PAGARME_LIVE_DEMO_SITE_ID,
          },
          "production",
        ),
      ).toThrow("Gift payment configuration is invalid");
    },
  );

  it("rejects showcase IDs while disabled", () => {
    expect(() =>
      readGiftPaymentConfig(
        { PAGARME_MODE: "disabled", PAGARME_LIVE_DEMO_SITE_ID: "demo-wedding" },
        "production",
      ),
    ).toThrow("Gift payment configuration is invalid");
  });
});
