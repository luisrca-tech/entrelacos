import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "GiftSection.astro"),
  "utf8",
);
describe("gift presentation seam", () => {
  it("keeps runtime eligibility in the consumer with a hidden initial surface", () => {
    expect(source).toContain("data-gift-section");
    expect(source).toContain("hidden");
    expect(source).toContain("[data-gift-section][hidden] { display: none; }");
    expect(source).toContain("<slot />");
    expect(source).not.toMatch(
      /fetch\(|wallet|readiness|DATABASE|Asaas|R2_ACCESS/i,
    );
  });
  it("uses host content validation and existing section tokens", () => {
    expect(source).toContain("validateSectionContent(content)");
    expect(source).toContain("content.title");
    expect(source).toContain("font-template-serif");
    expect(source).toContain("var(--template-page-inset)");
  });
});
