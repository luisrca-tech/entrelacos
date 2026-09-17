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
      smsMode: "manual",
      exposeSimulationCode: false,
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
  it("requires explicit opt-in before trusting proxy IP headers or exposing mock codes", () => {
    expect(
      readRuntimeConfig({
        ...settings,
        TRUST_PROXY_HEADERS: "true",
        EXPOSE_SIMULATION_CODE: "true",
      }),
    ).toMatchObject({ trustProxyHeaders: true, exposeSimulationCode: true });
    expect(() =>
      readRuntimeConfig({ ...settings, SMS_MODE: "unknown" }),
    ).toThrow();
    expect(
      readRuntimeConfig({ ...settings, SMS_MODE: "simulated" }),
    ).toMatchObject({
      smsMode: "simulated",
      twilio: undefined,
    });
  });
  it("fails closed until every real Twilio safeguard is configured", () => {
    const real = {
      ...settings,
      SMS_MODE: "real",
      SMS_REAL_AUTHORIZED: "true",
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "b".repeat(32),
      TWILIO_VERIFY_SERVICE_SID: `VA${"c".repeat(32)}`,
      TWILIO_TEST_PHONE_ALLOWLIST: "+5521999999999",
      TWILIO_BRAZIL_CONFIRMED: "true",
      TWILIO_TRIAL_USAGE_CONFIRMED: "true",
    };
    expect(readRuntimeConfig(real).twilio).toMatchObject({
      verifyServiceSid: real.TWILIO_VERIFY_SERVICE_SID,
      phoneAllowlist: [real.TWILIO_TEST_PHONE_ALLOWLIST],
    });
    for (const key of [
      "SMS_REAL_AUTHORIZED",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_VERIFY_SERVICE_SID",
      "TWILIO_TEST_PHONE_ALLOWLIST",
      "TWILIO_BRAZIL_CONFIRMED",
      "TWILIO_TRIAL_USAGE_CONFIRMED",
    ]) {
      expect(() => readRuntimeConfig({ ...real, [key]: undefined })).toThrow();
    }
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
