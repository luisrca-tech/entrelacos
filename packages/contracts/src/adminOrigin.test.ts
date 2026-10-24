import { describe, expect, it } from "vitest";
import {
  allowsDevelopmentLocalhost,
  isTrustedAdminOrigin,
} from "./adminOrigin";

describe("administrative origin policy", () => {
  it.each([
    [{ APP_ENV: "development", NODE_ENV: "development" }, true],
    [{ APP_ENV: "development" }, true],
    [{ APP_ENV: "development", NODE_ENV: "production" }, false],
    [{ APP_ENV: "production", NODE_ENV: "development" }, false],
    [{ APP_ENV: "test", NODE_ENV: "development" }, false],
    [{ NODE_ENV: "development" }, false],
    [{}, false],
  ])(
    "requires explicit development without a production runtime: %j",
    (environment, expected) => {
      expect(allowsDevelopmentLocalhost(environment)).toBe(expected);
    },
  );

  it.each([
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:65535",
    "https://localhost:4242",
    "http://localhost",
    "https://localhost",
  ])("admits canonical localhost origin %s only in development", (origin) => {
    expect(
      isTrustedAdminOrigin(origin, "https://admin.example.test", true),
    ).toBe(true);
    expect(
      isTrustedAdminOrigin(origin, "https://admin.example.test", false),
    ).toBe(false);
  });

  it.each([
    "http://localhost.evil:3000",
    "http://localhostevil:3000",
    "http://evil.localhost:3000",
    "http://user@localhost:3000",
    "http://localhost:3000/",
    "http://localhost:3000/path",
    "http://localhost:3000?query=1",
    "http://localhost:3000#fragment",
    "http://localhost:03000",
    "http://localhost:65536",
    "http://localhost:80",
    "https://localhost:443",
    "http://localhost.",
    "http://LOCALHOST:3000",
    "http://local%68ost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "ftp://localhost:3000",
    "null",
    "invalid",
    "",
    null,
    undefined,
  ])("rejects noncanonical or foreign candidate %s", (origin) => {
    expect(
      isTrustedAdminOrigin(origin, "https://admin.example.test", true),
    ).toBe(false);
  });

  it.each([true, false])(
    "keeps exact configured authority with localhost allowance %s",
    (allowLocalhost) => {
      expect(
        isTrustedAdminOrigin(
          "https://admin.example.test",
          "https://admin.example.test",
          allowLocalhost,
        ),
      ).toBe(true);
      expect(
        isTrustedAdminOrigin(
          "https://admin.example.test/",
          "https://admin.example.test",
          allowLocalhost,
        ),
      ).toBe(false);
    },
  );
});
