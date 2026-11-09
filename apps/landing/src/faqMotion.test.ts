// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
  document.documentElement.dataset.faqMotion = "armed";
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  dispose = mountFaqMotion(document, window, preference);
  return { preference, items: [...document.querySelectorAll("details")] };
}
function toggle(item: HTMLDetailsElement, open: boolean) {
  item.open = open;
  item.dispatchEvent(new Event("toggle"));
}
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    height: 200,
    top: 0,
    bottom: 200,
  } as DOMRect);
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
  delete document.documentElement.dataset.faqMotion;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("FAQ motion", () => {
  it("prepares a hidden entrance and staggers individual elements in reading order", () => {
    prepare();
    const targets = [
      ...document.querySelectorAll<HTMLElement>("[data-faq-reveal]"),
    ];
    expect(document.documentElement.dataset.faqMotion).toBe("ready");
    expect(
      targets.every((target) => !target.hasAttribute("data-faq-visible")),
    ).toBe(true);
    const entries = targets.map((target) => ({
      target,
      isIntersecting: true,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      intersectionRatio: 1,
      rootBounds: null,
      time: 0,
    }));
    enter(entries, {} as IntersectionObserver);
    expect(
      targets.every((target) => target.hasAttribute("data-faq-visible")),
    ).toBe(true);
    expect(
      animate.mock.calls.map(
        (call) =>
          (call as unknown as [Keyframe[], KeyframeAnimationOptions])[1].delay,
      ),
    ).toEqual([0, 90, 180]);
    expect(
      animate.mock.calls.every(
        (call) =>
          (call as unknown as [Keyframe[], KeyframeAnimationOptions])[1]
            .duration === 700,
      ),
    ).toBe(true);
  });
  it("makes a pending link visible immediately when keyboard focus reaches it", () => {
    prepare();
    const heading = document.querySelector("[data-faq-reveal]");
    if (!heading) throw new Error("Missing fixture");
    heading.innerHTML = '<a href="#topic-1">Topic</a>';
    heading.querySelector("a")?.focus();
    expect(heading.hasAttribute("data-faq-visible")).toBe(true);
    expect(unobserve).toHaveBeenCalledWith(heading);
  });
  it("restores visible content when motion is disabled or the page is left", () => {
    const { preference } = prepare();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.faqMotion).toBeUndefined();
    expect(
      [...document.querySelectorAll("[data-faq-reveal]")].every((el) =>
        el.hasAttribute("data-faq-visible"),
      ),
    ).toBe(true);
  });
  it("animates the collapsed space when a question closes", () => {
    const { items } = prepare();
    toggle(items[0], true);
    toggle(items[0], false);
    expect(animate.mock.contexts).toContain(items[0]);
  });
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
      expect.objectContaining({ duration: 480 }),
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

describe("FAQ first paint", () => {
  const inline = readFileSync(
    new NodeURL("./pages/duvidas.astro", import.meta.url),
    "utf8",
  )
    .split("<script is:inline>")[1]
    .split("</script>")[0];
  it("arms before rendering and reveals content if the module fails to load", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      new Function(inline)();
      expect(document.documentElement.dataset.faqMotion).toBe("armed");
      vi.advanceTimersByTime(1501);
      expect(document.documentElement.dataset.faqMotion).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not arm when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    new Function(inline)();
    expect(document.documentElement.dataset.faqMotion).toBeUndefined();
  });
  it("does not hide already readable content when the module arrives after the deadline", () => {
    document.body.innerHTML = "<h1 data-faq-reveal>FAQ</h1>";
    dispose = mountFaqMotion(
      document,
      window,
      Object.assign(new EventTarget(), { matches: false }),
    );
    expect(document.documentElement.dataset.faqMotion).toBeUndefined();
    expect(document.querySelector("h1")?.hasAttribute("data-faq-visible")).toBe(
      true,
    );
    expect(observe).not.toHaveBeenCalled();
  });
});
