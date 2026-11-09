export function mountFaqMotion(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
) {
  const root = doc.documentElement;
  const listeners = new AbortController();
  const heights = new Map<HTMLDetailsElement, number>();
  const targets = [...doc.querySelectorAll<HTMLElement>("[data-faq-reveal]")];
  const animations = new Map<Element, Animation>();
  const items = [
    ...doc.querySelectorAll<HTMLDetailsElement>("[data-faq-accordion]"),
  ];
  function cancel(element: Element) {
    animations.get(element)?.cancel();
    animations.delete(element);
  }
  function play(
    element: HTMLElement,
    frames: Keyframe[],
    duration: number,
    delay = 0,
  ) {
    cancel(element);
    if (preference.matches || !element.animate) return;
    try {
      const animation = element.animate(frames, {
        duration,
        delay,
        fill: "both",
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
      animations.set(element, animation);
      void animation.finished
        .catch(() => {})
        .then(() => {
          if (animations.get(element) === animation) {
            animation.cancel();
            animations.delete(element);
          }
        });
    } catch {
      // Native disclosures remain usable if motion is unavailable.
    }
  }
  for (const item of items) {
    item.querySelector("summary")?.addEventListener(
      "click",
      () => {
        for (const current of items) {
          if (current.open || current === item)
            heights.set(current, current.getBoundingClientRect().height);
        }
      },
      { signal: listeners.signal },
    );
    item.addEventListener(
      "toggle",
      () => {
        const answer = item.querySelector<HTMLElement>(".faq-answer");
        if (answer) cancel(answer);
        cancel(item);
        if (!item.open) {
          const height = item.getBoundingClientRect().height;
          play(
            item,
            [
              { height: `${heights.get(item) ?? height}px` },
              { height: `${height}px` },
            ],
            340,
          );
          heights.set(item, height);
          return;
        }
        heights.set(item, item.getBoundingClientRect().height);
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
            480,
          );
      },
      { signal: listeners.signal },
    );
  }
  let observer: IntersectionObserver | undefined;
  function show(element: HTMLElement) {
    element.dataset.faqVisible = "";
    observer?.unobserve(element);
  }
  function settle() {
    observer?.disconnect();
    for (const element of targets) show(element);
    delete root.dataset.faqMotion;
    for (const element of animations.keys()) cancel(element);
  }
  if (
    root.dataset.faqMotion === "armed" &&
    !preference.matches &&
    typeof IntersectionObserver !== "undefined" &&
    typeof root.animate === "function"
  ) {
    try {
      observer = new IntersectionObserver(
        (entries) => {
          const positions = new Map<Element | null, number>();
          for (const entry of entries) {
            const element = entry.target as HTMLElement;
            if (
              !entry.isIntersecting ||
              element.hasAttribute("data-faq-visible")
            )
              continue;
            const group = element.closest("[data-faq-sequence]");
            const position = positions.get(group) ?? 0;
            positions.set(group, position + 1);
            const entrance =
              browser.scrollY < 40
                ? Number(group?.getAttribute("data-faq-sequence") ?? 0)
                : 0;
            show(element);
            play(
              element,
              [
                { opacity: 0, transform: "translateY(24px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
              700,
              entrance + Math.min(position * 90, 540),
            );
          }
        },
        { rootMargin: "0px 0px -48px 0px", threshold: 0 },
      );
      for (const element of targets) observer.observe(element);
      root.dataset.faqMotion = "ready";
    } catch {
      settle();
    }
  } else {
    settle();
  }
  doc.addEventListener(
    "focusin",
    (event) => {
      const element = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-faq-reveal]",
      );
      if (element) {
        show(element);
        cancel(element);
      }
    },
    { signal: listeners.signal },
  );
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
