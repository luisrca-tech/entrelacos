import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Media } from "../content";
import {
  OVERLAY_FADE_MS,
  buildIntroTimeline,
  introSourceForMedia,
  shouldExpandIntroIntoHero,
} from "./homeIntro";

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

  it("prepares and starts the matching hero media in separate stages", () => {
    expect(componentSource).toContain("prepareHeroMedia");
    expect(componentSource).toContain("startHeroMedia");
    expect(componentSource).toContain("data-template-intro-media-ready");
    expect(componentSource).toContain('heroVideo.preload = "auto"');
    expect(componentSource).toContain("heroVideo.load()");
    expect(componentSource).toContain("heroVideo.currentTime = 0");
    expect(componentSource).toContain("heroVideo.play()");
    expect(componentSource.indexOf("prepareHeroMedia();")).toBeLessThan(
      componentSource.indexOf("void Promise.race"),
    );
    expect(componentSource.indexOf("startHeroMedia();")).toBeLessThan(
      componentSource.indexOf('intro.dataset.templateIntroPhase = "fade"'),
    );
  });

  it("paints the revealed media before starting header and hero copy motion", () => {
    expect(componentSource).toContain("revealHeroChrome");
    expect(componentSource.indexOf("intro.remove();")).toBeLessThan(
      componentSource.indexOf("window.requestAnimationFrame(() =>"),
    );
    expect(componentSource).toMatch(
      /window\.requestAnimationFrame\(\(\) => \{\s*window\.requestAnimationFrame\(revealHeroChrome\);\s*\}\);/s,
    );
    expect(stylesSource).toMatch(
      /\.template-hero\[data-template-has-intro="true"\]:not\(\s*\[data-template-intro-complete="true"\]\s*\)/s,
    );
  });

  it("skips the hero handoff when the restored viewport is not the hero", () => {
    expect(shouldExpandIntroIntoHero({ top: 0, bottom: 728 }, 728)).toBe(true);
    expect(shouldExpandIntroIntoHero({ top: -80, bottom: 648 }, 728)).toBe(true);
    expect(shouldExpandIntroIntoHero({ top: -1980, bottom: -1252 }, 728)).toBe(
      false,
    );
    expect(shouldExpandIntroIntoHero(null, 728)).toBe(false);
    expect(OVERLAY_FADE_MS).toBe(450);
    expect(componentSource).toContain("shouldExpandIntroIntoHero");
    expect(componentSource).toContain('templateIntroPhase = "dismiss"');
    expect(componentSource).toContain("OVERLAY_FADE_MS");
    expect(stylesSource).toContain(
      '.template-home-intro[data-template-intro-phase="dismiss"]',
    );
    expect(stylesSource).not.toMatch(
      /\.template-home-intro\[data-template-intro-phase="dismiss"\][\s\S]{0,180}100vw/,
    );
  });

  it("keeps the timed introduction dismissible without hiding the control", () => {
    expect(componentSource).toContain("data-template-intro-skip");
    expect(componentSource).toContain(
      'skip?.addEventListener("click", complete)',
    );
    const introOpeningTag = componentSource.match(
      /<div\s+[\s\S]*?data-template-home-intro[\s\S]*?>/,
    )?.[0];
    expect(introOpeningTag).not.toContain('aria-hidden="true"');
    expect(stylesSource).toMatch(
      /\.template-home-intro__skip \{[\s\S]*?position: absolute;[\s\S]*?z-index: 3;/,
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
    expect(stylesSource).toMatch(
      /calc\(\s*-100%\s*-\s*var\(--template-intro-stage-height\)\s*\/\s*2\s*-\s*var\(--template-intro-label-gap\)\s*\)/s,
    );
    expect(stylesSource).toMatch(
      /calc\(\s*var\(--template-intro-stage-height\)\s*\/\s*2\s*\+\s*var\(--template-intro-label-gap\)\s*\)/s,
    );
  });
});
