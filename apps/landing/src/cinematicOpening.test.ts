// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mountCinematicOpening,
  OPENING_ATTRIBUTE,
  OPENING_DURATION_MS,
} from "./cinematicOpening";

const read = (path: string) =>
  readFileSync(new NodeURL(path, import.meta.url), "utf8");
const page = read("./pages/index.astro");
const cinematicCss = read("./styles/cinematic.css");
const landingCss = read("./styles/landing.css");
const root = document.documentElement;

function arm({ reduced = false } = {}) {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const inline = page.split("<script is:inline>")[1].split("</script>")[0];
  new Function(inline)();
}

function preference(matches = false) {
  return Object.assign(new EventTarget(), { matches });
}

function toMs(value: string) {
  return value.endsWith("ms")
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  document.body.innerHTML =
    '<section class="hero"><h1>Title</h1><div class="hero-actions"><a href="https://wa.me/1">Falar no WhatsApp</a></div><div class="union-art"><div class="union-scene"></div></div></section>';
});

afterEach(() => {
  root.removeAttribute(OPENING_ATTRIBUTE);
  root.removeAttribute("inert");
  delete root.dataset.opening;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("early arming of the rings introduction", () => {
  it("arms the first visit without locking or covering the page", () => {
    arm();
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(true);
    expect(root.dataset.opening).toBeUndefined();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(sessionStorage.getItem("entrelacos-opening")).toBe("seen");
    vi.advanceTimersByTime(5000);
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("never ships a page lock in the inline script", () => {
    const inline = page.split("<script is:inline>")[1].split("</script>")[0];
    expect(inline).not.toContain("inert");
    expect(inline).not.toContain("dataset.opening");
    expect(page).not.toContain("data-opening-skip");
    expect(page).toContain('class="skip-link"');
  });

  it("skips the second visit in the same tab", () => {
    arm();
    root.removeAttribute(OPENING_ATTRIBUTE);
    arm();
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
  });

  it.each(["reduced", "hash", "back_forward", "internal"])(
    "skips %s",
    (reason) => {
      if (reason === "hash") window.history.replaceState(null, "", "/#modelos");
      if (reason === "back_forward")
        vi.stubGlobal("performance", {
          getEntriesByType: () => [{ type: "back_forward" }],
        });
      if (reason === "internal")
        vi.spyOn(document, "referrer", "get").mockReturnValue(
          new URL("/duvidas", location.href).href,
        );
      arm({ reduced: reason === "reduced" });
      expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
    },
  );

  it("still arms a deliberate reload", () => {
    sessionStorage.setItem("entrelacos-opening", "seen");
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    arm();
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(true);
  });

  it("survives unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    arm();
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(true);
  });
});

describe("rings introduction styles", () => {
  it("is short, runs in place on the rings and only without reduced motion", () => {
    expect(OPENING_DURATION_MS).toBeLessThanOrEqual(1000);
    const rule = cinematicCss.match(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*html\[data-rings-intro\] \.union-scene \{\s*animation: rings-intro (\d+)ms/,
    );
    expect(rule).not.toBeNull();
    expect(Number(rule?.[1])).toBe(OPENING_DURATION_MS);
  });

  it("has no opaque overlay or scroll lock", () => {
    expect(cinematicCss).not.toContain("data-opening");
    expect(cinematicCss).not.toContain("opening-backdrop");
    expect(cinematicCss).not.toContain("opening-brand");
  });

  it("keeps the hero entrance within 0.6 s, CTA included", () => {
    const duration = landingCss.match(
      /\.entrance \{\s*animation: entrance ([\d.]+m?s)/,
    );
    const delay = landingCss.match(
      /\.hero \.button \{\s*animation-delay: ([\d.]+m?s)/,
    );
    expect(duration && delay).toBeTruthy();
    expect(
      toMs(duration?.[1] ?? "") + toMs(delay?.[1] ?? ""),
    ).toBeLessThanOrEqual(600);
    expect(landingCss).toMatch(
      /@keyframes entrance \{\s*from \{\s*opacity: 0\.[1-9]/,
    );
  });
});

describe("rings introduction runtime", () => {
  it("does nothing when the visit was not armed", () => {
    const controller = mountCinematicOpening(document, window, preference());
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
    expect(root.hasAttribute("inert")).toBe(false);
    controller.dispose();
  });

  it("releases the attribute when the rings animation ends", () => {
    root.setAttribute(OPENING_ATTRIBUTE, "");
    mountCinematicOpening(document, window, preference());
    const scene = document.querySelector(".union-scene") as HTMLElement;
    scene.dispatchEvent(
      Object.assign(new Event("animationend"), { animationName: "other" }),
    );
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(true);
    scene.dispatchEvent(
      Object.assign(new Event("animationend"), {
        animationName: "rings-intro",
      }),
    );
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
  });

  it("releases the attribute even if the animation never reports its end", () => {
    root.setAttribute(OPENING_ATTRIBUTE, "");
    mountCinematicOpening(document, window, preference());
    vi.advanceTimersByTime(OPENING_DURATION_MS + 1000);
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
  });

  it("stops at once for reduced motion, now or later", () => {
    root.setAttribute(OPENING_ATTRIBUTE, "");
    mountCinematicOpening(document, window, preference(true));
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
    root.setAttribute(OPENING_ATTRIBUTE, "");
    const later = preference();
    mountCinematicOpening(document, window, later);
    later.matches = true;
    later.dispatchEvent(new Event("change"));
    expect(root.hasAttribute(OPENING_ATTRIBUTE)).toBe(false);
  });

  it("keeps the hero copy and CTA interactive while it plays", () => {
    arm();
    mountCinematicOpening(document, window, preference());
    const cta = document.querySelector<HTMLAnchorElement>(".hero-actions a");
    expect(cta?.closest("[inert]")).toBeNull();
    cta?.focus();
    expect(document.activeElement).toBe(cta);
    expect(document.querySelector(".union-art .union-scene")).not.toBeNull();
  });
});
