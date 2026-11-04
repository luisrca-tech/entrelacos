export function mountPhotoCurtains(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  if (preference.matches || typeof IntersectionObserver !== "function") {
    delete doc.documentElement.dataset.photoCurtains;
    return () => {};
  }
  const listeners = new AbortController();
  const states = new Map<
    HTMLElement,
    { setVisible(visible: boolean): void; finish(): void }
  >();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        states
          .get(entry.target as HTMLElement)
          ?.setVisible(entry.isIntersecting);
    },
    {
      threshold: 0,
      rootMargin: `0px 0px -${Math.round(browser.innerHeight * 0.16)}px 0px`,
    },
  );
  for (const surface of doc.querySelectorAll<HTMLElement>(
    "[data-photo-curtain]",
  )) {
    const img = surface.querySelector("img");
    const layer = surface.querySelector<HTMLElement>("[data-curtain-layer]");
    if (!img || !layer?.animate) continue;
    let visible = false;
    let started = false;
    let done = false;
    let ready = img.complete && img.naturalWidth > 0;
    let deadline = 0;
    const animations: Animation[] = [];
    function finish() {
      done = true;
      browser.clearTimeout(deadline);
      for (const animation of animations.splice(0)) animation.cancel();
      layer?.remove();
      observer.unobserve(surface);
    }
    function start() {
      if (!img || !layer || !ready || !visible || started || done) return;
      started = true;
      try {
        const mobile = browser.innerWidth <= 760;
        const options = {
          duration: mobile ? 1400 : 1800,
          delay: 160,
          fill: "both" as const,
          easing: "cubic-bezier(0.65,0,0.35,1)",
        };
        animations.push(
          img.animate(
            [
              { transform: `scale(${mobile ? 1.02 : 1.035})` },
              { transform: "scale(1)" },
            ],
            options,
          ),
        );
        const curtain = layer.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(101%)" }],
          options,
        );
        animations.push(curtain);
        deadline = browser.setTimeout(
          finish,
          options.duration + options.delay + 300,
        );
        void curtain.finished.then(finish, finish);
      } catch {
        finish();
      }
    }
    img.addEventListener(
      "load",
      () => {
        ready = img.naturalWidth > 0;
        if (ready) start();
        else finish();
      },
      { signal: listeners.signal },
    );
    img.addEventListener("error", finish, { signal: listeners.signal });
    states.set(surface, {
      setVisible(isVisible) {
        visible = isVisible;
        start();
      },
      finish,
    });
    if (img.complete && !img.naturalWidth) finish();
    else observer.observe(surface);
  }
  function dispose() {
    listeners.abort();
    observer.disconnect();
    for (const state of states.values()) state.finish();
  }
  preference.addEventListener(
    "change",
    () => {
      if (preference.matches) dispose();
    },
    { signal: listeners.signal },
  );
  browser.addEventListener("pagehide", dispose, { signal: listeners.signal });
  return dispose;
}
