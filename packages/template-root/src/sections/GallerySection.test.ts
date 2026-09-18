import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "GallerySection.astro"),
  "utf8",
);
const styles = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
);

describe("GallerySection carousel composition", () => {
  it("renders the host media through one hydrated carousel without direct media links", () => {
    expect(source).toContain(
      'import GalleryCarousel from "../components/GalleryCarousel"',
    );
    expect(source).toContain("<GalleryCarousel");
    expect(source).toContain("client:load");
    expect(source).not.toContain("href={item.media.src}");
    expect(source).not.toContain("previous.id");
    expect(source).not.toContain("next.id");
    expect(styles).toContain("aspect-ratio: 4 / 3;");
    expect(styles).toMatch(
      /\.template-gallery-carousel__frame\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3;/s,
    );
    expect(styles).not.toMatch(
      /\.template-gallery-carousel__frame\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10;/s,
    );
    expect(styles).toContain("object-fit: cover;");
  });

  it("keeps the split layout and host-owned carousel controls", () => {
    expect(source).toContain("content={content}");
    expect(styles).toContain("grid-template-columns");
    expect(styles).toContain("template-gallery-carousel__controls");
    expect(styles).toContain("template-gallery-carousel__expand");
    expect(styles).toContain("template-gallery-dialog");
    expect(source).not.toContain("site-specific wedding content");
  });

  it("overlays navigation arrows at the vertical center of the gallery media", () => {
    const viewportRule = styles.match(
      /\.template-gallery-carousel__viewport\s*\{[^}]*\}/s,
    )?.[0];
    const controlsRule = styles.match(
      /\.template-gallery-carousel__controls\s*\{[^}]*\}/s,
    )?.[0];

    expect(viewportRule).toContain("position: relative;");
    expect(controlsRule).toContain("position: absolute;");
    expect(controlsRule).toContain("z-index: 3;");
    expect(controlsRule).toContain("top: 0;");
    expect(controlsRule).toContain("right: 0;");
    expect(controlsRule).toContain("left: 0;");
    expect(controlsRule).toContain("aspect-ratio: 4 / 3;");
    expect(controlsRule).toContain("align-items: center;");
    expect(controlsRule).toContain("justify-content: space-between;");
    expect(controlsRule).toContain("pointer-events: none;");
    expect(styles).toMatch(
      /\.template-gallery-carousel__controls button\s*\{[^}]*pointer-events:\s*auto;/s,
    );
  });

  it("bleeds gallery media on tablet and mobile while keeping copy inset", () => {
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery\s*\{[\s\S]*?padding-inline:\s*0;/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery__header\s*\{[\s\S]*?padding-inline:\s*var\(--template-page-inset\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery-carousel__slide figcaption[\s\S]*?padding-inline:\s*var\(--template-page-inset\);/,
    );
  });

  it("shrinks gallery overlay controls on compact viewports", () => {
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery-carousel__controls button\s*\{[\s\S]*?width:\s*1\.75rem;[\s\S]*?min-height:\s*1\.75rem;/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery-carousel__expand\s*\{[\s\S]*?width:\s*1\.75rem;[\s\S]*?min-height:\s*1\.75rem;/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery-carousel__expand span:not\(\[aria-hidden\]\)\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it("shows only the close icon in the gallery dialog on tablet and mobile", () => {
    expect(styles).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.template-gallery-dialog__close span:not\(\[aria-hidden\]\)\s*\{[\s\S]*?display:\s*none;/,
    );
  });
});
