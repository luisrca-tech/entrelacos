import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Media } from "../content";
import { buildIntroTimeline, introSourceForMedia } from "./homeIntro";

const componentSource = readFileSync(
  resolve(import.meta.dirname, "HomeIntro.astro"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
);

describe("home intro sequencing", () => {
  it("builds a staggered reveal followed by the viewport transition", () => {
    expect(buildIntroTimeline(3)).toEqual({
      splitAt: 900,
      firstRevealAt: 900,
      revealAt: [900, 2300, 2650],
      fullscreenAt: 3850,
      fadeAt: 5050,
      completeAt: 5500,
    });
  });

  it("uses posters for video frames and image sources for images", () => {
    const image: Media = {
      kind: "image",
      src: "/portrait.jpg",
      alt: "Portrait",
      width: 1200,
      height: 900,
    };
    const video: Media = {
      kind: "video",
      src: "/hero.mp4",
      poster: "/hero-poster.jpg",
      alt: "Hero film",
      width: 1920,
      height: 1080,
    };

    expect(introSourceForMedia(image)).toBe("/portrait.jpg");
    expect(introSourceForMedia(video)).toBe("/hero-poster.jpg");
  });

  it("prepares the matching hero media before removing the intro overlay", () => {
    expect(componentSource).toContain("prepareHeroMedia");
    expect(componentSource).toContain("data-template-intro-media-ready");
    expect(componentSource.indexOf("prepareHeroMedia();")).toBeLessThan(
      componentSource.indexOf('intro.dataset.templateIntroPhase = "fade"'),
    );
  });

  it("keeps both split labels above and outside the intro media", () => {
    const labelRules = Array.from(
      stylesSource.matchAll(
        /\.template-home-intro__label \{(?<body>[\s\S]*?)\n\}/g,
      ),
      (match) => match.groups?.body ?? "",
    );
    const stageRule = stylesSource.match(
      /\.template-home-intro__stage \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(labelRules.some((rule) => rule.includes("position: fixed"))).toBe(
      true,
    );
    expect(labelRules.some((rule) => rule.includes("z-index: 1"))).toBe(true);
    expect(stageRule).toContain("z-index: 0");
    expect(stylesSource).toContain("--template-intro-stage-height");
    expect(stylesSource).toContain(
      "calc(-100% - var(--template-intro-stage-height) / 2 - var(--template-intro-label-gap))",
    );
    expect(stylesSource).toContain(
      "calc(var(--template-intro-stage-height) / 2 + var(--template-intro-label-gap))",
    );
  });
});
