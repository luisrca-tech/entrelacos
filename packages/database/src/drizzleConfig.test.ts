import { afterEach, describe, expect, it, vi } from "vitest";

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
    const { default: config } = await import("../drizzle.config");

    expect(config).toHaveProperty(
      "dbCredentials.url",
      "postgresql://user:secret@ep-development-pooler.example.neon.tech/neondb?sslmode=verify-full",
    );
  });
});
