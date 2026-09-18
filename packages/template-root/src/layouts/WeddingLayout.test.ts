import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "WeddingLayout.astro"),
  "utf8",
);
const styles = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
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
    const headerSource = source.slice(headerStart, headerEnd);
    expect(headerSource.indexOf('<slot name="admin-access" />')).toBeLessThan(
      headerSource.indexOf('<slot name="header-addon" />'),
    );
  });

  it("uses a compact header bar", () => {
    const headerRule = styles.match(/\.template-header\s*\{[^}]*\}/s)?.[0];

    expect(headerRule).toContain(
      "padding: 0.65rem var(--template-page-inset);",
    );
    expect(headerRule).not.toContain("padding: 1.5rem");
    expect(styles).toContain("--template-header-height: 4.05rem;");
  });

  it("tightens the header further on tablet and mobile", () => {
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-header\s*\{[\s\S]*?padding:\s*0\.4rem var\(--template-page-inset\);/,
    );
  });

  it("paints main with the same ivory as the gallery canvas", () => {
    const mainRule = styles.match(/\.template-main\s*\{[^}]*\}/s)?.[0];
    const galleryIvoryRule = styles.match(
      /\.template-gallery--ivory(?:,[^{]+)*\{[^}]*\}/s,
    )?.[0];

    expect(mainRule).toContain("background: var(--template-ivory);");
    expect(galleryIvoryRule).toContain("background: var(--template-ivory);");
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

  it("renders year and names on a single legal line", () => {
    expect(source).toContain("<span>© {footer.year} {footer.names}</span>");
    expect(source).not.toContain("<span>{footer.year}</span>");
    expect(source).not.toContain("<span>{footer.copyright}</span>");
  });

  it("publishes the measured header height for sticky sections", () => {
    expect(source).toContain("--template-header-height");
    expect(source).toContain("ResizeObserver");
    expect(source).toContain("header.getBoundingClientRect().height");
  });
});
