// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountLandingMotion } from "./landingMotion";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-motion");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(reduced = false, fromPage = false) {
  document.body.innerHTML =
    '<section class="hero"></section><h2 class="reveal">Our story</h2><div class="gift-object"></div>';
  const heading = document.querySelector("h2") as HTMLElement;
  const rect = vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
    top: 900,
    bottom: 1000,
    height: 100,
    width: 300,
  } as DOMRect);
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  const destroy = vi.fn();
  const createSmooth = vi.fn((_options: import("lenis").LenisOptions) => ({
    destroy,
  }));
  let dispose = () => {};
  if (fromPage) {
    vi.stubGlobal("matchMedia", () => preference);
    const script = readFileSync(
      new NodeURL("./pages/index.astro", import.meta.url),
      "utf8",
    )
      .split("<script>")[1]
      .split("</script>")[0]
      .replace(/import[\s\S]*?from "[^"]+";/g, "");
    const mount = (...args: Parameters<typeof mountLandingMotion>) => {
      dispose = mountLandingMotion(...args);
      return dispose;
    };
    class Smooth {
      destroy: () => void;
      constructor(options: Parameters<typeof createSmooth>[0]) {
        this.destroy = createSmooth(options).destroy;
      }
    }
    new Function("mountLandingMotion", "Lenis", script)(mount, Smooth);
  } else {
    dispose = mountLandingMotion(document, window, preference, createSmooth);
  }
  return { preference, destroy, createSmooth, dispose, heading, rect };
}

describe("landing motion lifecycle", () => {
  it.each([
    [1440, 0.65],
    [360, 0.72],
  ])(
    "reveals only after entering the reading area at width %s",
    (width, line) => {
      vi.stubGlobal("innerWidth", width);
      vi.stubGlobal("innerHeight", 1000);
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.push(callback);
          return frames.length;
        },
      );
      const { dispose, heading, rect } = setup();
      expect(heading.classList.contains("is-visible")).toBe(false);
      rect.mockReturnValue({ top: line * 1000 + 1, bottom: 1600 } as DOMRect);
      window.dispatchEvent(new Event("scroll"));
      frames.shift()?.(0);
      expect(heading.classList.contains("is-visible")).toBe(false);
      rect.mockReturnValue({ top: line * 1000 - 1, bottom: 1600 } as DOMRect);
      window.dispatchEvent(new Event("scroll"));
      frames.shift()?.(0);
      expect(heading.classList.contains("is-visible")).toBe(true);
      dispose();
    },
  );
  it("immediately exposes keyboard destinations", () => {
    const { dispose } = setup();
    const heading = document.querySelector("h2") as HTMLElement;
    heading.tabIndex = -1;
    heading.focus();
    expect(heading.classList.contains("is-visible")).toBe(true);
    expect(heading.classList.contains("reveal-immediate")).toBe(true);
    dispose();
  });
  it("smooths wheel input while preserving touch and explicitly handling anchors", () => {
    const { createSmooth, dispose } = setup();
    expect(createSmooth).toHaveBeenCalledWith(
      expect.objectContaining({
        autoRaf: true,
        lerp: 0.07,
        wheelMultiplier: 0.65,
        smoothWheel: true,
        syncTouch: false,
        anchors: false,
      }),
    );
    dispose();
  });
  it("keeps native scrolling when reduced motion is requested", () => {
    const { createSmooth, dispose } = setup(true);
    expect(createSmooth).not.toHaveBeenCalled();
    dispose();
  });
  it("restores smoothing after the system permits motion and removes its listener on cleanup", () => {
    const { preference, createSmooth, destroy, dispose } = setup(true);
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(createSmooth).toHaveBeenCalledOnce();
    dispose();
    expect(destroy).toHaveBeenCalledOnce();
    preference.dispatchEvent(new Event("change"));
    expect(createSmooth).toHaveBeenCalledOnce();
  });
  it("responds to operating-system motion changes without a reload", () => {
    const { preference, destroy, dispose } = setup();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(destroy).toHaveBeenCalledOnce();
    dispose();
  });
  it("reveals skipped blocks after fast scrolling and recalculates on resize", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { dispose, heading, rect } = setup();
    rect.mockReturnValue({ top: -1800, bottom: -100 } as DOMRect);
    window.dispatchEvent(new Event("scroll"));
    frames.shift()?.(0);
    expect(heading.classList.contains("is-visible")).toBe(true);
    dispose();

    const next = setup();
    vi.stubGlobal("innerHeight", 2000);
    window.dispatchEvent(new Event("resize"));
    frames.shift()?.(0);
    expect(next.heading.classList.contains("is-visible")).toBe(true);
    next.dispose();
  });
  it("exposes linked sections and their reveal ancestor immediately", () => {
    const { dispose, heading } = setup();
    heading.id = "story";
    document.body.insertAdjacentHTML("beforeend", '<a href="#story">Story</a>');
    document.querySelector("a")?.click();
    expect(heading.classList.contains("is-visible")).toBe(true);
    expect(heading.classList.contains("reveal-immediate")).toBe(true);
    dispose();
  });
  it("reveals the last block even when the reading line cannot reach it", () => {
    vi.stubGlobal("innerHeight", 1000);
    vi.stubGlobal("scrollY", 1000);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      2000,
    );
    const { dispose, heading } = setup();
    expect(heading.classList.contains("is-visible")).toBe(true);
    dispose();
  });
  it("keeps native scrolling and readable content if smoothing fails", () => {
    document.body.innerHTML =
      '<section class="hero"></section><h2 class="reveal">Story</h2>';
    const preference = Object.assign(new EventTarget(), { matches: false });
    let dispose = () => {};
    expect(() => {
      dispose = mountLandingMotion(document, window, preference, () => {
        throw new Error("Failed");
      });
    }).not.toThrow();
    expect(document.querySelector("h2")?.classList.contains("is-visible")).toBe(
      true,
    );
    dispose();
  });
  it("leaves all content exposed after cleanup", () => {
    const { dispose } = setup();
    dispose();
    expect(document.documentElement.classList.contains("motion-ready")).toBe(
      false,
    );
  });
});

describe("cached navigation with the real motion modules", () => {
  it("preserves one smooth instance across repeated cached navigation", () => {
    const { createSmooth, destroy, dispose } = setup(false, true);
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    }
    expect(createSmooth).toHaveBeenCalledOnce();
    dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("disposes on a nonpersisted hide, even after a cached navigation, exactly once", () => {
    const { createSmooth, destroy, dispose } = setup(false, true);
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createSmooth).toHaveBeenCalledTimes(1);
    dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("gift animation visibility", () => {
  function observe() {
    let notify: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    return {
      disconnect,
      enter: (visible: boolean) =>
        notify(
          [
            {
              target: document.querySelector(".gift-object"),
              isIntersecting: visible,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        ),
    };
  }
  it("plays only in view, pauses offscreen and removes the observer on cleanup", () => {
    const observer = observe();
    const { dispose } = setup();
    const gift = document.querySelector(".gift-object") as HTMLElement;
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    observer.enter(true);
    expect(gift.hasAttribute("data-gift-playing")).toBe(true);
    observer.enter(false);
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    observer.enter(true);
    dispose();
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
  it("obeys system motion and document visibility changes while in view", () => {
    const observer = observe();
    const { preference, dispose } = setup(true);
    const gift = document.querySelector(".gift-object") as HTMLElement;
    observer.enter(true);
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(gift.hasAttribute("data-gift-playing")).toBe(true);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(gift.hasAttribute("data-gift-playing")).toBe(true);
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    dispose();
  });
  it("pauses for cached navigation and resumes only after returning", () => {
    const observer = observe();
    const { dispose } = setup();
    const gift = document.querySelector(".gift-object") as HTMLElement;
    observer.enter(true);
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    expect(gift.hasAttribute("data-gift-playing")).toBe(false);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(gift.hasAttribute("data-gift-playing")).toBe(true);
    dispose();
  });
  it("keeps the illustration static without visibility observation", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { dispose } = setup();
    expect(
      document.querySelector(".gift-object")?.hasAttribute("data-gift-playing"),
    ).toBe(false);
    dispose();
  });
});
