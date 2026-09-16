import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sectionSource = readFileSync(
  resolve(import.meta.dirname, "TemplateSection.astro"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
);

describe("TemplateSection heading levels", () => {
  it("styles both supported semantic heading levels", () => {
    expect(sectionSource).toContain("headingLevel?: 1 | 2");
    expect(stylesSource).toMatch(
      /\.template-section__header h1,\s*\.template-section__header h2/,
    );
  });
});
