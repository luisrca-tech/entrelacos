/** Keep the decorative CSS loop dormant outside the visible, active page. */
export function mountDecorativeMotion(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
): () => void {
  const decorations = [
    {
      element: doc.querySelector<HTMLElement>(".gift-object"),
      attribute: "data-gift-playing",
    },
    {
      element: doc.querySelector<HTMLElement>(".union-art"),
      attribute: "data-union-playing",
    },
  ];
  if (typeof IntersectionObserver !== "function") return () => {};
  const visible = new Set<Element>();
  let away = false;
  let disposed = false;
  function sync() {
    if (disposed) return;
    for (const { element, attribute } of decorations) {
      element?.toggleAttribute(
        attribute,
        visible.has(element) && !away && !doc.hidden && !preference.matches,
      );
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      sync();
    },
    { threshold: 0 },
  );
  function hide() {
    away = true;
    sync();
  }
  function show() {
    away = false;
    sync();
  }
  for (const { element } of decorations) {
    if (element) observer.observe(element);
  }
  preference.addEventListener("change", sync);
  doc.addEventListener("visibilitychange", sync);
  browser.addEventListener("pagehide", hide);
  browser.addEventListener("pageshow", show);
  return () => {
    disposed = true;
    observer.disconnect();
    visible.clear();
    preference.removeEventListener("change", sync);
    doc.removeEventListener("visibilitychange", sync);
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pageshow", show);
    for (const { element, attribute } of decorations)
      element?.removeAttribute(attribute);
  };
}
