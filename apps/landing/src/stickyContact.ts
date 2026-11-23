/**
 * Shows the fixed mobile WhatsApp button only when no other contact button is
 * in view and the cookie notice is closed. CSS hides it on desktop.
 */
export function mountStickyContact(doc: Document): () => void {
  const sticky = doc.querySelector<HTMLElement>(".sticky-contact");
  const guards = [
    ...doc.querySelectorAll<HTMLElement>(".hero-actions, .closing-actions"),
  ];
  const notice = doc.querySelector<HTMLElement>(".consent-notice");
  if (!sticky || typeof IntersectionObserver !== "function") return () => {};
  const inView = new Set<Element>();
  // Until the observer reports, assume the hero CTA is on screen.
  let measured = false;
  function sync() {
    sticky?.toggleAttribute(
      "data-visible",
      measured && inView.size === 0 && (!notice || notice.hidden),
    );
  }
  const observer = new IntersectionObserver((entries) => {
    measured = true;
    for (const entry of entries) {
      if (entry.isIntersecting) inView.add(entry.target);
      else inView.delete(entry.target);
    }
    sync();
  });
  for (const guard of guards) observer.observe(guard);
  const noticeObserver =
    notice && typeof MutationObserver === "function"
      ? new MutationObserver(sync)
      : undefined;
  if (notice)
    noticeObserver?.observe(notice, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  return () => {
    observer.disconnect();
    noticeObserver?.disconnect();
    sticky.removeAttribute("data-visible");
  };
}
