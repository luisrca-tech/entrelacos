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
  const viewportInset = () => (browserWindow.innerWidth <= 760 ? 0.22 : 0.28);
  const thresholdFor = (element: RevealElement) =>
    Math.min(
      0.15,
      (viewportHeight() * (1 - viewportInset()) * 0.5) /
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
  const checkScrollPosition = () => {
    const document = browserWindow.document;
    const atEnd =
      document &&
      document.documentElement.scrollHeight > 0 &&
      browserWindow.scrollY + viewportHeight() >=
        document.documentElement.scrollHeight - 2;
    pending.forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (
        rect.height > 0 &&
        (rect.bottom <= 0 || (atEnd && rect.top < viewportHeight()))
      )
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
          rootMargin: `0px 0px -${viewportHeight() * viewportInset()}px 0px`,
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
      checkScrollPosition();
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
  browserWindow.addEventListener?.("scroll", checkScrollPosition, {
    passive: true,
  });
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
    browserWindow.removeEventListener?.("scroll", checkScrollPosition);
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
  if (typeof window === "undefined" || typeof document === "undefined")
    return () => undefined;
  const cleanup = [
    setupTemplateMotion(document, window),
    setupMobileNavigation(document),
  ];
  return () => {
    cleanup.forEach((dispose) => {
      dispose();
    });
  };
}
