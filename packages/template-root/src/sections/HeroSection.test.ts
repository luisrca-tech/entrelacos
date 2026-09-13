import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "HeroSection.astro"),
  "utf8",
);

describe("HeroSection media contract", () => {
  it("keeps media dimensions and eager image fallback in the rendered source", () => {
    expect(source).toContain('loading="eager"');
    expect(source).toContain("width={content.media.width}");
    expect(source).toContain("height={content.media.height}");
    expect(source).toContain("poster={content.media.poster}");
    expect(source).toContain("<img");
  });

  it("keeps optional video playback muted, inline and looped without autoplay", () => {
    expect(source).toContain("muted");
    expect(source).toContain("loop");
    expect(source).toContain("playsinline");
    expect(source).not.toContain("autoplay");
  });

  it("renders the host-owned action as a validated link", () => {
    expect(source).toContain("content.action");
    expect(source).toContain('class="template-hero__action"');
    expect(source).toContain("content.action.href");
    expect(source).toContain("content.action.label");
  });
});
