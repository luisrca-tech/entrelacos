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

describe("GallerySection progressive fallback", () => {
  it("renders every host media item with stable dimensions and a no-script link fallback", () => {
    expect(source).toContain("content.items.map");
    expect(source).toContain("item.media.width");
    expect(source).toContain("item.media.height");
    expect(source).toContain("item.media.src");
    expect(source).toContain("item.media.alt");
    expect(source).toContain("content.controls.openLabel");
    expect(source).toContain("<img");
    expect(source).toContain("href={");
    expect(source).toContain("previous.id");
    expect(source).toContain("next.id");
    expect(styles).toContain("aspect-ratio: 4 / 3;");
    expect(styles).toContain("object-fit: cover;");
  });

  it("keeps controls and aria labels host-owned", () => {
    expect(source).toContain("content.controls.ariaLabel");
    expect(source).toContain("content.controls.previousLabel");
    expect(source).toContain("content.controls.nextLabel");
    expect(source).not.toContain("site-specific wedding content");
  });
});
