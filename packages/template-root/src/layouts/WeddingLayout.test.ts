import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "WeddingLayout.astro"),
  "utf8",
);

describe("WeddingLayout landmarks", () => {
  it("keeps host content extension slots inside the main landmark", () => {
    const mainStart = source.indexOf('<main class="template-main">');
    const mainEnd = source.indexOf("</main>");
    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(mainEnd).toBeGreaterThan(mainStart);
    const mainSource = source.slice(mainStart, mainEnd);
    expect(mainSource).toContain('<slot name="before-main" />');
    expect(mainSource).toContain('<slot name="after-main" />');
    expect(mainSource).not.toContain('<slot name="admin-access" />');
    const headerStart = source.indexOf("<header");
    const headerEnd = source.indexOf("</header>");
    expect(headerEnd).toBeGreaterThan(headerStart);
    expect(source.slice(headerStart, headerEnd)).toContain(
      '<slot name="admin-access" />',
    );
  });

  it("keeps navigation labels host-owned and metadata complete", () => {
    expect(source).toContain("data-navigation-state");
    expect(source).toContain('class="template-navigation-mobile"');
    expect(source).toContain("data-template-navigation-mobile");
    expect(source).toContain("navigation.menuLabel");
    expect(source).toContain('property="og:image:alt"');
    expect(source).toContain('name="twitter:image:alt"');
  });

  it("boots shared motion, scrolling, and menu behavior from the public layout", () => {
    expect(source).toContain("setupTemplateInteractions,");
    expect(source).toContain("setupTemplateInteractions();");
    expect(source).toContain("navigationStateForHero");
  });
});
