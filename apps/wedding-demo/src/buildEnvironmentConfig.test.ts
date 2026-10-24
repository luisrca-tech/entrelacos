import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("vite", async (original) => {
  const actual = await original<typeof import("vite")>();
  return {
    ...actual,
    loadEnv: (mode: string, _directory: string, prefix: string) =>
      actual.loadEnv(mode, fixture.directory, prefix),
  };
});
vi.mock("@astrojs/react", () => ({ default: () => ({ name: "react" }) }));
vi.mock("@tailwindcss/vite", () => ({ default: () => ({ name: "tailwind" }) }));
vi.mock("astro/config", () => ({ defineConfig: (config: unknown) => config }));
fixture.directory = mkdtempSync(join(tmpdir(), "entrelacos-astro-env-"));
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe("public build application environment", () => {
  it.each([
    "development",
    "test",
    "production",
    undefined,
    "",
    "unknown",
    " production ",
  ])(
    "preserves explicit APP_ENV=%s without inferring production from the build command",
    async (environment) => {
      vi.stubEnv("APP_ENV", environment);
      vi.resetModules();
      const { default: config } = await import("../astro.config.mjs");
      expect(config.vite?.define?.__APP_ENV__).toBe(
        JSON.stringify(environment ?? ""),
      );
    },
  );
});
