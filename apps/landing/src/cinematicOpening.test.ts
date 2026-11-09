// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCinematicOpening } from "./cinematicOpening";
import { mountLandingMotion } from "./landingMotion";

const animations: Array<{
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
}> = [];
let cleanup = () => {};
function prepareOpening() {
  document.body.innerHTML =
    '<section class="hero"><h1 id="hero-title" tabindex="-1">Our story</h1><div class="union-art"><div class="union-scene"><div class="alliance alliance-first"></div><div class="alliance alliance-second"></div></div></div><a href="#details">Details</a><section id="details"></section></section>';
  document.documentElement.dataset.opening = "armed";
}
function setup(reduced = false) {
  prepareOpening();
  const scene = document.querySelector(".union-scene");
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  const controller = mountCinematicOpening(document, window, preference);
  cleanup = controller.dispose;
  return { controller, preference, scene };
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 600,
    y: 160,
    left: 600,
    top: 160,
    width: 400,
    height: 400,
    right: 1000,
    bottom: 560,
    toJSON() {},
  });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const animation = { cancel: vi.fn(), finish, finished };
      animations.push(animation);
      return animation;
    }),
  });
});
afterEach(() => {
  cleanup();
  animations.length = 0;
  document.body.innerHTML = "";
  delete document.documentElement.dataset.opening;
  document.documentElement.removeAttribute("inert");
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("continuous cinematic opening", () => {
  it("omits the introduction skip control from the real page", () => {
    const page = readFileSync(
      new NodeURL("./pages/index.astro", import.meta.url),
      "utf8",
    );
    expect(page).not.toContain("data-opening-skip");
    expect(page).not.toContain("Pular introdução");
    expect(page).toContain('class="skip-link"');
  });

  it("shows the brand between the rings meeting and docking, then removes it", () => {
    const { controller } = setup();
    const brand = document.querySelector(
      "[data-opening-overlay] .opening-brand",
    );
    expect(brand?.textContent).toBe("Entrelaços");
    const animate = vi.mocked(Element.prototype.animate);
    const index = animate.mock.contexts.indexOf(brand as Element);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(animate.mock.calls[index][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: 1, offset: 0.44 }),
        expect.objectContaining({ opacity: 1, offset: 0.64 }),
        expect.objectContaining({ opacity: 0, offset: 0.76 }),
      ]),
    );
    controller.settle();
    expect(document.querySelector(".opening-brand")).toBeNull();
  });

  it("moves the same scene into an overlay and docks it without duplicating rings", async () => {
    const { scene } = setup();
    expect(document.querySelector("[data-opening-overlay] .union-scene")).toBe(
      scene,
    );
    expect(document.querySelectorAll(".union-scene")).toHaveLength(1);
    for (const animation of animations) animation.finish();
    await Promise.resolve();
    expect(document.querySelector(".union-art .union-scene")).toBe(scene);
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
    expect(document.activeElement?.tagName).toBe("BODY");
  });
  it("records that the introduction has started in this tab", () => {
    setup();
    expect(sessionStorage.getItem("entrelacos-opening")).toBe("seen");
  });
  it("settles safely on page hide", () => {
    const { scene } = setup();
    window.dispatchEvent(new Event("pagehide"));
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
    expect(document.querySelector(".union-art .union-scene")).toBe(scene);
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
  });

  it.each([
    "wheel",
    "touchstart",
    "scroll",
    "resize",
    "escape",
    "focus",
    "click",
  ])("keeps playing after %s and unlocks when the shot ends", async (input) => {
    setup();
    if (input === "escape")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else if (input === "focus") document.querySelector("a")?.focus();
    else if (input === "click")
      document.querySelector("a")?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    else window.dispatchEvent(new Event(input));
    expect(document.documentElement.dataset.opening).toBe("playing");
    expect(document.documentElement.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
    for (const animation of animations) animation.finish();
    await Promise.resolve();
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
  });

  it("starts smooth scrolling only after the shot unlocks the page", async () => {
    prepareOpening();
    const createSmooth = vi.fn(() => ({ destroy: vi.fn() }));
    cleanup = mountLandingMotion(
      document,
      window,
      Object.assign(new EventTarget(), { matches: false }),
      createSmooth,
    );
    expect(createSmooth).not.toHaveBeenCalled();
    animations[0].finish();
    await Promise.resolve();
    expect(createSmooth).toHaveBeenCalledOnce();
  });

  it("unlocks immediately if the system switches to reduced motion", () => {
    const { preference } = setup();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
  });

  it("disposes repeatedly without stealing focus", () => {
    const { controller } = setup();
    controller.settle();
    controller.dispose();
    expect(document.activeElement?.tagName).toBe("BODY");
    expect(document.documentElement.dataset.opening).toBeUndefined();
    expect(animations).toHaveLength(5);
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
  });
  it("cancels already started animations if the brand animation cannot initialize", () => {
    const animate = Element.prototype.animate;
    vi.spyOn(Element.prototype, "animate").mockImplementation(function (
      this: Element,
      ...args
    ) {
      if (this.classList.contains("opening-brand"))
        throw new Error("Animation unavailable");
      return animate.apply(this, args);
    });
    const { scene } = setup();
    expect(animations).toHaveLength(1);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
    expect(document.querySelector(".union-art .union-scene")).toBe(scene);
  });
  it("bypasses reduced motion", () => {
    setup(true);
    expect(animations).toHaveLength(0);
  });
  it("replays at the hero on reload even after a previous opening in this session", () => {
    sessionStorage.setItem("entrelacos-opening", "seen");
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    setup();
    expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
  });
  it("replays after a small restored scroll while the hero is still visible", () => {
    vi.stubGlobal("scrollY", 120);
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    setup();
    expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
  });
  it.each(["hash", "restored-scroll", "back_forward"])(
    "bypasses %s",
    (reason) => {
      if (reason === "hash") window.history.replaceState(null, "", "/#modelos");
      if (reason === "restored-scroll") {
        vi.stubGlobal("scrollY", 900);
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
          top: -700,
          bottom: -100,
          width: 400,
          height: 600,
        } as DOMRect);
      }
      if (reason === "back_forward")
        vi.stubGlobal("performance", {
          getEntriesByType: () => [{ type: "back_forward" }],
        });
      setup();
      expect(animations).toHaveLength(0);
      expect(document.documentElement.dataset.opening).toBeUndefined();
    },
  );
  it("does not cover an already visible page if early initialization expired", () => {
    setup().controller.dispose();
    sessionStorage.clear();
    delete document.documentElement.dataset.opening;
    mountCinematicOpening(
      document,
      window,
      Object.assign(new EventTarget(), { matches: false }),
    );
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
  });
  it("survives unavailable storage and releases the scene if animations never finish", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    setup();
    expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
    vi.advanceTimersByTime(6500);
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
  });
});

describe("early page arming and runtime handoff", () => {
  function arm(reduced = false) {
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    const inline = readFileSync(
      new NodeURL("./pages/index.astro", import.meta.url),
      "utf8",
    )
      .split("<script is:inline>")[1]
      .split("</script>")[0];
    new Function(inline)();
  }
  it("arms same-session reload and survives the first frame until the module is ready", () => {
    sessionStorage.setItem("entrelacos-opening", "seen");
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    arm();
    vi.advanceTimersByTime(32);
    expect(document.documentElement.dataset.opening).toBe("armed");
  });
  it.each(["hash", "back_forward", "reduced"])(
    "does not arm for %s",
    (reason) => {
      if (reason === "hash") window.history.replaceState(null, "", "/#modelos");
      if (reason === "back_forward")
        vi.stubGlobal("performance", {
          getEntriesByType: () => [{ type: "back_forward" }],
        });
      arm(reason === "reduced");
      expect(document.documentElement.dataset.opening).toBeUndefined();
    },
  );
  it("does not arm a normal navigation after the introduction was shown", () => {
    sessionStorage.setItem("entrelacos-opening", "seen");
    arm();
    expect(document.documentElement.dataset.opening).toBeUndefined();
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
  });
  it("does not arm when following a link from the FAQ, even on the first home visit", () => {
    vi.spyOn(document, "referrer", "get").mockReturnValue(
      new URL("/duvidas", location.href).href,
    );
    arm();
    expect(document.documentElement.dataset.opening).toBeUndefined();
  });
  it("still arms a deliberate reload after navigating from the FAQ", () => {
    vi.spyOn(document, "referrer", "get").mockReturnValue(
      new URL("/duvidas", location.href).href,
    );
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    arm();
    expect(document.documentElement.dataset.opening).toBe("armed");
  });
  it("still arms a first visit from another website", () => {
    vi.spyOn(document, "referrer", "get").mockReturnValue(
      "https://example.com/",
    );
    arm();
    expect(document.documentElement.dataset.opening).toBe("armed");
  });
  it("lets the runtime decide hero visibility after scroll restoration", () => {
    document.body.innerHTML = '<section class="hero"></section>';
    vi.stubGlobal("scrollY", 120);
    arm();
    window.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.dataset.opening).toBe("armed");
  });
  it("expires if enhancement fails and does not reopen for a late module", () => {
    setup().controller.dispose();
    arm();
    vi.advanceTimersByTime(1300);
    expect(document.documentElement.dataset.opening).toBeUndefined();
    mountCinematicOpening(
      document,
      window,
      Object.assign(new EventTarget(), { matches: false }),
    );
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
  });
  it.each(["scroll", "wheel", "touchstart", "keydown", "focusin", "click"])(
    "keeps early arming and interaction lock after %s",
    (type) => {
      arm();
      window.dispatchEvent(new Event(type));
      expect(document.documentElement.dataset.opening).toBe("armed");
      expect(document.documentElement.hasAttribute("inert")).toBe(true);
    },
  );
  it("unlocks early arming on page hide", () => {
    arm();
    window.dispatchEvent(new Event("pagehide"));
    expect(document.documentElement.dataset.opening).toBeUndefined();
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
  });
});
