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

describe("StorySection compact full-bleed composition", () => {
  it("renders one host-owned background media block with short overlay copy", () => {
    expect(sectionSource).toContain("content.media");
    expect(sectionSource).toContain("content.body");
    expect(sectionSource).toContain('class="template-story__media"');
    expect(sectionSource).toContain("--story-media-ratio");
    expect(sectionSource).toContain('class="template-story__veil"');
    expect(sectionSource).toContain('class="template-story__copy"');
    expect(sectionSource).toContain('loading="lazy"');
    expect(sectionSource).toContain("poster={content.media.poster}");
    expect(sectionSource).toContain("<img");
    expect(sectionSource).not.toContain("content.entries");
    expect(sectionSource).not.toContain("data-story-entry");
    expect(sectionSource).not.toContain("template-story__entry");
  });

  it("keeps the image immersive while preserving readable copy", () => {
    const storyRule = stylesSource.match(/\.template-story\s*\{[^}]*\}/s)?.[0];

    expect(storyRule).toContain("min-height: clamp(48rem, 92svh, 68rem);");
    expect(storyRule).toContain("margin-top: 0;");
    expect(storyRule).toContain("margin-bottom: clamp(3rem, 5vw, 5rem);");
    expect(stylesSource).toContain(".template-story__media");
    expect(stylesSource).toContain(
      "aspect-ratio: var(--story-media-ratio, 4 / 3);",
    );
    expect(stylesSource).toContain(".template-story__veil");
    expect(stylesSource).toContain("background: linear-gradient");
    expect(stylesSource).toContain("object-fit: cover;");
    expect(stylesSource).toContain("object-position: center 6%;");
    expect(stylesSource).toContain(".template-story__copy");
    expect(stylesSource).toContain("@media (max-width: 960px)");
    expect(stylesSource).not.toContain("position: sticky");
  });

  it("uses a local one-time reveal and leaves normal scroll physics intact", () => {
    expect(sectionSource).toContain("IntersectionObserver");
    expect(sectionSource).toContain("data-story-motion");
    expect(sectionSource).toContain("data-story-copy");
    expect(stylesSource).toContain("prefers-reduced-motion: reduce");
    expect(stylesSource).toContain(".template-story__copy.is-visible");
    expect(stylesSource).not.toContain('window.addEventListener("scroll"');
    expect(sectionSource).not.toContain("createStoryTransitionController");
  });

  it("cycles optional host-owned stills with a crossfade, not a sticky sequence", () => {
    expect(sectionSource).toContain("content.sequence");
    expect(sectionSource).toContain("data-story-frame");
    expect(sectionSource).toContain("setupStoryMediaCycle");
    expect(stylesSource).toContain(".template-story__media > img.is-active");
    expect(stylesSource).toContain(
      "opacity 650ms cubic-bezier(0.2, 0.7, 0.2, 1)",
    );
  });
});
