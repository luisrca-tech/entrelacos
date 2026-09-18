import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sectionSource = readFileSync(
  resolve(import.meta.dirname, "StorySection.astro"),
  "utf8",
);

describe("StorySection compact full-bleed composition", () => {
  it("renders one host-owned background media block with short overlay copy", () => {
    expect(sectionSource).toContain("content.media");
    expect(sectionSource).toContain("content.body");
    expect(sectionSource).toContain("aspect-[var(--story-media-ratio,4/3)]");
    expect(sectionSource).toContain("--story-media-ratio");
    expect(sectionSource).toContain(
      "[background:var(--template-story-gradient)]",
    );
    expect(sectionSource).toContain("data-story-copy");
    expect(sectionSource).toContain('loading="lazy"');
    expect(sectionSource).toContain("poster={content.media.poster}");
    expect(sectionSource).toContain("<img");
    expect(sectionSource).not.toContain("content.entries");
    expect(sectionSource).not.toContain("data-story-entry");
    expect(sectionSource).not.toContain("template-story__entry");
  });

  it("keeps the image immersive while preserving readable copy", () => {
    expect(sectionSource).toContain("min-h-[clamp(48rem,92svh,68rem)]");
    expect(sectionSource).toContain("mb-[clamp(3rem,5vw,5rem)]");
    expect(sectionSource).toContain("object-[center_6%]");
    expect(sectionSource).toContain("max-[960px]");
    expect(sectionSource).not.toContain("sticky");
  });

  it("uses a local one-time reveal and leaves normal scroll physics intact", () => {
    expect(sectionSource).toContain("IntersectionObserver");
    expect(sectionSource).toContain("data-story-motion");
    expect(sectionSource).toContain("data-story-copy");
    expect(sectionSource).toContain("motion-reduce");
    expect(sectionSource).toContain("data-story-visible");
    expect(sectionSource).not.toContain('window.addEventListener("scroll"');
    expect(sectionSource).not.toContain("createStoryTransitionController");
  });

  it("cycles optional host-owned stills with a crossfade, not a sticky sequence", () => {
    expect(sectionSource).toContain("content.sequence");
    expect(sectionSource).toContain("data-story-frame");
    expect(sectionSource).toContain("setupStoryMediaCycle");
    expect(sectionSource).toContain("data-story-active");
    expect(sectionSource).toContain("duration-[650ms]");
  });
});
