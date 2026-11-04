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
    expect(sectionSource).toContain(
      "min-h-[calc(100svh-var(--template-header-height))]",
    );
    const sectionOpening = sectionSource.split("<section")[1].split(">")[0];
    expect(sectionOpening.match(/\S*mb-[\w-]+/g)).toEqual([
      "[@media(max-width:760px)]:mb-8",
    ]);
    expect(sectionSource).toContain("object-[center_6%]");
    expect(sectionSource).toContain("[@media(max-width:960px)]");
    expect(sectionSource).not.toContain("sticky");
  });

  it("uses the shared one-time reveal while leaving normal scroll physics intact", () => {
    expect(sectionSource).toContain("data-template-reveal");
    expect(sectionSource).toContain("data-template-line-reveal");
    expect(sectionSource).toContain("data-story-copy");
    expect(sectionSource).not.toContain('window.addEventListener("scroll"');
    expect(sectionSource).not.toContain("createStoryTransitionController");
  });

  it("cycles optional host-owned stills with a crossfade, not a sticky sequence", () => {
    expect(sectionSource).toContain("content.sequence");
    expect(sectionSource).toContain("data-story-frame");
    expect(sectionSource).toContain("setupStoryMediaCycle");
    expect(sectionSource).toContain("data-story-active");
    expect(sectionSource).toContain("duration-[1800ms]");
    expect(sectionSource).toContain("motion-reduce:!animate-none");
  });
});
