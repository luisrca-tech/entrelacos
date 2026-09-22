import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GalleryCarousel, {
  subscribeToSelectedSlide,
  syncSelectedSlide,
} from "./GalleryCarousel";

const content = {
  id: "gallery",
  title: "Memórias",
  controls: {
    ariaLabel: "Navegação da galeria",
    previousLabel: "Anterior",
    nextLabel: "Próxima",
    expandLabel: "Expandir galeria",
    closeLabel: "Fechar galeria",
  },
  items: [
    {
      id: "gallery-one",
      caption: "Primeira foto",
      media: {
        kind: "image" as const,
        src: "/one.svg",
        alt: "Primeira composição",
        width: 1200,
        height: 900,
      },
    },
    {
      id: "gallery-two",
      caption: "Segunda foto",
      media: {
        kind: "image" as const,
        src: "/two.svg",
        alt: "Segunda composição",
        width: 1200,
        height: 900,
      },
    },
  ],
};

const source = readFileSync(
  resolve(import.meta.dirname, "GalleryCarousel.tsx"),
  "utf8",
);

describe("GalleryCarousel", () => {
  it("tracks Embla selection and removes both listeners", () => {
    const listeners = new Map<string, () => void>();
    const removed: string[] = [];
    let selected = 1;
    const api = {
      selectedScrollSnap: () => selected,
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      off: (event: string) => {
        removed.push(event);
      },
      scrollTo: () => undefined,
    };
    const selections: number[] = [];

    const cleanup = subscribeToSelectedSlide(api, (index) =>
      selections.push(index),
    );
    selected = 0;
    listeners.get("select")?.();
    cleanup();

    expect(selections).toEqual([1, 0]);
    expect(removed).toEqual(["select", "reInit"]);
  });

  it("opens the requested slide without transition", () => {
    const calls: Array<[number, boolean]> = [];
    syncSelectedSlide(
      { scrollTo: (index: number, jump: boolean) => calls.push([index, jump]) },
      2,
    );
    expect(calls).toEqual([[2, true]]);
  });

  it("server-renders every slide without media redirects and one control group", () => {
    const html = renderToStaticMarkup(
      createElement(GalleryCarousel, { content }),
    );

    expect(html.match(/data-gallery-slide=/g)).toHaveLength(2);
    expect(html.match(/data-gallery-controls=/g)).toHaveLength(1);
    expect(html.match(/data-gallery-viewport=/g)).toHaveLength(1);
    expect(html).toMatch(
      /data-gallery-viewport[^>]*>[\s\S]*data-gallery-controls[^>]*>[\s\S]*<\/nav>[\s\S]*<\/div><output/,
    );
    expect(html).toContain("Primeira composição");
    expect(html).toContain("Segunda composição");
    expect(html).toContain("Expandir galeria");
    expect(html).toContain("Anterior");
    expect(html).toContain("Próxima");
    expect(html).not.toContain('href="/one.svg"');
    expect(html).not.toContain('href="/two.svg"');
  });

  it("keeps all interface labels supplied by the host", () => {
    const source = renderToStaticMarkup(
      createElement(GalleryCarousel, { content }),
    );

    expect(source).toContain('aria-label="Navegação da galeria"');
    expect(source).toContain(
      'aria-label="Expandir galeria: Primeira composição"',
    );
    expect(source).not.toContain("Previous slide");
    expect(source).not.toContain("Next slide");
  });

  it("disables gallery hover transitions when reduced motion is requested", () => {
    expect(source).toContain(
      "transition-[opacity,transform,background-color] duration-[180ms] motion-reduce:transition-none",
    );
  });
});
