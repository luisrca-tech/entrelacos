import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "WeddingLayout.astro"),
  "utf8",
);

describe("WeddingLayout landmarks", () => {
  it("keeps host content extension slots inside the main landmark", () => {
    const mainStart = source.indexOf("<main");
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

  it("uses a compact utility-driven header bar", () => {
    expect(source).toContain("py-[0.65rem]");
    expect(source).toContain("px-[var(--template-page-inset)]");
    expect(source).not.toContain("../styles.css");
  });

  it("tightens the header further on tablet and mobile", () => {
    expect(source).toContain("[@media(max-width:1024px)]:py-[0.4rem]");
  });

  it("paints main with the same ivory as the gallery canvas", () => {
    expect(source).toContain("min-h-[70vh] bg-template-ivory");
  });

  it("keeps navigation labels host-owned and metadata complete", () => {
    expect(source).toContain("data-navigation-state");
    expect(source).toContain("data-template-navigation-mobile");
    expect(source).toContain("navigation.menuLabel");
    expect(source).toContain('property="og:image:alt"');
    expect(source).toContain('name="twitter:image:alt"');
  });

  it("mounts one toaster for public action feedback", () => {
    expect(source).toContain('import { Toaster } from "@entrelacos/ui/toaster"');
    expect(source).toContain("<Toaster client:load />");
    expect(source.match(/<Toaster/g)).toHaveLength(1);
  });

  it("boots shared motion, scrolling, and menu behavior from the public layout", () => {
    expect(source).toContain("setupTemplateInteractions,");
    expect(source).toContain("setupTemplateInteractions();");
    expect(source).toContain("navigationStateForHero");
  });

  it("disables header motion when reduced motion is requested", () => {
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).toContain("motion-reduce:!animate-none");
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
