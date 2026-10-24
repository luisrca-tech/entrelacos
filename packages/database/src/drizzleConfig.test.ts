import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("DATABASE_DIRECT_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Drizzle Kit configuration", () => {
  it("generates migrations without database credentials", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { default: config } = await import("../drizzle.config");

    expect(config).not.toHaveProperty("dbCredentials");
    expect(config.schema).toBe("./src/schema.ts");
    expect(config.out).toBe("./migrations");
  });

  it("uses the normalized migration URL when credentials are available", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:secret@ep-development-pooler.example.neon.tech/neondb?sslmode=require",
    );
    vi.stubEnv(
      "DATABASE_DIRECT_URL",
      "postgresql://migration-role:secret@ep-development.example.neon.tech/neondb?sslmode=require",
    );
    const { default: config } = await import("../drizzle.config");

    expect(config).toHaveProperty(
      "dbCredentials.url",
      "postgresql://migration-role:secret@ep-development.example.neon.tech/neondb?sslmode=verify-full",
    );
  });

  it("supports DIRECT-only credentials", async () => {
    vi.stubEnv(
      "DATABASE_DIRECT_URL",
      "postgresql://migration-role:secret@ep-development.example.neon.tech/neondb",
    );
    const { default: config } = await import("../drizzle.config");
    expect(config).toHaveProperty(
      "dbCredentials.url",
      "postgresql://migration-role:secret@ep-development.example.neon.tech/neondb?sslmode=verify-full",
    );
  });

  it("rejects runtime-only migration credentials without exposing them", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:private-runtime-password@ep-development-pooler.example.neon.tech/neondb",
    );
    await expect(import("../drizzle.config")).rejects.toThrow(
      "Missing required database environment variable: DATABASE_DIRECT_URL",
    );
  });

  it.each([
    ["ep-development-pooler", "direct Neon endpoint"],
    ["ep-other", "match the development endpoint"],
  ])("rejects unsafe DIRECT endpoints (%s)", async (endpoint, message) => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:runtime-secret@ep-development-pooler.example.neon.tech/neondb",
    );
    vi.stubEnv(
      "DATABASE_DIRECT_URL",
      `postgresql://migration-role:direct-secret@${endpoint}.example.neon.tech/neondb`,
    );
    await expect(import("../drizzle.config")).rejects.toThrow(message);
  });
});
