import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname);

describe("template-root Tailwind policy", () => {
  it("publishes only the theme stylesheet and removes the legacy stylesheet", () => {
    expect(existsSync(resolve(packageRoot, "src/styles.css"))).toBe(false);
    expect(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ).toContain('"./theme.css": "./src/theme.css"');
  });

  it("keeps package CSS limited to theme tokens and keyframes", () => {
    const theme = readFileSync(resolve(packageRoot, "src/theme.css"), "utf8");
    expect(theme).toContain("@theme");
    expect(theme).toMatch(/@keyframes\s+template-/);
    expect(theme).not.toMatch(/@apply|<style|(^|\n)\s*(?:[.#]|\[)[^{}]*\{/m);
  });
});
