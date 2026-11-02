import Lenis, { type LenisOptions } from "lenis";
import "lenis/dist/lenis.css";

const SCROLL_CAPTURE_SELECTOR =
  "[data-lenis-prevent], [data-modal-scroll], .data-modal-scroll, dialog, [role=dialog]";

export const LENIS_OPTIONS: LenisOptions = {
  autoRaf: true,
  lerp: 0.07,
  smoothWheel: true,
  syncTouch: false,
  wheelMultiplier: 0.65,
  anchors: false,
  prevent: (node) => node.closest(SCROLL_CAPTURE_SELECTOR) !== null,
};

export type SmoothScrollInstance = {
  destroy: () => void;
  stop?: () => void;
  start?: () => void;
  scrollTo?: (
    target: number,
    options: { duration: number; lerp: number },
  ) => void;
};

export type SmoothScrollConstructor = new (
  options: LenisOptions,
) => SmoothScrollInstance;

type MotionWindow = Window &
  Partial<
    Pick<
      typeof globalThis,
      "IntersectionObserver" | "MutationObserver" | "ResizeObserver"
    >
  >;

type MotionQuery = Pick<MediaQueryList, "matches"> &
  Partial<
    Pick<
      MediaQueryList,
      | "addEventListener"
      | "removeEventListener"
      | "addListener"
      | "removeListener"
    >
  >;

function subscribeToMotionChange(
  query: MotionQuery,
  listener: (event: MediaQueryListEvent) => void,
): () => void {
  if (query.addEventListener) {
    query.addEventListener("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }
  query.addListener?.(listener);
  return () => query.removeListener?.(listener);
}

function isPageScrollLocked(document: Document): boolean {
  const root = document.documentElement;
  const body = document.body;
  return (
    [root, body].some(
      (element) =>
        element.hasAttribute("data-scroll-locked") ||
        element.style.overflow === "hidden" ||
        element.style.overflowY === "hidden",
    ) ||
    document.querySelector(
      'dialog[open], [role="dialog"][aria-modal="true"]:not([hidden]):not([data-closed])',
    ) !== null
  );
}

export function handleTemplateAnchorClick(
  event: MouseEvent,
  browserWindow: Window,
  scroller: SmoothScrollInstance | null,
): void {
  const document = browserWindow.document;
  const node = event.target as Element | null;
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    typeof node?.closest !== "function" ||
    node.closest(SCROLL_CAPTURE_SELECTOR) ||
    isPageScrollLocked(document)
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
    url = new URL(anchor.href, browserWindow.location.href);
    id = decodeURIComponent(url.hash.slice(1));
  } catch {
    return;
  }
  if (
    url.origin !== browserWindow.location.origin ||
    url.pathname !== browserWindow.location.pathname ||
    url.search !== browserWindow.location.search ||
    !id
  )
    return;
  const target = document.getElementById(id);
  if (!target || target.closest("[hidden], [inert]")) return;
  const rect = target.getBoundingClientRect();
  const style = browserWindow.getComputedStyle(target);
  if (
    rect.height <= 0 ||
    rect.width <= 0 ||
    style.visibility === "hidden" ||
    style.display === "none"
  )
    return;
  const headerHeight = Number.parseFloat(
    browserWindow
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--template-header-height"),
  );
  const top = Math.max(
    0,
    rect.top +
      browserWindow.scrollY -
      (Number.isFinite(headerHeight) ? headerHeight : 0),
  );
  event.preventDefault();
  const reduced = browserWindow.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  if (scroller?.scrollTo && !reduced)
    scroller.scrollTo(top, { duration: 1.15, lerp: 0 });
  else
    browserWindow.scrollTo({ top, behavior: reduced ? "instant" : "smooth" });
}

export function setupSmoothScroll(
  browserWindow: Pick<Window, "matchMedia">,
  Constructor: SmoothScrollConstructor = Lenis,
): () => void {
  const view = browserWindow as MotionWindow;
  const document = view.document;
  const query = browserWindow.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ) as MotionQuery;
  let instance: SmoothScrollInstance | null = null;
  let lockObserver: MutationObserver | undefined;
  let locked = false;
  const syncLock = () => {
    if (!instance || !document) return;
    const next = isPageScrollLocked(document);
    if (next === locked) return;
    locked = next;
    if (locked) instance.stop?.();
    else instance.start?.();
  };
  const create = () => {
    if (query.matches || instance) return;
    try {
      instance = new Constructor(LENIS_OPTIONS);
      locked = false;
      syncLock();
      if (document && view.MutationObserver) {
        lockObserver = new view.MutationObserver((records) => {
          if (
            records.some(
              (record) =>
                record.type === "childList" ||
                record.target === document.documentElement ||
                record.target === document.body ||
                (record.target as Element).matches?.("dialog, [role=dialog]"),
            )
          )
            syncLock();
        });
        lockObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            "style",
            "data-scroll-locked",
            "open",
            "hidden",
            "aria-modal",
            "data-open",
            "data-closed",
          ],
        });
      }
    } catch {
      lockObserver?.disconnect();
      instance?.destroy();
      instance = null;
    }
  };
  const destroy = () => {
    lockObserver?.disconnect();
    lockObserver = undefined;
    instance?.stop?.();
    instance?.destroy();
    instance = null;
  };
  const onMotionChange = () => {
    if (query.matches) destroy();
    else create();
  };
  const onAnchorClick = (event: MouseEvent) =>
    handleTemplateAnchorClick(event, view, instance);
  document?.addEventListener("click", onAnchorClick);
  create();
  const unsubscribe = subscribeToMotionChange(query, onMotionChange);
  return () => {
    unsubscribe();
    document?.removeEventListener("click", onAnchorClick);
    destroy();
  };
}

type RevealElement = HTMLElement & {
  dataset: DOMStringMap;
};

export function setupTemplateMotion(
  root: ParentNode,
  browserWindow: MotionWindow,
): () => void {
  const query = browserWindow.matchMedia("(prefers-reduced-motion: reduce)");
  const Observer = browserWindow.IntersectionObserver;
  if (query.matches || !Observer) return () => undefined;

  const elements = new Set<RevealElement>();
  const pending = new Set<RevealElement>();
  let observer: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let additions: MutationObserver | undefined;
  let disabled = false;
  const viewportHeight = () => browserWindow.innerHeight || 1000;
  const thresholdFor = (element: RevealElement) =>
    Math.min(
      0.15,
      (viewportHeight() * 0.9 * 0.5) /
        Math.max(1, element.getBoundingClientRect().height),
    );
  const reveal = (element: RevealElement, immediate = false) => {
    if (!pending.delete(element) && !immediate) return;
    if (immediate) delete element.dataset.templateMotionReady;
    element.dataset.templateRevealState = "visible";
    observer?.unobserve(element);
    resize?.unobserve(element);
  };
  const disable = () => {
    disabled = true;
    observer?.disconnect();
    resize?.disconnect();
    additions?.disconnect();
    pending.clear();
    elements.forEach((element) => {
      delete element.dataset.templateMotionReady;
      delete element.dataset.templateRevealState;
    });
  };
  const checkPageEnd = () => {
    const document = browserWindow.document;
    if (
      !document ||
      document.documentElement.scrollHeight <= 0 ||
      browserWindow.scrollY + viewportHeight() <
        document.documentElement.scrollHeight - 2
    )
      return;
    pending.forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight())
        reveal(element, true);
    });
  };
  const observe = () => {
    if (disabled) return;
    observer?.disconnect();
    try {
      const thresholds = [
        ...new Set([0, 0.15, ...Array.from(pending, thresholdFor)]),
      ].sort((a, b) => a - b);
      observer = new Observer(
        (entries) => {
          entries.forEach((entry) => {
            const element = entry.target as RevealElement;
            if (
              entry.isIntersecting &&
              entry.intersectionRatio >= thresholdFor(element)
            )
              reveal(element);
          });
        },
        {
          threshold: thresholds,
          rootMargin: `0px 0px -${viewportHeight() * 0.1}px 0px`,
        },
      );
      pending.forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) {
          if (rect.bottom <= 0) {
            reveal(element, true);
            return;
          }
          element.dataset.templateMotionReady = "true";
          element.dataset.templateRevealState = "hidden";
        }
        observer?.observe(element);
      });
      checkPageEnd();
    } catch {
      disable();
    }
  };
  const register = (element: RevealElement) => {
    if (elements.has(element) || disabled) return;
    elements.add(element);
    if (element.dataset.templateRevealState === "visible") return;
    pending.add(element);
    resize?.observe(element);
  };
  const onFocus = (event: Event) => {
    elements.forEach((element) => {
      if (event.target && element.contains(event.target as Node))
        reveal(element, true);
    });
  };
  const eventRoot = root as ParentNode &
    Partial<Pick<EventTarget, "addEventListener" | "removeEventListener">>;
  try {
    if (browserWindow.ResizeObserver)
      resize = new browserWindow.ResizeObserver(observe);
    root
      .querySelectorAll<RevealElement>("[data-template-reveal]")
      .forEach(register);
    observe();
    if (
      !disabled &&
      browserWindow.MutationObserver &&
      (root as Node).nodeType
    ) {
      additions = new browserWindow.MutationObserver((records) => {
        if (disabled) return;
        try {
          let changed = false;
          records.forEach((record) => {
            record.removedNodes.forEach((node) => {
              elements.forEach((element) => {
                if (!node.contains(element)) return;
                pending.delete(element);
                elements.delete(element);
                observer?.unobserve(element);
                resize?.unobserve(element);
              });
            });
            record.addedNodes.forEach((node) => {
              if (node.nodeType !== 1) return;
              const element = node as RevealElement;
              const candidates = [
                ...(element.matches("[data-template-reveal]") ? [element] : []),
                ...element.querySelectorAll<RevealElement>(
                  "[data-template-reveal]",
                ),
              ];
              candidates.forEach((candidate) => {
                if (elements.has(candidate)) return;
                register(candidate);
                changed = true;
              });
            });
          });
          if (changed) observe();
        } catch {
          disable();
        }
      });
      additions.observe(root as Node, { childList: true, subtree: true });
    }
  } catch {
    disable();
  }
  eventRoot.addEventListener?.("focusin", onFocus);
  browserWindow.addEventListener?.("scroll", checkPageEnd, { passive: true });
  browserWindow.addEventListener?.("resize", observe);
  const unsubscribe = subscribeToMotionChange(query, () => {
    if (!query.matches) return;
    elements.forEach((element) => {
      reveal(element, true);
    });
    disabled = true;
    observer?.disconnect();
    resize?.disconnect();
    additions?.disconnect();
  });
  return () => {
    unsubscribe();
    eventRoot.removeEventListener?.("focusin", onFocus);
    browserWindow.removeEventListener?.("scroll", checkPageEnd);
    browserWindow.removeEventListener?.("resize", observe);
    disable();
  };
}

type NavigationDetails = HTMLElement & { open: boolean };

type FocusScheduler = (callback: () => void) => void;

function scheduleAfterDefaultAction(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(callback);
    return;
  }
  globalThis.setTimeout(callback, 0);
}

function isAnchorTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const closest = (value as { closest?: unknown }).closest;
  return typeof closest === "function" && closest.call(value, "a") !== null;
}

type NavigationRoot = ParentNode &
  Partial<Pick<EventTarget, "addEventListener" | "removeEventListener">>;

function isInsideMenu(
  menu: NavigationDetails & { contains?: (node: unknown) => boolean },
  target: unknown,
): boolean {
  return typeof menu.contains === "function" && menu.contains(target);
}

export function setupMobileNavigation(
  root: NavigationRoot,
  scheduleFocus: FocusScheduler = scheduleAfterDefaultAction,
): () => void {
  const details = Array.from(
    root.querySelectorAll<NavigationDetails>(
      "[data-template-navigation-mobile]",
    ),
  );
  const cleanups: Array<() => void> = [];

  details.forEach((menu) => {
    const summary = menu.querySelector<HTMLElement>("summary");
    if (!summary) return;

    const close = (restoreFocus: boolean) => {
      if (!menu.open) return;
      menu.open = false;
      if (restoreFocus) summary.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const onClick = (event: MouseEvent) => {
      if (!isAnchorTarget(event.target)) return;
      close(false);
      scheduleFocus(() => summary.focus());
    };
    const onPointerDown = (event: Event) => {
      if (!menu.open || isInsideMenu(menu, event.target)) return;
      close(false);
    };
    menu.addEventListener("keydown", onKeyDown);
    menu.addEventListener("click", onClick);
    root.addEventListener?.("pointerdown", onPointerDown);
    cleanups.push(() => {
      menu.removeEventListener("keydown", onKeyDown);
      menu.removeEventListener("click", onClick);
      root.removeEventListener?.("pointerdown", onPointerDown);
    });
  });

  return () => {
    cleanups.forEach((cleanup) => {
      cleanup();
    });
  };
}

export function navigationStateForHero(
  heroRect: Pick<DOMRect, "top" | "bottom">,
  headerHeight: number,
): "hero" | "solid" {
  return heroRect.top < headerHeight && heroRect.bottom > headerHeight
    ? "hero"
    : "solid";
}

export function setupTemplateInteractions(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const cleanup = [
    setupSmoothScroll(window),
    setupTemplateMotion(document, window),
    setupMobileNavigation(document),
  ];
  return () => {
    cleanup.forEach((dispose) => {
      dispose();
    });
  };
}
