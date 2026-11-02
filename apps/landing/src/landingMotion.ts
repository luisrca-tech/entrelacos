import type { LenisOptions } from "lenis";
import { mountCinematicOpening } from "./cinematicOpening";
import { mountGiftMotion } from "./giftMotion";

interface MotionPreference extends EventTarget {
  readonly matches: boolean;
}

export function mountLandingMotion(
  doc: Document,
  browser: Window,
  preference: MotionPreference,
  createSmooth: (options: LenisOptions) => { destroy(): void },
): () => void {
  let smooth: { destroy(): void } | undefined;
  let frame = 0;
  const root = doc.documentElement;
  const hero = doc.querySelector<HTMLElement>(".hero");
  const elements = [...doc.querySelectorAll<HTMLElement>(".reveal")];
  const opening = mountCinematicOpening(doc, browser, preference);
  const disposeGift = mountGiftMotion(doc, browser, preference);
  const pending = new Set(elements);
  root.classList.add("motion-ready");
  function reveal(element: HTMLElement, immediate = false) {
    if (immediate) element.classList.add("reveal-immediate");
    element.classList.add("is-visible");
    pending.delete(element);
  }
  function revealReadingArea() {
    // A top-edge trigger also works for blocks taller than the viewport.
    // Recheck pending blocks on scroll so a fast jump cannot strand a reveal.
    const readingLine =
      browser.innerHeight * (browser.innerWidth <= 760 ? 0.72 : 0.65);
    const pageHeight = doc.documentElement.scrollHeight;
    const atEnd =
      pageHeight > 0 && browser.scrollY + browser.innerHeight >= pageHeight - 2;
    for (const element of pending) {
      const rect = element.getBoundingClientRect();
      if (
        preference.matches ||
        rect.top <= readingLine ||
        (atEnd && rect.top < browser.innerHeight && rect.bottom > 0)
      )
        reveal(element);
    }
  }
  function revealDestination(event: Event) {
    const target = event.target as Element | null;
    const group = target?.closest<HTMLElement>(".reveal");
    if (group) {
      reveal(group, true);
    }
    const anchor = target?.closest<HTMLAnchorElement>('a[href^="#"]');
    if (anchor?.hash) {
      const destination = doc.getElementById(anchor.hash.slice(1));
      for (const element of pending)
        if (
          destination?.contains(element) ||
          (destination && element.contains(destination))
        )
          reveal(element, true);
    }
  }
  doc.addEventListener("focusin", revealDestination);
  doc.addEventListener("click", revealDestination);

  function updateProgress() {
    frame = 0;
    revealReadingArea();
    const progress = Math.min(
      1,
      Math.max(
        0,
        browser.scrollY / (hero?.offsetHeight || browser.innerHeight || 1),
      ),
    );
    root.style.setProperty("--opening-progress", progress.toFixed(4));
  }
  function scheduleProgress() {
    if (!frame) frame = browser.requestAnimationFrame(updateProgress);
  }
  function syncPreference() {
    const paused = preference.matches;
    if (paused) opening.settle();
    revealReadingArea();
    smooth?.destroy();
    smooth = undefined;
    if (!paused) {
      try {
        smooth = createSmooth({
          autoRaf: true,
          lerp: 0.07,
          smoothWheel: true,
          syncTouch: false,
          anchors: true,
          wheelMultiplier: 0.65,
        });
      } catch {
        // Keep native scrolling if the optional enhancement cannot initialize.
      }
    }
  }
  syncPreference();
  preference.addEventListener("change", syncPreference);
  browser.addEventListener("scroll", scheduleProgress, { passive: true });
  browser.addEventListener("resize", scheduleProgress);
  updateProgress();
  let disposed = false;
  function onPageHide(event: PageTransitionEvent) {
    if (!event.persisted) dispose();
  }
  browser.addEventListener("pagehide", onPageHide);
  function dispose() {
    if (disposed) return;
    disposed = true;
    browser.removeEventListener("pagehide", onPageHide);
    preference.removeEventListener("change", syncPreference);
    opening.dispose();
    disposeGift();
    doc.removeEventListener("focusin", revealDestination);
    doc.removeEventListener("click", revealDestination);
    pending.clear();
    smooth?.destroy();
    browser.removeEventListener("scroll", scheduleProgress);
    browser.removeEventListener("resize", scheduleProgress);
    browser.cancelAnimationFrame(frame);
    root.classList.remove("motion-ready");
    root.style.removeProperty("--opening-progress");
  }
  return dispose;
}
