// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCinematicOpening } from "./cinematicOpening";

const animations: Array<{
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
}> = [];
let cleanup = () => {};
function setup(reduced = false) {
  document.body.innerHTML =
    '<section class="hero"><h1 id="hero-title" tabindex="-1">Our story</h1><div class="union-art"><div class="union-scene"><div class="alliance alliance-first"></div><div class="alliance alliance-second"></div></div></div><button data-opening-skip hidden>Skip</button><a href="#details">Details</a><section id="details"></section></section>';
  document.documentElement.dataset.opening = "armed";
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
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("continuous cinematic opening", () => {
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
  it.each(["wheel", "touchstart", "resize", "pagehide"])(
    "settles on %s without blocking the event",
    (type) => {
      const { scene } = setup();
      expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
      const event = new Event(type, { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector("[data-opening-overlay]")).toBeNull();
      expect(document.querySelector(".union-art .union-scene")).toBe(scene);
    },
  );
  it("skips repeatedly, cancels motion and focuses the heading only on explicit skip", () => {
    const { controller } = setup();
    (
      document.querySelector("[data-opening-skip]") as HTMLButtonElement
    ).click();
    controller.settle();
    controller.dispose();
    expect(document.activeElement?.id).toBe("hero-title");
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    expect(document.querySelector("[data-opening-overlay]")).toBeNull();
  });
  it.each(["escape", "focus", "anchor", "preference", "pause"])(
    "settles for %s",
    (reason) => {
      const { preference, controller } = setup();
      expect(document.querySelector("[data-opening-overlay]")).not.toBeNull();
      if (reason === "escape")
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      if (reason === "focus") document.querySelector("a")?.focus();
      if (reason === "anchor")
        document
          .querySelector("a")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (reason === "preference") {
        preference.matches = true;
        preference.dispatchEvent(new Event("change"));
      }
      if (reason === "pause") controller.settle();
      expect(document.querySelector("[data-opening-overlay]")).toBeNull();
    },
  );
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
  it.each(["scroll", "wheel", "touchstart", "keydown", "focusin", "pagehide"])(
    "cancels early arming on %s before enhancement",
    (type) => {
      arm();
      window.dispatchEvent(new Event(type));
      expect(document.documentElement.dataset.opening).toBeUndefined();
    },
  );
});
