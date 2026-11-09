// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountFaqMotion } from "./faqMotion";

let dispose = () => {};
let enter: IntersectionObserverCallback;
const cancel = vi.fn();
const observe = vi.fn();
const unobserve = vi.fn();
const disconnect = vi.fn();
const animate = vi.fn(() => ({ cancel, finished: new Promise(() => {}) }));
function prepare(reduced = false) {
  document.body.innerHTML = `<main><header data-faq-reveal>FAQ</header>${[1, 2].map((id) => `<section data-faq-reveal id="topic-${id}"><details data-faq-accordion><summary>Question ${id}</summary><div class="faq-answer"><p>Answer</p></div></details></section>`).join("")}</main>`;
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  dispose = mountFaqMotion(document, window, preference);
  return { preference, items: [...document.querySelectorAll("details")] };
}
function toggle(item: HTMLDetailsElement, open: boolean) {
  item.open = open;
  item.dispatchEvent(new Event("toggle"));
}
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
      constructor(callback: IntersectionObserverCallback) {
        enter = callback;
      }
    },
  );
  vi.stubGlobal("Animation", class {});
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
});
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("FAQ motion", () => {
  it("keeps one answer open across different topics and animates its expansion", () => {
    const { items } = prepare();
    toggle(items[0], true);
    toggle(items[1], true);
    expect(items.map((item) => item.open)).toEqual([false, true]);
    expect(animate.mock.calls).toHaveLength(2);
    expect(animate.mock.calls[1]).toEqual([
      [
        expect.objectContaining({ height: "0px", opacity: 0 }),
        expect.objectContaining({ opacity: 1 }),
      ],
      expect.objectContaining({ duration: 280 }),
    ]);
  });
  it("cancels an opening before a rapid close or replacement", () => {
    const { items } = prepare();
    toggle(items[0], true);
    toggle(items[0], false);
    expect(cancel).toHaveBeenCalled();
    expect(items[0].open).toBe(false);
  });
  it("reveals each topic on entry and stops observing it", () => {
    prepare();
    const section = document.querySelector("section");
    if (!section) throw new Error("Missing topic fixture");
    const entry = {
      target: section,
      isIntersecting: false,
      boundingClientRect: section.getBoundingClientRect(),
      intersectionRatio: 0,
      intersectionRect: section.getBoundingClientRect(),
      rootBounds: null,
      time: 0,
    };
    enter([entry], {} as IntersectionObserver);
    expect(animate).not.toHaveBeenCalled();
    enter([{ ...entry, isIntersecting: true }], {} as IntersectionObserver);
    expect(animate).toHaveBeenCalledOnce();
    expect(unobserve).toHaveBeenCalledWith(section);
    expect(section.getAttribute("style")).toBeNull();
  });
  it("preserves exclusivity without animation for reduced motion", () => {
    const { items } = prepare(true);
    toggle(items[0], true);
    toggle(items[1], true);
    expect(items.map((item) => item.open)).toEqual([false, true]);
    expect(animate).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it("settles motion immediately when the preference changes", () => {
    const { items, preference } = prepare();
    toggle(items[0], true);
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(cancel).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    toggle(items[1], true);
    expect(animate).toHaveBeenCalledOnce();
  });
  it("keeps answers functional when animation or observation is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: undefined,
    });
    const { items } = prepare();
    toggle(items[0], true);
    toggle(items[1], true);
    expect(items.map((item) => item.open)).toEqual([false, true]);
  });
});
