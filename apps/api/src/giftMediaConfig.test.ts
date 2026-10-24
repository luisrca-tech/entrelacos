import { describe, expect, it } from "vitest";
import { readGiftMediaConfig } from "./giftMediaConfig";

const configured = {
  GIFT_MEDIA_MODE: "r2",
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_ACCESS_KEY_ID: "private-access-key",
  R2_SECRET_ACCESS_KEY: "private-secret-key",
  R2_BUCKET_NAME: "fixture-existing-bucket",
  R2_PUBLIC_ORIGIN: "https://images.example.test",
};

describe("gift media runtime configuration", () => {
  it("defaults to disabled and excludes unused credentials", () => {
    expect(readGiftMediaConfig({})).toEqual({ mode: "disabled" });
    expect(
      readGiftMediaConfig({ ...configured, GIFT_MEDIA_MODE: "disabled" }),
    ).toEqual({ mode: "disabled" });
  });

  it("maps explicitly enabled one-bucket derivative settings", () => {
    expect(readGiftMediaConfig(configured)).toEqual({
      mode: "r2",
      accountId: configured.R2_ACCOUNT_ID,
      accessKeyId: configured.R2_ACCESS_KEY_ID,
      secretAccessKey: configured.R2_SECRET_ACCESS_KEY,
      bucketName: configured.R2_BUCKET_NAME,
      publicOrigin: "https://images.example.test",
    });
  });

  it("does not read unused settings while media is disabled", () => {
    for (const mode of [undefined, "disabled"]) {
      const env: Record<string, string | undefined> = { GIFT_MEDIA_MODE: mode };
      for (const key of Object.keys(configured).filter(
        (key) => key !== "GIFT_MEDIA_MODE",
      )) {
        Object.defineProperty(env, key, {
          get: () => {
            throw new Error("Unused private setting read");
          },
        });
      }
      expect(readGiftMediaConfig(env)).toEqual({ mode: "disabled" });
    }
  });

  it.each([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_ORIGIN",
  ])("requires useful setting %s when explicitly enabled", (key) => {
    expect(() =>
      readGiftMediaConfig({ ...configured, [key]: undefined }),
    ).toThrow("Gift media configuration is invalid");
  });

  it("never substitutes obsolete bucket aliases or reads them with useful settings", () => {
    expect(() =>
      readGiftMediaConfig({
        ...configured,
        R2_BUCKET_NAME: undefined,
        R2_PUBLIC_ORIGIN: undefined,
        R2_GIFT_STAGING_BUCKET: "legacy-stage",
        R2_GIFT_PUBLIC_BUCKET: "legacy-public",
        R2_GIFT_PUBLIC_ORIGIN: "https://legacy-images.example.test",
      }),
    ).toThrow("Gift media configuration is invalid");
    const env: Record<string, string | undefined> = { ...configured };
    for (const key of [
      "R2_GIFT_STAGING_BUCKET",
      "R2_GIFT_PUBLIC_BUCKET",
      "R2_GIFT_PUBLIC_ORIGIN",
    ]) {
      Object.defineProperty(env, key, {
        get: () => {
          throw new Error("Obsolete setting read");
        },
      });
    }
    expect(readGiftMediaConfig(env)).toMatchObject({
      bucketName: configured.R2_BUCKET_NAME,
      publicOrigin: configured.R2_PUBLIC_ORIGIN,
    });
  });

  it("canonicalizes the configured image origin without deriving resource names", () => {
    expect(
      readGiftMediaConfig({
        ...configured,
        R2_PUBLIC_ORIGIN: "https://images.example.test/",
        APP_ENV: "production",
      }),
    ).toMatchObject({
      bucketName: configured.R2_BUCKET_NAME,
      publicOrigin: configured.R2_PUBLIC_ORIGIN,
    });
  });

  it.each(["development", "test"] as const)(
    "allows the development R2 public endpoint only with explicit %s application scope",
    (target) => {
      expect(
        readGiftMediaConfig(
          {
            ...configured,
            R2_PUBLIC_ORIGIN: "https://pub-development.r2.dev/",
          },
          target,
        ),
      ).toMatchObject({ publicOrigin: "https://pub-development.r2.dev" });
    },
  );

  it.each([undefined, "production"] as const)(
    "retains the production R2 endpoint policy for %s application scope",
    (target) => {
      expect(() =>
        readGiftMediaConfig(
          {
            ...configured,
            APP_ENV: "development",
            R2_PUBLIC_ORIGIN: "https://pub-development.r2.dev",
          },
          target,
        ),
      ).toThrow("Gift media configuration is invalid");
    },
  );

  it.each([
    "https://r2.dev",
    "https://pub-development.r2.dev.",
    "http://pub-development.r2.dev",
    "https://pub-development.r2.dev/path",
    "https://pub-development.r2.cloudflarestorage.com",
  ])(
    "keeps rejecting unsafe R2 delivery settings in development (%s)",
    (publicOrigin) => {
      expect(() =>
        readGiftMediaConfig(
          {
            ...configured,
            R2_PUBLIC_ORIGIN: publicOrigin,
          },
          "development",
        ),
      ).toThrow("Gift media configuration is invalid");
    },
  );

  it.each([
    { GIFT_MEDIA_MODE: "fake" },
    { R2_ACCOUNT_ID: "account/other" },
    { R2_ACCOUNT_ID: `${"a".repeat(32)}\n` },
    { R2_ACCESS_KEY_ID: "" },
    { R2_SECRET_ACCESS_KEY: "" },
    { R2_SECRET_ACCESS_KEY: "secret\nheader" },
    { R2_ACCESS_KEY_ID: " key" },
    { R2_SECRET_ACCESS_KEY: "secret\0" },
    { R2_BUCKET_NAME: "ab" },
    { R2_BUCKET_NAME: "Gift-Public" },
    { R2_BUCKET_NAME: "bucket.name" },
    { R2_BUCKET_NAME: "a".repeat(64) },
    { R2_PUBLIC_ORIGIN: "http://images.example.test" },
    { R2_PUBLIC_ORIGIN: "https://user:password@images.example.test" },
    { R2_PUBLIC_ORIGIN: "https://images.example.test/path" },
    { R2_PUBLIC_ORIGIN: "https://images.example.test?private=token" },
    { R2_PUBLIC_ORIGIN: "https://images.example.test#fragment" },
    { R2_PUBLIC_ORIGIN: "https://test.r2.dev" },
    { R2_PUBLIC_ORIGIN: "https://test.r2.dev." },
    { R2_PUBLIC_ORIGIN: "https://test.r2.cloudflarestorage.com" },
    { R2_PUBLIC_ORIGIN: "https://test.r2.cloudflarestorage.com." },
  ])(
    "rejects invalid configuration without echoing private settings %j",
    (override) => {
      let error: unknown;
      try {
        readGiftMediaConfig({ ...configured, ...override });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Gift media configuration is invalid",
      );
      expect((error as Error).message).not.toContain(
        configured.R2_SECRET_ACCESS_KEY,
      );
    },
  );
});
