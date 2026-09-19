import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(import.meta.dirname, "styles.css"),
  "utf8",
);

const transitionSources = [
  "components/alert-dialog.tsx",
  "components/badge.tsx",
  "components/button.tsx",
  "components/checkbox.tsx",
  "components/dialog.tsx",
  "components/dropdown-menu.tsx",
  "components/input.tsx",
  "components/popover.tsx",
  "components/select.tsx",
  "components/table.tsx",
  "components/textarea.tsx",
].map((relativePath) => ({
  path: relativePath,
  source: readFileSync(resolve(import.meta.dirname, relativePath), "utf8"),
}));
const tableSource = readFileSync(
  resolve(import.meta.dirname, "components/table.tsx"),
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

  it("keeps reduced-motion coverage on every transitioning primitive", () => {
    for (const { path, source } of transitionSources) {
      expect(source, path).toMatch(/\btransition(?:-[^\s"`]+)?/);
      expect(source, path).toContain("motion-reduce:transition-none");
    }
  });

  it("keeps the shared border token on table separators", () => {
    expect(tableSource).toContain("[&_tr]:border-border");
    expect(tableSource).toContain("border-b border-border");
    expect(tableSource).toContain("border-t border-border");
  });
});
