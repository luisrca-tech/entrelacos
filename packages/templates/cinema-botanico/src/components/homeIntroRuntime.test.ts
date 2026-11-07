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
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.style.overflow = "";
    delete document.documentElement.dataset.templateIntroComplete;
  });

  function setup({
    reduced = false,
    loaded = true,
    video = false,
    heroTop = 0,
    restoring = false,
  } = {}) {
    const timeline = buildIntroTimeline(6);
    document.body.innerHTML = `<header data-template-navigation></header><main><div data-template-home-intro data-split-at="${timeline.splitAt}" data-reveal-at="${timeline.revealAt}" data-fullscreen-at="${timeline.fullscreenAt}" data-fade-at="${timeline.fadeAt}" data-complete-at="${timeline.completeAt}">${Array.from({ length: 6 }, () => "<img data-template-intro-frame>").join("")}</div><section data-template-hero-intro data-template-has-intro="true"><div data-template-hero-media>${video ? "<video data-template-hero-video></video>" : ""}</div><div data-template-hero-copy></div></section></main>`;
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
    vi.spyOn(document, "readyState", "get").mockReturnValue(
      restoring ? "loading" : "complete",
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
      top: heroTop,
      bottom: heroTop + 900,
    } as DOMRect);
    intro.querySelectorAll("img").forEach((image) => {
      Object.defineProperty(image, "complete", { value: loaded });
    });
    hero
      .querySelector("[data-template-hero-media]")
      ?.setAttribute("data-template-intro-pending", "true");
    execute(
      window,
      document,
      HTMLElement,
      HTMLVideoElement,
      HTMLMediaElement,
      OVERLAY_FADE_MS,
      shouldExpandIntroIntoHero,
    );
    if (!restoring) vi.advanceTimersByTime(16);
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

  it("skips the entire intro when the hero is outside the viewport", async () => {
    const { intro, hero } = setup({ heroTop: -1800 });
    expect(intro.isConnected).toBe(false);
    expect(intro.dataset.templateIntroPhase).toBeUndefined();
    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.body.style.overflow).toBe("auto");
    await vi.advanceTimersByTimeAsync(6000);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for scroll restoration before deciding to show the intro", async () => {
    const { intro, hero } = setup({ restoring: true });
    expect(intro.dataset.templateIntroActive).toBeUndefined();
    expect(document.body.style.overflow).toBe("auto");
    vi.mocked(hero.getBoundingClientRect).mockReturnValue({
      top: -1800,
      bottom: -900,
    } as DOMRect);
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(50);
    expect(intro.isConnected).toBe(false);
    expect(intro.dataset.templateIntroPhase).toBeUndefined();
    expect(document.body.style.overflow).toBe("auto");
  });

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
    const media = hero.querySelector("[data-template-hero-media]");
    await vi.advanceTimersByTimeAsync(4499);
    expect(media?.getAttribute("data-template-intro-pending")).toBe("true");
    expect(play).not.toHaveBeenCalled();
    expect(hero.dataset.templateIntroComplete).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(intro.dataset.templateIntroPhase).toBe("fade");
    expect(hero.dataset.templateIntroMediaReady).toBe("true");
    expect(media?.hasAttribute("data-template-intro-pending")).toBe(false);
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

  it("does not start a sequence after Escape wins the pending preload race", async () => {
    const { intro } = setup({ loaded: false });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(intro.isConnected).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(intro.dataset.templateIntroPhase).toBeUndefined();
    expect(intro.isConnected).toBe(false);
  });

  it.each([500, 4500])(
    "releases the overlay and scroll on Escape at %sms and removes its listener",
    async (elapsed) => {
      const removeListener = vi.spyOn(document, "removeEventListener");
      const { intro, hero, play, listeners } = setup({ video: true });
      await vi.advanceTimersByTimeAsync(elapsed);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(intro.isConnected).toBe(true);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(intro.isConnected).toBe(false);
      expect(document.documentElement.style.overflow).toBe("clip");
      expect(document.body.style.overflow).toBe("auto");
      expect(listeners.size).toBe(0);
      expect(removeListener).toHaveBeenCalledWith(
        "keydown",
        expect.any(Function),
      );
      await vi.advanceTimersByTimeAsync(6000);
      expect(hero.dataset.templateIntroComplete).toBe("true");
      expect(play).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bypasses the intro and keeps hero video paused with reduced motion", () => {
    const { intro, hero, play } = setup({ reduced: true, video: true });
    expect(intro.isConnected).toBe(false);
    expect(hero.dataset.templateIntroComplete).toBe("true");
    expect(play).not.toHaveBeenCalled();
    expect(
      hero
        .querySelector("[data-template-hero-media]")
        ?.hasAttribute("data-template-intro-pending"),
    ).toBe(false);
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
