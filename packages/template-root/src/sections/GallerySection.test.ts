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
});
