export function mountFaqMotion(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  const listeners = new AbortController();
  const animations = new Map<Element, Animation>();
  const items = [
    ...doc.querySelectorAll<HTMLDetailsElement>("[data-faq-accordion]"),
  ];
  function cancel(element: Element) {
    animations.get(element)?.cancel();
    animations.delete(element);
  }
  function play(element: HTMLElement, frames: Keyframe[], duration: number) {
    cancel(element);
    if (preference.matches || !element.animate) return;
    try {
      const animation = element.animate(frames, {
        duration,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
      animations.set(element, animation);
      void animation.finished
        .catch(() => {})
        .then(() => {
          if (animations.get(element) === animation) animations.delete(element);
        });
    } catch {
      // Native disclosures remain usable if motion is unavailable.
    }
  }
  for (const item of items) {
    item.addEventListener(
      "toggle",
      () => {
        const answer = item.querySelector<HTMLElement>(".faq-answer");
        if (answer) cancel(answer);
        if (!item.open) return;
        // Keep exclusivity in browsers that do not support details[name].
        for (const other of items) if (other !== item) other.open = false;
        if (answer)
          play(
            answer,
            [
              { height: "0px", opacity: 0, transform: "translateY(-4px)" },
              {
                height: `${answer.scrollHeight}px`,
                opacity: 1,
                transform: "translateY(0)",
              },
            ],
            280,
          );
      },
      { signal: listeners.signal },
    );
  }
  let observer: IntersectionObserver | undefined;
  if (!preference.matches && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          play(
            entry.target as HTMLElement,
            [
              { opacity: 0, transform: "translateY(14px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            420,
          );
        }
      },
      { rootMargin: "0px 0px -24px 0px", threshold: 0 },
    );
    for (const section of doc.querySelectorAll<HTMLElement>(
      "[data-faq-reveal]",
    ))
      observer.observe(section);
  }
  function settle() {
    observer?.disconnect();
    for (const element of animations.keys()) cancel(element);
  }
  preference.addEventListener(
    "change",
    () => {
      if (preference.matches) settle();
    },
    { signal: listeners.signal },
  );
  browser.addEventListener("pagehide", settle, { signal: listeners.signal });
  return () => {
    settle();
    listeners.abort();
  };
}
