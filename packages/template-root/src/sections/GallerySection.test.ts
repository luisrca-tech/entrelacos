import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "GallerySection.astro"),
  "utf8",
);
const carouselSource = readFileSync(
  resolve(import.meta.dirname, "../components/GalleryCarousel.tsx"),
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
    expect(source).toContain("client:load");
  });

  it("keeps the split layout and host-owned carousel controls", () => {
    expect(source).toContain("content={content}");
    expect(source).toContain(
      "grid-cols-[minmax(16rem,0.58fr)_minmax(0,1.42fr)]",
    );
    expect(source).not.toContain("site-specific wedding content");
  });

  it("overlays navigation arrows at the vertical center of the gallery media", () => {
    expect(carouselSource).toContain("relative min-w-0");
    expect(carouselSource).toContain("pointer-events-none absolute");
    expect(carouselSource).toContain("aspect-[4/3]");
    expect(carouselSource).toContain("pointer-events-auto");
  });

  it("bleeds gallery media on tablet and mobile while keeping copy inset", () => {
    expect(source).toContain("max-[1024px]:px-0");
    expect(source).toContain("max-[1024px]:px-[var(--template-page-inset)]");
  });

  it("shrinks gallery overlay controls on compact viewports", () => {
    expect(carouselSource).toContain("max-[1024px]:size-7");
    expect(carouselSource).toContain(
      "max-[1024px]:[&>span:not([aria-hidden])]:hidden",
    );
  });

  it("keeps the main-branch close label visible at every viewport", () => {
    const closeButton = carouselSource.slice(
      carouselSource.indexOf("<DialogClose"),
      carouselSource.indexOf("</DialogClose>"),
    );

    expect(closeButton).toContain("<span>{content.controls.closeLabel}</span>");
    expect(closeButton).not.toContain("max-[1024px]");
  });

  it("neutralizes shared dialog defaults and fills the expanded viewport", () => {
    expect(carouselSource).toContain("w-auto max-w-none");
    expect(carouselSource).toContain("translate-none");
    expect(carouselSource).toContain("rounded-none border-0");
    expect(carouselSource).toContain("shadow-none");
    expect(carouselSource).toContain("[&_[data-slot=carousel-content]]:h-full");
    expect(carouselSource).toContain('<figure className="h-full min-h-0">');
    expect(carouselSource).toContain(
      '<figcaption className="mt-3 text-[0.9rem] leading-[1.4]">',
    );
    expect(carouselSource).toContain("compactOnTablet");
  });
});
