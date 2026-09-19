import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as {
  exports?: Record<string, unknown>;
  sideEffects?: unknown;
};

describe("Tailwind presentation policy", () => {
  it("does not ship the legacy package stylesheet", () => {
    expect(existsSync(resolve(import.meta.dirname, "styles.css"))).toBe(false);
    expect(packageJson.exports).not.toHaveProperty("./styles.css");
    expect(packageJson.sideEffects ?? []).not.toContain("./src/styles.css");
  });
});
