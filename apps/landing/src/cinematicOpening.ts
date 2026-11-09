export function mountCinematicOpening(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  const root = doc.documentElement;
  const home = doc.querySelector<HTMLElement>(".union-art");
  const heroRect = doc
    .querySelector<HTMLElement>(".hero")
    ?.getBoundingClientRect();
  const scene = home?.querySelector<HTMLElement>(".union-scene");
  const animations: Animation[] = [];
  const listeners = new AbortController();
  let overlay: HTMLElement | undefined;
  let deadline = 0;
  let settled = false;

  function settle() {
    if (settled) return;
    settled = true;
    browser.clearTimeout(deadline);
    listeners.abort();
    if (scene && home) {
      home.append(scene);
      scene.removeAttribute("style");
    }
    for (const animation of animations) {
      void animation.finished.catch(() => {});
      animation.cancel();
    }
    overlay?.remove();
    if (root.dataset.opening) {
      delete root.dataset.opening;
      root.removeAttribute("inert");
    }
    browser.dispatchEvent(new Event("opening:ready"));
  }
  const controller = { settle, dispose: settle };
  const navigation = browser.performance.getEntriesByType?.("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (
    !home ||
    !scene?.animate ||
    preference.matches ||
    browser.location.hash ||
    !heroRect ||
    heroRect.bottom <= 0 ||
    heroRect.top >= browser.innerHeight ||
    navigation?.type === "back_forward" ||
    root.dataset.opening !== "armed"
  ) {
    settle();
    return controller;
  }
  const rect = home.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    settle();
    return controller;
  }
  try {
    try {
      browser.sessionStorage.setItem("entrelacos-opening", "seen");
    } catch {
      // Referrer and navigation checks still prevent internal replays without storage.
    }
    root.dataset.opening = "playing";
    root.setAttribute("inert", "");
    browser.dispatchEvent(new Event("opening:ready"));
    overlay = doc.createElement("div");
    overlay.dataset.openingOverlay = "";
    overlay.setAttribute("aria-hidden", "true");
    const backdrop = doc.createElement("div");
    backdrop.className = "opening-backdrop";
    const brand = doc.createElement("div");
    brand.className = "opening-brand";
    brand.textContent = "Entrelaços";
    overlay.append(backdrop, scene, brand);
    doc.body.append(overlay);
    scene.style.cssText = `position:absolute;left:0;top:0;width:${rect.width}px;height:${rect.height}px;transform-origin:0 0`;
    const mobile = browser.innerWidth <= 760;
    const duration = mobile ? 4200 : 5600;
    const scale = Math.min(
      (browser.innerWidth * 0.86) / rect.width,
      (browser.innerHeight * 0.8) / rect.height,
    );
    const shot = (zoom: number) =>
      `translate(${(browser.innerWidth - rect.width * scale * zoom) / 2}px, ${(browser.innerHeight - rect.height * scale * zoom) / 2}px) scale(${scale * zoom})`;
    const easing = "cubic-bezier(0.65,0,0.35,1)";
    const dock = scene.animate(
      [
        { transform: shot(2.5), offset: 0, easing },
        { transform: shot(1.08), offset: 0.375, easing },
        { transform: shot(1), offset: 0.6 },
        { transform: shot(1), offset: 0.688, easing },
        {
          transform: `translate(${rect.left}px, ${rect.top}px) scale(1)`,
          offset: 1,
        },
      ],
      { duration, fill: "both" },
    );
    animations.push(dock);
    animations.push(
      brand.animate(
        [
          { opacity: 0, translate: "0 12px", offset: 0 },
          { opacity: 0, translate: "0 12px", offset: 0.34 },
          { opacity: 1, translate: "0 0", offset: 0.44 },
          { opacity: 1, translate: "0 0", offset: 0.64 },
          { opacity: 0, translate: "0 -8px", offset: 0.76 },
          { opacity: 0, translate: "0 -8px", offset: 1 },
        ],
        { duration, fill: "both", easing: "ease-in-out" },
      ),
    );
    animations.push(
      backdrop.animate(
        [
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.6 },
          { opacity: 0, offset: 0.96 },
          { opacity: 0, offset: 1 },
        ],
        { duration, fill: "both" },
      ),
    );
    for (const [index, ring] of [
      ...scene.querySelectorAll<HTMLElement>(".alliance"),
    ].entries()) {
      animations.push(
        ring.animate(
          [
            {
              translate: index ? "40% -18%" : "-18% 8%",
              opacity: index ? 0.2 : 0.8,
              offset: 0,
            },
            {
              translate: index ? "18% -10%" : "-8% 4%",
              opacity: 1,
              offset: 0.375,
              easing,
            },
            { translate: "0 0", opacity: 1, offset: 0.6 },
            { translate: "0 0", opacity: 1, offset: 1 },
          ],
          { duration, fill: "both" },
        ),
      );
    }
    const options = { signal: listeners.signal };
    browser.addEventListener("pagehide", settle, options);
    preference.addEventListener(
      "change",
      () => {
        if (preference.matches) settle();
      },
      options,
    );
    // A stalled animation must never leave a permanent opening over the page.
    deadline = browser.setTimeout(settle, duration + 500);
    void dock.finished.then(settle, settle);
  } catch {
    settle();
  }
  return controller;
}
