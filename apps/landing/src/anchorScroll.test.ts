// @vitest-environment jsdom
import Lenis, { type LenisOptions } from "lenis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSmoothScroll } from "../../../packages/templates/cartas-do-nosso-sim/src/smoothScroll";
import { mountLandingMotion } from "./landingMotion";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-scroll-locked");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Exercise both real entry points with the installed Lenis, not a constructor mock.
describe.each([
  ["Letters", setupSmoothScroll],
  ["landing", mountLandingMotion],
] as const)("%s anchor scrolling", (_name, mount) => {
  function fixture(reduced = false, fail = false) {
    let position = 0;
    document.body.innerHTML =
      '<a href="#schedule"><span>Read more</span></a><section id="schedule">Schedule</section>';
    document.documentElement.style.scrollPaddingTop = "80px";
    vi.stubGlobal("innerHeight", 1000);
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => position);
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(((
      options: ScrollToOptions,
    ) => {
      position = options.top ?? position;
    }) as typeof window.scrollTo);
    const preference = Object.assign(new EventTarget(), { matches: reduced });
    vi.stubGlobal("matchMedia", () => preference);
    const instances: Lenis[] = [];
    const create = (options: LenisOptions) => {
      if (fail) throw new Error("Optional enhancement unavailable");
      const scroller = new Lenis({
        ...options,
        autoResize: false,
        autoRaf: false,
      });
      // Deterministic layout: jsdom does not lay out or perform native fragment scrolling.
      Object.assign(scroller.dimensions, {
        height: 1000,
        width: 1440,
        scrollHeight: 6000,
        scrollWidth: 1440,
      });
      instances.push(scroller);
      return scroller;
    };
    const section = document.querySelector("section") as HTMLElement;
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 2000 - position,
          bottom: 2500 - position,
          width: 500,
          height: 500,
        }) as DOMRect,
    );
    cleanup = mount(document, window, preference, create);
    const anchor = document.querySelector("a") as HTMLAnchorElement;
    function click(options: MouseEventInit = {}, cancelled = false) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...options,
      });
      if (cancelled) event.preventDefault();
      // Cancel at window only after application handlers: avoid jsdom navigation timers.
      let handled = false;
      window.addEventListener(
        "click",
        (observed) => {
          handled = observed.defaultPrevented;
          observed.preventDefault();
        },
        { once: true },
      );
      (anchor.querySelector("span") as HTMLSpanElement).dispatchEvent(event);
      return handled;
    }
    return {
      anchor,
      section,
      preference,
      instances,
      click,
      scroll,
      position: () => position,
      nativeJump() {
        position = 2000;
        window.dispatchEvent(new Event("scroll"));
      },
    };
  }

  it("cancels the native jump and advances monotonically to the header-adjusted destination", () => {
    const f = fixture();
    const handled = f.click();
    if (!handled) f.nativeJump();
    const positions = [f.position()];
    for (let time = 1; time <= 1300; time += 16) {
      f.instances[0].raf(time);
      positions.push(f.position());
    }
    expect(handled).toBe(true);
    expect(positions[0]).toBe(0);
    expect(positions[2]).toBeGreaterThan(0);
    expect(positions[2]).toBeLessThan(500);
    expect(
      positions.every(
        (value, index) => index === 0 || value >= positions[index - 1],
      ),
    ).toBe(true);
    expect(positions.at(-1)).toBe(1920);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "shiftKey"])(
    "preserves %s clicks",
    (key) => {
      const f = fixture();
      const scroll = vi.spyOn(f.instances[0], "scrollTo");
      expect(f.click({ [key]: true })).toBe(false);
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])("preserves mouse button %s", (button) => {
    const f = fixture();
    const scroll = vi.spyOn(f.instances[0], "scrollTo");
    expect(f.click({ button })).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([
    ["href", "https://example.org/#schedule"],
    ["href", "/another-page#schedule"],
    ["href", "?different#schedule"],
    ["href", "#missing"],
    ["href", "#%E0%A4%A"],
    ["href", "#"],
    ["target", "_blank"],
    ["download", "invitation.pdf"],
  ])("leaves %s=%s to native navigation", (attribute, value) => {
    const f = fixture();
    f.anchor.setAttribute(attribute, value);
    const scroll = vi.spyOn(f.instances[0], "scrollTo");
    expect(f.click()).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["hidden", "inert", "display", "visibility", "geometry"])(
    "ignores a destination hidden by %s",
    (kind) => {
      const f = fixture();
      if (kind === "display") f.section.style.display = "none";
      else if (kind === "visibility") f.section.style.visibility = "hidden";
      else if (kind === "geometry")
        vi.mocked(f.section.getBoundingClientRect).mockReturnValue({
          width: 0,
          height: 0,
        } as DOMRect);
      else f.section.setAttribute(kind, "");
      const scroll = vi.spyOn(f.instances[0], "scrollTo");
      expect(f.click()).toBe(false);
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it("supports encoded same-page URLs, nested click targets and keyboard activation", () => {
    const f = fixture();
    f.section.id = "our story";
    f.anchor.href = `${window.location.href.split("#")[0]}#our%20story`;
    const scroll = vi.spyOn(f.instances[0], "scrollTo");
    expect(f.click({ detail: 0 })).toBe(true);
    expect(scroll).toHaveBeenCalledWith(
      f.section,
      expect.objectContaining({ duration: 1.15, lerp: 0 }),
    );
  });

  it("does not override another handler's cancellation", () => {
    const f = fixture();
    const scroll = vi.spyOn(f.instances[0], "scrollTo");
    f.click({}, true);
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["root", "body", "dialog", "nested"])(
    "does not animate through a %s scroll lock",
    (kind) => {
      const f = fixture();
      if (kind === "root")
        document.documentElement.setAttribute("data-scroll-locked", "1");
      if (kind === "body") document.body.style.overflow = "hidden";
      if (kind === "dialog")
        document.body.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
      if (kind === "nested") f.anchor.setAttribute("data-lenis-prevent", "");
      const scroll = vi.spyOn(f.instances[0], "scrollTo");
      expect(f.click()).toBe(false);
      expect(scroll).not.toHaveBeenCalled();
      document.body.removeAttribute("style");
    },
  );

  it.each([
    [true, false],
    [false, true],
  ])(
    "uses native anchors with reduced motion=%s and initialization failure=%s",
    (reduced, fail) => {
      const f = fixture(reduced, fail);
      expect(f.click()).toBe(false);
      expect(f.instances).toHaveLength(0);
      expect(f.scroll).not.toHaveBeenCalled();
    },
  );

  it("keeps native anchors during reduced motion and after cleanup", () => {
    const f = fixture();
    f.preference.matches = true;
    f.preference.dispatchEvent(new Event("change"));
    expect(f.click()).toBe(false);
    f.preference.matches = false;
    f.preference.dispatchEvent(new Event("change"));
    expect(f.click()).toBe(true);
    cleanup();
    const scroll = vi.spyOn(f.instances[f.instances.length - 1], "scrollTo");
    expect(f.click()).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("restores exactly one anchor handler after a cached return", () => {
    const f = fixture();
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    const scroll = vi.spyOn(f.instances[f.instances.length - 1], "scrollTo");
    expect(f.click()).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
    expect(f.click()).toBe(false);
    expect(scroll).toHaveBeenCalledOnce();
  });
});
