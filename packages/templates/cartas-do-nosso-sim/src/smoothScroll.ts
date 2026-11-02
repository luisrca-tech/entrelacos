import type { LenisOptions } from "lenis";

type Scroller = { destroy(): void; stop(): void; start(): void };

export function setupSmoothScroll(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
  create: (options: LenisOptions) => Scroller,
): () => void {
  let instance: Scroller | undefined;
  let locked = false;
  let away = false;
  let disposed = false;
  function syncLock() {
    if (!instance) return;
    const next =
      [doc.documentElement, doc.body].some(
        (element) =>
          element.hasAttribute("data-scroll-locked") ||
          element.style.overflow === "hidden" ||
          element.style.overflowY === "hidden",
      ) ||
      doc.querySelector(
        'dialog[open], [role="dialog"][aria-modal="true"]:not([hidden]):not([data-closed])',
      ) !== null;
    if (next === locked) return;
    locked = next;
    if (locked) instance.stop();
    else instance.start();
  }
  function destroy() {
    instance?.destroy();
    instance = undefined;
    locked = false;
  }
  function sync() {
    if (disposed || away || preference.matches) {
      destroy();
      return;
    }
    if (instance) return;
    try {
      instance = create({
        autoRaf: true,
        lerp: 0.07,
        wheelMultiplier: 0.65,
        smoothWheel: true,
        syncTouch: false,
        anchors: { duration: 1.15, lerp: 0 },
        prevent: (node) =>
          node.closest(
            "[data-lenis-prevent], [data-modal-scroll], .data-modal-scroll, dialog, [role=dialog]",
          ) !== null,
      });
      syncLock();
    } catch {
      destroy();
    }
  }
  const observer = new MutationObserver(syncLock);
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "style",
      "data-scroll-locked",
      "open",
      "hidden",
      "aria-modal",
      "data-closed",
    ],
  });
  function hide(event: PageTransitionEvent) {
    away = true;
    destroy();
    if (!event.persisted) dispose();
  }
  function show() {
    away = false;
    sync();
  }
  preference.addEventListener("change", sync);
  browser.addEventListener("pagehide", hide);
  browser.addEventListener("pageshow", show);
  sync();
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    preference.removeEventListener("change", sync);
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pageshow", show);
    destroy();
  }
  return dispose;
}
