type RenderedLine = { text: string; top: number; height: number };

export function measureRenderedLines(heading: HTMLElement): RenderedLine[] {
  const text = heading.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return [];
  try {
    const bounds = heading.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
    const range = document.createRange();
    const lines: RenderedLine[] = [];
    let previousTop = Number.NaN;
    for (const match of (text.textContent ?? "").matchAll(/\S+/g)) {
      range.setStart(text, match.index);
      range.setEnd(text, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      if (!rect.height) continue;
      const height = lineHeight || rect.height;
      if (!lines.length || Math.abs(rect.top - previousTop) > 1) {
        lines.push({
          text: match[0],
          top: rect.top - bounds.top - (height - rect.height) / 2,
          height,
        });
        previousTop = rect.top;
      } else {
        lines[lines.length - 1].text += ` ${match[0]}`;
      }
    }
    return lines;
  } catch {
    return [];
  }
}

export function setupLineReveals(
  root: ParentNode,
  reducedMotion: boolean,
): () => void {
  if (reducedMotion || typeof Element.prototype.animate !== "function")
    return () => {};
  const cleanups: Array<() => void> = [];
  for (const heading of root.querySelectorAll<HTMLElement>(
    "[data-template-line-reveal]",
  )) {
    const target = heading.closest<HTMLElement>("[data-template-reveal]");
    if (
      !target ||
      heading.childNodes.length !== 1 ||
      heading.firstChild?.nodeType !== Node.TEXT_NODE
    )
      continue;
    let disposed = false;
    let started = false;
    let fontsReady = false;
    let wasReady = target.dataset.templateMotionReady === "true";
    const animations: Animation[] = [];
    let restore = () => {};
    let resize: ResizeObserver | undefined;
    const prepare = () => {
      if (
        disposed ||
        started ||
        !fontsReady ||
        target.dataset.templateMotionReady !== "true"
      )
        return;
      restore();
      try {
        const lines = measureRenderedLines(heading);
        if (!lines.length) return;
        const text = heading.firstChild;
        if (!text) return;
        const source = document.createElement("span");
        const previousPosition = heading.style.getPropertyValue("position");
        const previousPriority = heading.style.getPropertyPriority("position");
        const overlay = document.createElement("span");
        restore = () => {
          if (source.isConnected) source.replaceWith(text);
          else if (text.parentNode === source) heading.append(text);
          overlay.remove();
          if (previousPosition)
            heading.style.setProperty(
              "position",
              previousPosition,
              previousPriority,
            );
          else heading.style.removeProperty("position");
          delete heading.dataset.templateLineReady;
        };
        source.append(text);
        source.style.opacity = "0";
        overlay.setAttribute("aria-hidden", "true");
        Object.assign(overlay.style, {
          position: "absolute",
          inset: "0",
          pointerEvents: "none",
        });
        for (const line of lines) {
          const mask = document.createElement("span");
          Object.assign(mask.style, {
            position: "absolute",
            left: "0",
            right: "0",
            top: `${line.top}px`,
            height: `${line.height}px`,
            lineHeight: `${line.height}px`,
            display: "block",
            overflow: "hidden",
            paddingBottom: "0.2em",
            boxSizing: "content-box",
          });
          const fragment = document.createElement("span");
          fragment.dataset.templateLineFragment = "";
          fragment.textContent = line.text;
          Object.assign(fragment.style, {
            display: "block",
            whiteSpace: "nowrap",
            transform: "translateY(115%)",
          });
          mask.append(fragment);
          overlay.append(mask);
        }
        heading.style.position = "relative";
        heading.append(source, overlay);
        heading.dataset.templateLineReady = "true";
        if (target.dataset.templateRevealState === "visible")
          observerCallback();
      } catch {
        restore();
      }
    };
    const observerCallback = () => {
      if (target.dataset.templateMotionReady !== "true") {
        if (!wasReady) return;
        started = true;
        resize?.disconnect();
        for (const animation of animations) animation.cancel();
        restore();
        return;
      }
      wasReady = true;
      if (fontsReady && !started && !heading.dataset.templateLineReady)
        prepare();
      if (
        target.dataset.templateRevealState !== "visible" ||
        started ||
        !heading.dataset.templateLineReady
      )
        return;
      started = true;
      resize?.disconnect();
      try {
        for (const [index, fragment] of Array.from(
          heading.querySelectorAll<HTMLElement>(
            "[data-template-line-fragment]",
          ),
        ).entries()) {
          animations.push(
            fragment.animate(
              [
                { transform: "translateY(115%)" },
                { transform: "translateY(0)" },
              ],
              {
                duration: 1200,
                delay: index * 180,
                easing: "cubic-bezier(0.33,0.05,0.2,1)",
                fill: "both",
              },
            ),
          );
        }
        void Promise.all(animations.map((animation) => animation.finished))
          .then(restore)
          .catch(() => restore());
      } catch {
        for (const animation of animations) animation.cancel();
        restore();
      }
    };
    const stateObserver = new MutationObserver(observerCallback);
    stateObserver.observe(target, {
      attributes: true,
      attributeFilter: [
        "data-template-reveal-state",
        "data-template-motion-ready",
      ],
    });
    void (document.fonts?.ready ?? Promise.resolve())
      .then(() => {
        if (disposed) return;
        fontsReady = true;
        prepare();
        if (typeof ResizeObserver !== "undefined") {
          resize = new ResizeObserver(prepare);
          resize.observe(heading);
        }
      })
      .catch(() => restore());
    cleanups.push(() => {
      disposed = true;
      stateObserver.disconnect();
      resize?.disconnect();
      for (const animation of animations) animation.cancel();
      restore();
    });
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
