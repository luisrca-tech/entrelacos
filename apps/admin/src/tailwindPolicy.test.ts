import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootSource = readFileSync(
  resolve(import.meta.dirname, "routes/__root.tsx"),
  "utf8",
);
const tailwindSource = readFileSync(
  resolve(import.meta.dirname, "tailwind.css"),
  "utf8",
);

describe("admin Tailwind policy", () => {
  it("uses the Tailwind entrypoint without a legacy stylesheet", () => {
    expect(rootSource).toContain('import "../tailwind.css";');
    expect(rootSource).not.toContain('import "../styles.css";');
    expect(() =>
      readFileSync(resolve(import.meta.dirname, "styles.css")),
    ).toThrow();
  });

  it("keeps the admin stylesheet limited to Tailwind directives", () => {
    expect(tailwindSource).not.toMatch(
      /(^|\n)\s*(?!@(?:import|source|theme|keyframes)\b)[.#[a-zA-Z][^\n]*\{/,
    );
    expect(tailwindSource).not.toContain("@apply");
  });
});
