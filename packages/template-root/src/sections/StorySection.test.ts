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
    const stickyStageRule = stylesSource.match(
      /\.template-story__stage\[data-story-stage-ready\]\s*\{[^}]*\}/s,
    )?.[0];
    expect(stickyStageRule).toContain("width: min(");
    expect(stickyStageRule).toContain(
      "(100svh - var(--template-header-height, 5.75rem) - 1.5rem) * 4 / 3",
    );
    expect(stickyStageRule).toContain("height: auto;");
    expect(stickyStageRule).toContain("aspect-ratio: 4 / 3;");
    expect(stickyStageRule).toContain("justify-self: end;");
    expect(stylesSource).toContain(
      "top: var(--template-header-height, 5.75rem);",
    );
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

  it("reveals desktop story media with a smooth curtain transition", () => {
    expect(sectionSource).toContain('"data-story-exiting"');
    expect(sectionSource).toContain("duration: 420");
    expect(stylesSource).toMatch(
      /\.template-story__stage\[data-story-stage-ready\]\s+\.template-story__stage-media\s*\{[^}]*width:\s*100%;[^}]*transition:\s*transform 420ms/s,
    );
    expect(stylesSource).toMatch(
      /\.template-story__stage\[data-story-stage-ready\]\s+\.template-story__stage-media\[data-story-exiting\]\s*\{[^}]*opacity:\s*1;[^}]*transition:\s*none;/s,
    );
    expect(stylesSource).toMatch(
      /\.template-story__stage\[data-story-stage-ready\][\s\S]*?\.template-story__stage-media\[data-active\]\s*\{[^}]*animation:\s*template-story-media-reveal\s+360ms/s,
    );
    expect(stylesSource).toMatch(
      /@keyframes template-story-media-reveal\s*\{[\s\S]*?clip-path:\s*inset\(0 0 100% 0\);[\s\S]*?clip-path:\s*inset\(0\);/,
    );
  });

  it("delays media changes until each entry reaches the story focus band", () => {
    expect(sectionSource.match(/new IntersectionObserver/g)).toHaveLength(1);
    expect(sectionSource).toContain("{ threshold: 0.14 }");
    expect(sectionSource).toContain("createStoryTransitionController");
    expect(sectionSource).toContain("resolveStoryEntryIndex");
    expect(sectionSource).toContain('window.addEventListener("scroll"');
  });

  it("adds desktop-only scroll runway between story entries", () => {
    const entryRule = stylesSource.match(
      /\.template-story__entry\s*\{[^}]*\}/s,
    )?.[0];

    expect(entryRule).toContain("min-height: clamp(28rem, 62svh, 42rem);");
    expect(stylesSource).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.template-story__entry\s*\{[^}]*min-height:\s*0;/,
    );
    expect(stylesSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.template-story__entry\s*\{[^}]*min-height:\s*0;/,
    );
  });
});
