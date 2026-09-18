import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(import.meta.dirname, "styles.css"),
  "utf8",
);

describe("UI stylesheet policy", () => {
  it("keeps the package stylesheet Tailwind-only", () => {
    expect(stylesheet.trim()).toMatch(/^@theme inline\s*\{[\s\S]*\}\s*$/);
    expect(stylesheet).not.toMatch(/:root\s*\{/);
    expect(stylesheet).not.toMatch(/@media\b/);
    expect(stylesheet).not.toMatch(/@apply\b/);
    expect(stylesheet).not.toMatch(/(^|\n)\s*\*\s*\{/);
    expect(stylesheet).not.toMatch(/(^|\n)\s*body\s*\{/);
    expect(stylesheet).not.toMatch(/(^|\n)\s*:focus-visible\s*\{/);
  });
});
