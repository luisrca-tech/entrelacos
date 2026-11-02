// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountLandingMotion } from "./landingMotion";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-motion");
  vi.unstubAllGlobals();
});

function setup(reduced = false, fromPage = false) {
  document.body.innerHTML =
    '<button data-motion-toggle hidden></button><section class="hero"></section><h2 class="reveal">Our story</h2>';
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
  return { preference, destroy, createSmooth, dispose };
}

describe("landing motion lifecycle", () => {
  it("uses a later viewport trigger without a tall-element intersection requirement", () => {
    const construct = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          _callback: IntersectionObserverCallback,
          options: IntersectionObserverInit,
        ) {
          construct(options);
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    const { dispose } = setup();
    expect(construct).toHaveBeenCalledWith({
      threshold: 0,
      rootMargin: `0px 0px -${Math.round(window.innerHeight * 0.22)}px 0px`,
    });
    dispose();
  });
  it("immediately exposes keyboard destinations", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    const { dispose } = setup();
    const heading = document.querySelector("h2") as HTMLElement;
    heading.tabIndex = -1;
    heading.focus();
    expect(heading.classList.contains("is-visible")).toBe(true);
    dispose();
  });
  it("smooths wheel input while preserving touch and native anchors", () => {
    const { createSmooth, dispose } = setup();
    expect(createSmooth).toHaveBeenCalledWith(
      expect.objectContaining({
        autoRaf: true,
        smoothWheel: true,
        syncTouch: false,
        anchors: true,
      }),
    );
    dispose();
  });
  it("keeps native scrolling when reduced motion is requested", () => {
    const { createSmooth, dispose } = setup(true);
    expect(createSmooth).not.toHaveBeenCalled();
    dispose();
  });
  it("destroys smoothing on pause and restores it after an explicit resume", () => {
    const { createSmooth, destroy, dispose } = setup();
    const button = document.querySelector("button") as HTMLButtonElement;
    button.click();
    expect(destroy).toHaveBeenCalledTimes(1);
    button.click();
    expect(createSmooth).toHaveBeenCalledTimes(2);
    dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
    button.click();
    expect(createSmooth).toHaveBeenCalledTimes(2);
  });
  it("responds to operating-system motion changes without a reload", () => {
    const { preference, destroy, dispose } = setup();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(destroy).toHaveBeenCalledOnce();
    dispose();
  });
  it("reveals a section once when it enters and disconnects on cleanup", () => {
    let notify: IntersectionObserverCallback = () => {};
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe = vi.fn();
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const { dispose } = setup();
    const heading = document.querySelector("h2") as HTMLElement;
    const entry: IntersectionObserverEntry = {
      target: heading,
      isIntersecting: false,
      boundingClientRect: heading.getBoundingClientRect(),
      intersectionRect: heading.getBoundingClientRect(),
      intersectionRatio: 0,
      rootBounds: null,
      time: 0,
    };
    notify([entry], {} as IntersectionObserver);
    expect(heading.classList.contains("is-visible")).toBe(false);
    notify(
      [{ ...entry, isIntersecting: true, intersectionRatio: 1 }],
      {} as IntersectionObserver,
    );
    expect(heading.classList.contains("is-visible")).toBe(true);
    expect(unobserve).toHaveBeenCalledWith(heading);
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps content visible when intersection observation is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { dispose } = setup();
    expect(
      document.querySelector(".reveal")?.classList.contains("is-visible"),
    ).toBe(true);
    dispose();
  });
});

describe("cached navigation with the real motion modules", () => {
  it("preserves the pause choice across repeated persisted hide/show without duplicate controls", () => {
    const { preference, createSmooth, destroy, dispose } = setup(false, true);
    const button = document.querySelector("button") as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    }
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(createSmooth).toHaveBeenCalledTimes(1);
    button.click();
    expect(createSmooth).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
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
    document.querySelector("button")?.click();
    expect(createSmooth).toHaveBeenCalledTimes(1);
    dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
