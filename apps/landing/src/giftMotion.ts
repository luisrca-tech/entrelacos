/** Keep the decorative CSS loop dormant outside the visible, active page. */
export function mountGiftMotion(
  doc: Document,
  browser: Window,
  preference: EventTarget & { readonly matches: boolean },
): () => void {
  const gift = doc.querySelector<HTMLElement>(".gift-object");
  if (!gift || typeof IntersectionObserver !== "function") return () => {};
  let visible = false;
  let away = false;
  function sync() {
    gift?.toggleAttribute(
      "data-gift-playing",
      visible && !away && !doc.hidden && !preference.matches,
    );
  }
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some(
        (entry) => entry.target === gift && entry.isIntersecting,
      );
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
  observer.observe(gift);
  preference.addEventListener("change", sync);
  doc.addEventListener("visibilitychange", sync);
  browser.addEventListener("pagehide", hide);
  browser.addEventListener("pageshow", show);
  return () => {
    observer.disconnect();
    preference.removeEventListener("change", sync);
    doc.removeEventListener("visibilitychange", sync);
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pageshow", show);
    gift.removeAttribute("data-gift-playing");
  };
}
