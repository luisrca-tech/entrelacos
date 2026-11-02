// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhotoCurtains } from "./photoCurtains";

let notify: IntersectionObserverCallback;
let dispose = () => {};
const cancel = vi.fn();
let finish = () => {};
function setup(ready = true, reduced = false) {
  document.body.innerHTML =
    '<figure><div data-photo-curtain><img alt="The couple"></div><figcaption>Our story</figcaption></figure>';
  const img = document.querySelector("img") as HTMLImageElement;
  Object.defineProperty(img, "complete", { configurable: true, value: ready });
  Object.defineProperty(img, "naturalWidth", {
    configurable: true,
    value: ready ? 800 : 0,
  });
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  dispose = mountPhotoCurtains(document, window, preference);
  return {
    img,
    preference,
    surface: document.querySelector("[data-photo-curtain]") as HTMLElement,
  };
}
function enter(surface: HTMLElement) {
  notify(
    [{ target: surface, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => ({
      cancel,
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    })),
  });
});
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Letters photograph curtains", () => {
  it("reveals only the photograph once, leaving its frame and caption still", async () => {
    const { surface } = setup();
    enter(surface);
    expect(surface.querySelector("[data-curtain-layer]")).not.toBeNull();
    expect(document.querySelector("figcaption")?.textContent).toBe("Our story");
    finish();
    await Promise.resolve();
    expect(surface.querySelector("[data-curtain-layer]")).toBeNull();
    enter(surface);
    expect(Element.prototype.animate).toHaveBeenCalledTimes(2);
  });
  it("waits for a lazy image and exposes failures without an opaque layer", () => {
    const { img, surface } = setup(false);
    enter(surface);
    expect(Element.prototype.animate).not.toHaveBeenCalled();
    img.dispatchEvent(new Event("error"));
    expect(surface.querySelector("[data-curtain-layer]")).toBeNull();
    img.dispatchEvent(new Event("load"));
    expect(Element.prototype.animate).not.toHaveBeenCalled();
  });
  it("starts when a visible lazy image loads", () => {
    const { img, surface } = setup(false);
    enter(surface);
    Object.defineProperty(img, "naturalWidth", { value: 800 });
    img.dispatchEvent(new Event("load"));
    expect(surface.querySelector("[data-curtain-layer]")).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(surface.querySelector("[data-curtain-layer]")).toBeNull();
  });
  it("settles immediately when reduced motion changes", () => {
    const { preference, surface } = setup();
    enter(surface);
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(surface.querySelector("[data-curtain-layer]")).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
  it("keeps images visible without motion or observer support", () => {
    setup(true, true);
    expect(Element.prototype.animate).not.toHaveBeenCalled();
    dispose();
    vi.stubGlobal("IntersectionObserver", undefined);
    setup();
    expect(Element.prototype.animate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-curtain-layer]")).toBeNull();
  });
});
