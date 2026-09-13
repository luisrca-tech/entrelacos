import Lenis, { type LenisOptions } from "lenis";
import "lenis/dist/lenis.css";

export const LENIS_OPTIONS: LenisOptions = {
  autoRaf: true,
  lerp: 0.095,
  smoothWheel: true,
  syncTouch: false,
  wheelMultiplier: 0.9,
  anchors: true,
};

export type SmoothScrollInstance = {
  destroy: () => void;
};

export type SmoothScrollConstructor = new (
  options: LenisOptions,
) => SmoothScrollInstance;

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

export function setupSmoothScroll(
  browserWindow: Pick<Window, "matchMedia">,
  Constructor: SmoothScrollConstructor = Lenis,
): () => void {
  const query = browserWindow.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ) as MotionQuery;
  let instance: SmoothScrollInstance | null = null;

  const create = () => {
    if (query.matches || instance) return;
    try {
      instance = new Constructor(LENIS_OPTIONS);
    } catch {
      instance = null;
    }
  };
  const destroy = () => {
    instance?.destroy();
    instance = null;
  };
  const onMotionChange = () => {
    if (query.matches) destroy();
    else create();
  };

  create();
  const unsubscribe = subscribeToMotionChange(query, onMotionChange);
  return () => {
    unsubscribe();
    destroy();
  };
}

type RevealElement = HTMLElement & {
  dataset: DOMStringMap;
};

export function setupTemplateMotion(
  root: ParentNode,
  browserWindow: Window,
): () => void {
  const query = browserWindow.matchMedia("(prefers-reduced-motion: reduce)");
  const Observer = browserWindow.IntersectionObserver;
  if (query.matches || !Observer) return () => undefined;

  const elements = Array.from(
    root.querySelectorAll<RevealElement>("[data-template-reveal]"),
  );
  if (elements.length === 0) return () => undefined;

  let observer: IntersectionObserver;
  try {
    observer = new Observer(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const element = entry.target as RevealElement;
          element.dataset.templateRevealState = "visible";
          observer.unobserve(element);
        });
      },
      { threshold: 0.12 },
    );
    elements.forEach((element) => {
      element.dataset.templateMotionReady = "true";
      observer.observe(element);
    });
  } catch {
    elements.forEach((element) => {
      delete element.dataset.templateMotionReady;
      delete element.dataset.templateRevealState;
    });
    return () => undefined;
  }

  return () => {
    observer.disconnect();
    elements.forEach((element) => {
      delete element.dataset.templateMotionReady;
      delete element.dataset.templateRevealState;
    });
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

export function setupMobileNavigation(
  root: ParentNode,
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
    menu.addEventListener("keydown", onKeyDown);
    menu.addEventListener("click", onClick);
    cleanups.push(() => {
      menu.removeEventListener("keydown", onKeyDown);
      menu.removeEventListener("click", onClick);
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
