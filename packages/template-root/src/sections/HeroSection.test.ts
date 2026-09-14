import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "HeroSection.astro"),
  "utf8",
);
const styles = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
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

  it("keeps optional video playback muted, inline and looped as a background", () => {
    expect(source).toContain("autoplay");
    expect(source).toContain("muted");
    expect(source).toContain("loop");
    expect(source).toContain("playsinline");
    expect(source).toContain("data-template-hero-video");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toContain("video.pause()");
  });

  it("renders the host-owned action as a validated link", () => {
    expect(source).toContain("content.action");
    expect(source).toContain('class="template-hero__action"');
    expect(source).toContain("content.action.href");
    expect(source).toContain("content.action.label");
  });

  it("provides a non-blocking page entrance and full-height mobile hero", () => {
    expect(source).toContain("data-template-hero-intro");
    expect(styles).toContain("@keyframes template-hero-media-intro");
    expect(styles).toContain("@keyframes template-hero-copy-intro");
    expect(styles).toContain("min-height: 100svh;");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("uses the optional host intro and keeps the desktop hero at viewport height", () => {
    expect(source).toContain(
      'import HomeIntro from "../components/HomeIntro.astro"',
    );
    expect(source).toContain("introMedia");
    expect(source).toContain("content.intro");
    expect(source).toContain("<HomeIntro");
    expect(styles).toMatch(/\.template-hero\s*\{[^}]*min-height:\s*100svh;/s);
  });
});
