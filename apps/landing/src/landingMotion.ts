import type { LenisOptions } from "lenis";
import { mountMotionControls } from "./motionControls";

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
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              entry.target.classList.add("is-visible");
              observer?.unobserve(entry.target);
            }
          },
          { threshold: 0.12, rootMargin: "0px 0px -24px 0px" },
        )
      : undefined;
  for (const element of elements) {
    if (observer) observer.observe(element);
    else element.classList.add("is-visible");
  }
  if (observer) root.classList.add("motion-ready");

  function updateProgress() {
    frame = 0;
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
  const disposeControls = mountMotionControls(doc, preference, (paused) => {
    smooth?.destroy();
    smooth = undefined;
    if (!paused) {
      smooth = createSmooth({
        autoRaf: true,
        lerp: 0.085,
        smoothWheel: true,
        syncTouch: false,
        anchors: true,
        wheelMultiplier: 0.85,
      });
    }
  });
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
    disposeControls();
    observer?.disconnect();
    smooth?.destroy();
    browser.removeEventListener("scroll", scheduleProgress);
    browser.removeEventListener("resize", scheduleProgress);
    browser.cancelAnimationFrame(frame);
    root.classList.remove("motion-ready");
    root.style.removeProperty("--opening-progress");
  }
  return dispose;
}
