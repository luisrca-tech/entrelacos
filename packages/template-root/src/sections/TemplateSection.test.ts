import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sectionSource = readFileSync(
  resolve(import.meta.dirname, "TemplateSection.astro"),
  "utf8",
);

describe("TemplateSection heading levels", () => {
  it("styles both supported semantic heading levels", () => {
    expect(sectionSource).toContain("headingLevel?: 1 | 2");
    expect(sectionSource).toContain("font-template-serif");
    expect(sectionSource).toContain("headingLevel?: 1 | 2");
  });
});
