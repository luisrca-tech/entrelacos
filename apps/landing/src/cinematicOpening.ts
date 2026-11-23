// The rings introduction is a pure CSS animation on the decorative hero art.
// The inline head script arms it before first paint on the first visit; the
// page is never locked or covered, so the hero copy and CTA stay usable.
export const OPENING_ATTRIBUTE = "data-rings-intro";
export const OPENING_DURATION_MS = 900;
const OPENING_ANIMATION = "rings-intro";

/** Drops the arming attribute once the introduction ends, so it never replays. */
export function mountCinematicOpening(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  const root = doc.documentElement;
  const scene = doc.querySelector<HTMLElement>(".union-scene");
  const listeners = new AbortController();
  let deadline = 0;
  function settle() {
    browser.clearTimeout(deadline);
    listeners.abort();
    root.removeAttribute(OPENING_ATTRIBUTE);
  }
  const controller = { settle, dispose: settle };
  if (!root.hasAttribute(OPENING_ATTRIBUTE) || preference.matches) {
    settle();
    return controller;
  }
  const options = { signal: listeners.signal };
  scene?.addEventListener(
    "animationend",
    (event) => {
      if ((event as AnimationEvent).animationName === OPENING_ANIMATION)
        settle();
    },
    options,
  );
  preference.addEventListener(
    "change",
    () => {
      if (preference.matches) settle();
    },
    options,
  );
  // Fallback if the animation never reports its end (e.g. hidden tab).
  deadline = browser.setTimeout(settle, OPENING_DURATION_MS + 1000);
  return controller;
}
