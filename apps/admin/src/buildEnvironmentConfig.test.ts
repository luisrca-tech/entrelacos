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
vi.mock("@cloudflare/vite-plugin", () => ({
  cloudflare: () => ({ name: "cloudflare" }),
}));
vi.mock("@tailwindcss/vite", () => ({ default: () => ({ name: "tailwind" }) }));
vi.mock("@tanstack/react-start/plugin/vite", () => ({
  tanstackStart: () => ({ name: "start" }),
}));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "react" }) }));
fixture.directory = mkdtempSync(join(tmpdir(), "entrelacos-admin-env-"));
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe("panel build application environment", () => {
  it.each([
    "development",
    "test",
    "production",
    undefined,
    "",
    "unknown",
    " production ",
  ])(
    "preserves explicit APP_ENV=%s without inferring production from the Vite mode",
    async (environment) => {
      vi.stubEnv("APP_ENV", environment);
      vi.resetModules();
      const { default: factory } = await import("../vite.config");
      if (typeof factory !== "function")
        throw new Error("Expected the real config factory");
      const config = await factory({ command: "build", mode: "production" });
      expect(config.define?.__APP_ENV__).toBe(
        JSON.stringify(environment ?? ""),
      );
    },
  );
});
