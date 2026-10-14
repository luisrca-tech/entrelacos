import { describe, expect, it } from "vitest";
import { readRuntimeConfig } from "./runtimeConfig";

const settings = {
  APP_ENV: "development",
  BETTER_AUTH_SECRET: "local-runtime-secret-with-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:8080",
  ADMIN_ORIGIN: "http://localhost:3000",
};

describe("API runtime configuration", () => {
  it("selects only the explicitly named database environment", () => {
    expect(readRuntimeConfig(settings)).toMatchObject({
      target: "development",
      port: 8080,
      trustProxyHeaders: false,
    });
    expect(
      readRuntimeConfig({ ...settings, APP_ENV: "test", PORT: "18080" }),
    ).toMatchObject({ target: "test", port: 18080 });
    expect(() =>
      readRuntimeConfig({ ...settings, APP_ENV: undefined }),
    ).toThrow();
    expect(
      readRuntimeConfig({ ...settings, APP_ENV: "production" }),
    ).toMatchObject({ target: "production" });
  });

  it("derives production defaults from Railway", () => {
    expect(
      readRuntimeConfig({
        ...settings,
        APP_ENV: undefined,
        BETTER_AUTH_URL: undefined,
        RAILWAY_ENVIRONMENT_NAME: "production",
        RAILWAY_PUBLIC_DOMAIN: "entrelacosapi-production.up.railway.app",
      }),
    ).toMatchObject({
      target: "production",
      baseURL: "https://entrelacosapi-production.up.railway.app",
      trustProxyHeaders: true,
    });
  });

  it("derives development defaults from Railway", () => {
    expect(
      readRuntimeConfig({
        ...settings,
        APP_ENV: undefined,
        RAILWAY_ENVIRONMENT_NAME: "development",
      }),
    ).toMatchObject({
      target: "development",
      trustProxyHeaders: true,
    });
  });

  it.each(["", "0", "65536", "abc", "8080.5"])(
    "rejects invalid port %s",
    (PORT) => {
      expect(() => readRuntimeConfig({ ...settings, PORT })).toThrow();
    },
  );

  it("rejects missing or weak server secrets", () => {
    expect(() =>
      readRuntimeConfig({ ...settings, BETTER_AUTH_SECRET: "short" }),
    ).toThrow();
  });

  it("keeps runtime configuration focused on API concerns", () => {
    const config = readRuntimeConfig(settings);

    expect(config).not.toHaveProperty("smsMode");
    expect(config).not.toHaveProperty("twilio");
    expect(config).not.toHaveProperty("demoGrantSecret");
    expect(config).not.toHaveProperty("exposeSimulationCode");
  });

  it("keeps media disabled by default and validates explicit storage configuration", () => {
    expect(readRuntimeConfig(settings)).toHaveProperty("giftMedia", {
      mode: "disabled",
    });
    expect(() =>
      readRuntimeConfig({ ...settings, GIFT_MEDIA_MODE: "r2" }),
    ).toThrow("Gift media configuration is invalid");
  });

  it.each([
    ["development", "fixture-development"],
    ["test", "fixture-development"],
    ["production", "fixture-production"],
  ])("uses only the supplied existing bucket for %s", (APP_ENV, bucketName) => {
    const config = readRuntimeConfig({
      ...settings,
      APP_ENV,
      GIFT_MEDIA_MODE: "r2",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_ACCESS_KEY_ID: "fixture-access-key",
      R2_SECRET_ACCESS_KEY: "fixture-secret-key",
      R2_BUCKET_NAME: bucketName,
      R2_PUBLIC_ORIGIN: "https://images.example.test",
    });
    expect(config.target).toBe(APP_ENV);
    expect(config.giftMedia).toEqual({
      mode: "r2",
      accountId: "a".repeat(32),
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key",
      bucketName,
      publicOrigin: "https://images.example.test",
    });
  });

  it("preserves proxy trust and fingerprint configuration", () => {
    expect(
      readRuntimeConfig({
        ...settings,
        TRUST_PROXY_HEADERS: "true",
        GUEST_FINGERPRINT_SECRET:
          "fingerprint-secret-with-at-least-32-characters",
      }),
    ).toMatchObject({
      trustProxyHeaders: true,
      fingerprintSecret: "fingerprint-secret-with-at-least-32-characters",
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://name:secret@example.test",
    "https://example.test/path",
    "https://example.test?token=private",
  ])("rejects non-origin configuration without echoing it", (ADMIN_ORIGIN) => {
    let error: unknown;
    try {
      readRuntimeConfig({ ...settings, ADMIN_ORIGIN });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(ADMIN_ORIGIN);
  });
});

describe("server-selected purchase history configuration", () => {
  it.each([undefined, "", "   "])(
    "defaults %j to disabled without inferring mode from production",
    (GIFT_PAYMENT_HISTORY_MODE) => {
      expect(
        readRuntimeConfig({
          ...settings,
          APP_ENV: "production",
          GIFT_PAYMENT_HISTORY_MODE,
        }),
      ).toHaveProperty("giftPaymentHistory", {
        mode: "disabled",
        applicationEnvironment: "production",
        policy: "SITE_HISTORY",
      });
    },
  );
  for (const APP_ENV of ["development", "test", "production"])
    it.each(["disabled", "sandbox", "live"])(
      `captures explicit %s independently of ${APP_ENV}`,
      (mode) => {
        const config = readRuntimeConfig({
          ...settings,
          APP_ENV,
          GIFT_PAYMENT_HISTORY_MODE: ` ${mode} `,
        });
        expect(config).toHaveProperty("giftPaymentHistory", {
          mode,
          applicationEnvironment: APP_ENV,
          policy: "SITE_HISTORY",
        });
      },
    );
  it.each([
    "SANDBOX",
    "true",
    "READY",
    "test",
    "sandbox/live",
    "private-invalid-value",
  ])(
    "rejects unsupported selector %s with a fixed error",
    (GIFT_PAYMENT_HISTORY_MODE) => {
      expect(() =>
        readRuntimeConfig({ ...settings, GIFT_PAYMENT_HISTORY_MODE }),
      ).toThrow(/^Gift payment history configuration is invalid$/);
    },
  );
  it("rejects an invalid selector before reading remaining private settings", () => {
    const input = {
      ...settings,
      GIFT_PAYMENT_HISTORY_MODE: "unsupported",
      get BETTER_AUTH_SECRET(): string {
        throw new Error("private setting read");
      },
    };
    expect(() => readRuntimeConfig(input)).toThrow(
      /^Gift payment history configuration is invalid$/,
    );
  });
  it("preserves every pre-existing config value and needs no new provider setting", () => {
    const before = readRuntimeConfig(settings);
    const after = readRuntimeConfig({
      ...settings,
      GIFT_PAYMENT_HISTORY_MODE: "sandbox",
    });
    const { giftPaymentHistory: beforeHistory, ...oldBefore } = before;
    const { giftPaymentHistory: afterHistory, ...oldAfter } = after;
    expect(oldAfter).toEqual(oldBefore);
    expect(beforeHistory).toEqual({
      mode: "disabled",
      applicationEnvironment: "development",
      policy: "SITE_HISTORY",
    });
    expect(afterHistory).toEqual({ ...beforeHistory, mode: "sandbox" });
  });
});
