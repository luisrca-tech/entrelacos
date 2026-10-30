// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIntroTimeline,
  OVERLAY_FADE_MS,
  shouldExpandIntroIntoHero,
} from "./homeIntro";

const source = readFileSync(
  resolve(import.meta.dirname, "HomeIntro.astro"),
  "utf8",
);
const script =
  source
    .match(/<script>([\s\S]*?)<\/script>/)?.[1]
    ?.replace(/import \{[^}]+\} from "\.\/homeIntro";/, "") ?? "";
const execute = new Function(
  "window",
  "document",
  "HTMLElement",
  "HTMLVideoElement",
  "HTMLMediaElement",
  "OVERLAY_FADE_MS",
  "shouldExpandIntroIntoHero",
  transpileModule(script, {}).outputText,
);

describe("home intro browser lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.style.overflow = "";
    delete document.documentElement.dataset.templateIntroComplete;
  });

  function setup({ reduced = false, loaded = true, video = false } = {}) {
    const timeline = buildIntroTimeline(6);
    document.body.innerHTML = `<header data-template-navigation></header><main><div data-template-home-intro data-split-at="${timeline.splitAt}" data-reveal-at="${timeline.revealAt}" data-fullscreen-at="${timeline.fullscreenAt}" data-fade-at="${timeline.fadeAt}" data-complete-at="${timeline.completeAt}">${Array.from({ length: 6 }, () => "<img data-template-intro-frame>").join("")}<button data-template-intro-skip>Skip</button></div><section data-template-hero-intro data-template-has-intro="true"><div data-template-hero-media>${video ? "<video data-template-hero-video></video>" : ""}</div><div data-template-hero-copy></div></section></main>`;
    document.documentElement.style.overflow = "clip";
    document.body.style.overflow = "auto";
    const listeners = new Set<() => void>();
    const query = {
      matches: reduced,
      addEventListener: (_event: string, callback: () => void) =>
        listeners.add(callback),
      removeEventListener: (_event: string, callback: () => void) =>
        listeners.delete(callback),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(
      query as unknown as MediaQueryList,
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(0), 16),
    );
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const intro = document.querySelector<HTMLElement>(
      "[data-template-home-intro]",
    );
    const hero = document.querySelector<HTMLElement>(
      "[data-template-hero-intro]",
    );
    if (!intro || !hero) throw new Error("Intro fixture is incomplete");
    vi.spyOn(hero, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 900,
    } as DOMRect);
    intro.querySelectorAll("img").forEach((image) => {
      Object.defineProperty(image, "complete", { value: loaded });
    });
    execute(
      window,
      document,
      HTMLElement,
      HTMLVideoElement,
      HTMLMediaElement,
      OVERLAY_FADE_MS,
      shouldExpandIntroIntoHero,
    );
    return {
      intro,
      hero,
      play,
      listeners,
      reduce: () => {
        query.matches = true;
        listeners.forEach((callback) => {
          callback();
        });
      },
    };
  }

  it("completes within five seconds even when media never finishes loading", async () => {
    const { intro, hero } = setup({ loaded: false, video: true });
    await vi.advanceTimersByTimeAsync(5050);
    expect(intro.isConnected).toBe(false);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.body.style.overflow).toBe("auto");
  });

  it("starts hero media during the fade and reveals chrome only after the overlay leaves", async () => {
    const { intro, hero, play } = setup({ video: true });
    await vi.advanceTimersByTimeAsync(4499);
    expect(play).not.toHaveBeenCalled();
    expect(hero.dataset.templateIntroComplete).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(intro.dataset.templateIntroPhase).toBe("fade");
    expect(hero.dataset.templateIntroMediaReady).toBe("true");
    expect(play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(550);
    expect(intro.isConnected).toBe(false);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(play).toHaveBeenCalledTimes(1);
    expect(
      document
        .querySelector("[data-template-navigation]")
        ?.hasAttribute("data-template-intro-pending"),
    ).toBe(false);
  });

  it("does not start a sequence after Skip wins the pending preload race", async () => {
    const { intro } = setup({ loaded: false });
    intro.querySelector<HTMLButtonElement>("button")?.click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(intro.dataset.templateIntroPhase).toBeUndefined();
    expect(intro.isConnected).toBe(false);
  });

  it("bypasses the intro and keeps hero video paused with reduced motion", () => {
    const { intro, hero, play } = setup({ reduced: true, video: true });
    expect(intro.isConnected).toBe(false);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(play).not.toHaveBeenCalled();
  });

  it("dismisses immediately if reduced motion is enabled during the intro", async () => {
    const { intro, hero, play, reduce, listeners } = setup({ video: true });
    await vi.advanceTimersByTimeAsync(500);
    reduce();
    expect(intro.isConnected).toBe(false);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(play).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
