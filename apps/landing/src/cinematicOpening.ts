export function mountCinematicOpening(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  const root = doc.documentElement;
  const home = doc.querySelector<HTMLElement>(".union-art");
  const scene = home?.querySelector<HTMLElement>(".union-scene");
  const skip = doc.querySelector<HTMLButtonElement>("[data-opening-skip]");
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
    for (const animation of animations) animation.cancel();
    overlay?.remove();
    if (skip) skip.hidden = true;
    delete root.dataset.opening;
  }
  const controller = { settle, dispose: settle };
  let seen = false;
  try {
    seen = browser.sessionStorage.getItem("entrelacos-opening") === "seen";
  } catch {}
  const navigation = browser.performance.getEntriesByType?.("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (
    !home ||
    !scene ||
    !skip ||
    !scene.animate ||
    preference.matches ||
    seen ||
    browser.location.hash ||
    browser.scrollY > 0 ||
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
    root.dataset.opening = "playing";
    try {
      browser.sessionStorage.setItem("entrelacos-opening", "seen");
    } catch {}
    overlay = doc.createElement("div");
    overlay.dataset.openingOverlay = "";
    overlay.setAttribute("aria-hidden", "true");
    const backdrop = doc.createElement("div");
    backdrop.className = "opening-backdrop";
    overlay.append(backdrop, scene);
    doc.body.append(overlay);
    skip.hidden = false;
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
    animations.push(
      dock,
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
    const options = { signal: listeners.signal, passive: true };
    for (const type of ["wheel", "touchstart", "scroll", "resize", "pagehide"])
      browser.addEventListener(type, settle, options);
    doc.addEventListener(
      "keydown",
      (event) => {
        if (["Escape", "PageDown", "ArrowDown", " ", "End"].includes(event.key))
          settle();
      },
      options,
    );
    doc.addEventListener(
      "focusin",
      (event) => {
        if (
          event.target !== skip &&
          !(event.target as Element)?.closest("[data-motion-toggle]")
        )
          settle();
      },
      options,
    );
    doc.addEventListener(
      "click",
      (event) => {
        if ((event.target as Element)?.closest("a")) settle();
      },
      options,
    );
    skip.addEventListener(
      "click",
      () => {
        settle();
        doc.getElementById("hero-title")?.focus({ preventScroll: true });
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
    // A stalled animation must never leave a permanent opening over the page.
    deadline = browser.setTimeout(settle, duration + 500);
    void dock.finished.then(settle, settle);
  } catch {
    settle();
  }
  return controller;
}
