import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Media } from "../content";
import {
  buildIntroTimeline,
  introFrames,
  introSourceForMedia,
  OVERLAY_FADE_MS,
  shouldExpandIntroIntoHero,
} from "./homeIntro";

const componentSource = readFileSync(
  resolve(import.meta.dirname, "HomeIntro.astro"),
  "utf8",
);
const themeSource = readFileSync(
  resolve(import.meta.dirname, "../theme.css"),
  "utf8",
);

describe("home intro sequencing", () => {
  it("builds a staggered reveal followed by the viewport transition", () => {
    expect(buildIntroTimeline(3)).toEqual({
      splitAt: 500,
      firstRevealAt: 500,
      revealAt: [500, 1450, 1700],
      fullscreenAt: 2600,
      fadeAt: 3600,
      completeAt: 4100,
    });
  });

  it("gives six frames deliberate pacing and bounds larger galleries", () => {
    const timeline = buildIntroTimeline(6);
    expect(timeline.completeAt).toBeGreaterThanOrEqual(4800);
    expect(timeline.completeAt).toBeLessThanOrEqual(5000);
    expect(buildIntroTimeline(100).completeAt).toBeLessThanOrEqual(5000);
    expect(
      timeline.revealAt.every(
        (at, index, all) => index === 0 || at > (all[index - 1] ?? -Infinity),
      ),
    ).toBe(true);
    for (const count of [0, -1, NaN, Infinity]) {
      expect(buildIntroTimeline(count)).toEqual(buildIntroTimeline(1));
    }
  });

  it("matches the shortened image and overlay CSS transitions", () => {
    expect(componentSource).toContain("clip-path_900ms_");
    expect(componentSource).toContain("width_1000ms_");
    expect(componentSource).toContain("height_1000ms_");
    expect(componentSource).toContain("opacity_500ms_ease");
    expect(componentSource).not.toContain("1.4s");
    expect(componentSource).not.toContain("1.2s");
  });

  it("omits one gallery image only in the intro and always ends on hero media", () => {
    const frames = Array.from(
      { length: 6 },
      (_, index) => ({ kind: "image", src: `/frame-${index}.jpg` }) as Media,
    );
    const hero = { kind: "image", src: "/hero.jpg" } as Media;
    expect(introFrames(frames, hero)).toEqual([...frames.slice(0, 5), hero]);
    expect(frames).toHaveLength(6);
    expect(introFrames(frames.slice(0, 1), hero)).toEqual([frames[0], hero]);
    expect(introFrames([], hero)).toEqual([hero]);
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
    expect(componentSource).toContain("data-template-intro-pending");
  });

  it("skips the hero handoff when the restored viewport is not the hero", () => {
    expect(shouldExpandIntroIntoHero({ top: 0, bottom: 728 }, 728)).toBe(true);
    expect(shouldExpandIntroIntoHero({ top: -80, bottom: 648 }, 728)).toBe(
      true,
    );
    expect(shouldExpandIntroIntoHero({ top: -1980, bottom: -1252 }, 728)).toBe(
      false,
    );
    expect(shouldExpandIntroIntoHero(null, 728)).toBe(false);
    expect(OVERLAY_FADE_MS).toBe(500);
    expect(componentSource).toContain("shouldExpandIntroIntoHero");
    expect(componentSource).toContain('templateIntroPhase = "dismiss"');
    expect(componentSource).toContain("OVERLAY_FADE_MS");
    expect(componentSource).toContain("data-[template-intro-phase=dismiss]");
    expect(componentSource).not.toContain(
      "data-[template-intro-phase=dismiss]:w-screen",
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
    expect(componentSource).toContain("absolute");
    expect(componentSource).toContain("z-[3]");
  });

  it("keeps both split labels above and outside the intro media", () => {
    expect(componentSource).toContain("group/intro");
    expect(componentSource).toContain(
      "group-data-[template-intro-phase=split]/intro:opacity-100",
    );
    expect(componentSource).toContain(
      "group-data-[template-intro-phase=split]/intro:[transform:translate(-50%,calc(-100%_",
    );
    expect(componentSource).not.toContain("-translate-x-1/2 -translate-y-1/2");
    expect(componentSource).not.toMatch(
      /class="[^"]*\bdata-\[template-intro-phase=split\]:(?:opacity-100|w-\[)/,
    );
    expect(componentSource).toContain("fixed");
    expect(componentSource).toContain("z-[1]");
    expect(componentSource).toContain("--template-intro-stage-height");
    expect(componentSource).toContain("--template-intro-label-gap");
    expect(themeSource).toContain("template-hero-copy-intro");
  });
});
