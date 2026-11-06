import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "StorySection.astro"),
  "utf8",
);

describe("StorySection editorial chapters", () => {
  it("preserves host-authored content, still images and video fallback", () => {
    expect(source).toContain("content.media");
    expect(source).toContain("buildStoryChapters(content)");
    expect(source).toContain("chapter.body");
    expect(source).toContain("chapter.label");
    expect(source).toContain('loading="lazy"');
    expect(source).toContain("poster={content.media.poster}");
    expect(source).toContain("--story-media-ratio");
  });

  it("connects chapter controls to their copy without automatic playback", () => {
    expect(source).toContain("data-story-chapter");
    expect(source).toMatch(/aria-controls=\{`\$\{id\}-chapter-/);
    expect(source).toMatch(/id=\{hasChapters \? `\$\{id\}-chapter-/);
    expect(source).toContain("aria-pressed={index === 0}");
    expect(source).toContain("setupStoryChapters");
    expect(source).not.toContain("setupStoryMediaCycle");
    expect(source).toContain("[data-story-tabs][hidden]");
  });

  it("uses the shared reveal and respects reduced motion without changing scroll", () => {
    expect(source).toContain("data-template-reveal");
    expect(source).toContain("data-template-line-reveal");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).not.toContain('window.addEventListener("scroll"');
    expect(source).not.toContain("sticky");
  });
});
