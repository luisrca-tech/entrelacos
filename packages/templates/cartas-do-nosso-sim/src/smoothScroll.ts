import type Lenis from "lenis";
import type { LenisOptions } from "lenis";

type Scroller = Pick<Lenis, "destroy" | "stop" | "start"> &
  Partial<Pick<Lenis, "scrollTo">>;

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
        anchors: false,
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
  function onAnchorClick(event: MouseEvent) {
    const node = event.target as Element | null;
    if (
      !instance?.scrollTo ||
      preference.matches ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      typeof node?.closest !== "function" ||
      node.closest(
        "[data-lenis-prevent], [data-modal-scroll], .data-modal-scroll, dialog, [role=dialog]",
      ) ||
      [doc.documentElement, doc.body].some(
        (element) =>
          element.hasAttribute("data-scroll-locked") ||
          element.style.overflow === "hidden" ||
          element.style.overflowY === "hidden",
      ) ||
      doc.querySelector(
        'dialog[open], [role="dialog"][aria-modal="true"]:not([hidden]):not([data-closed])',
      )
    )
      return;
    const anchor = node.closest<HTMLAnchorElement>("a[href]");
    if (
      !anchor ||
      anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")
    )
      return;
    let url: URL;
    let id: string;
    try {
      url = new URL(anchor.href, browser.location.href);
      id = decodeURIComponent(url.hash.slice(1));
    } catch {
      return;
    }
    if (
      url.origin !== browser.location.origin ||
      url.pathname !== browser.location.pathname ||
      url.search !== browser.location.search ||
      !id
    )
      return;
    const destination = doc.getElementById(id);
    if (!destination || destination.closest("[hidden], [inert]")) return;
    const rect = destination.getBoundingClientRect();
    const style = browser.getComputedStyle(destination);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return;
    // Cancel the native fragment jump before Lenis starts. Element targets retain
    // the page's CSS scroll padding and the destination's scroll margin.
    event.preventDefault();
    instance.scrollTo(destination, { duration: 1.15, lerp: 0 });
  }
  doc.addEventListener("click", onAnchorClick);
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
    doc.removeEventListener("click", onAnchorClick);
    preference.removeEventListener("change", sync);
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pageshow", show);
    destroy();
  }
  return dispose;
}
