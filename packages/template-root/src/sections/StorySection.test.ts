import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sectionSource = readFileSync(
  resolve(import.meta.dirname, "StorySection.astro"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
);

describe("StorySection editorial sequence", () => {
  it("renders host-owned entries in document order with media fallbacks", () => {
    expect(sectionSource).toContain("content.entries");
    expect(sectionSource).toContain("<article");
    expect(sectionSource).toContain("entry.body");
    expect(sectionSource).toContain("entry.media");
    expect(sectionSource).toContain("template-story__entry-media");
    expect(sectionSource).toContain("poster={entry.media.poster}");
    expect(sectionSource).toContain("<img");
    expect(sectionSource).toContain('aria-hidden="true"');
    expect(sectionSource.indexOf("template-story__entry-media")).toBeLessThan(
      sectionSource.indexOf("</article>"),
    );
    expect(sectionSource).toContain("IntersectionObserver");
    expect(sectionSource).toContain("data-story-motion");
    expect(sectionSource).toContain("is-visible");
    expect(sectionSource).not.toContain("tabindex");
  });

  it("uses one desktop sticky sequence and returns to normal flow on mobile", () => {
    expect(stylesSource.match(/position:\s*sticky/g)).toHaveLength(1);
    expect(stylesSource).toContain(".template-story__stage");
    expect(stylesSource).toContain(
      ".template-story__stage[data-story-stage-ready]",
    );
    expect(stylesSource).toContain("height: min(70svh, 42rem);");
    expect(stylesSource).toContain("position: sticky;");
    expect(stylesSource).not.toContain("overflow-y");
    expect(stylesSource).not.toContain("tabindex");
    expect(stylesSource).toContain("overflow-x: clip;");
    expect(stylesSource).toContain(
      ".template-story__stage,\n  .template-story__stage[data-story-stage-ready]",
    );
  });

  it("keeps progressive reveals visible by default and disables motion accessibly", () => {
    expect(stylesSource).toContain("opacity: 1;");
    expect(stylesSource).toContain("translateY");
    expect(stylesSource).toContain("transition-delay");
    expect(stylesSource).toContain("prefers-reduced-motion: reduce");
    expect(stylesSource).toContain(
      ".template-story__stage[data-story-stage-ready] {",
    );
    expect(stylesSource).toContain("position: static;");
    expect(stylesSource).toContain("transition: none;");
  });

  it("crossfades desktop story media instead of swapping it instantly", () => {
    expect(stylesSource).toMatch(
      /\.template-story__stage\[data-story-stage-ready\]\s+\.template-story__stage-media\s*\{[^}]*opacity:\s*0;[^}]*transition:/s,
    );
    expect(stylesSource).toMatch(
      /\.template-story__stage\[data-story-stage-ready\][\s\S]*?\.template-story__stage-media\[data-active\]\s*\{[^}]*opacity:\s*1;/,
    );
  });
});
