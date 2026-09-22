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
