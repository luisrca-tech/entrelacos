import type { StoryContent } from "../content";

export function buildStoryChapters(content: StoryContent) {
  return [
    {
      media: content.media,
      label: content.chapterLabel ?? "01",
      description: content.description,
      body: content.body,
    },
    ...(content.sequence ?? []).map((frame, index) => ({
      media: frame,
      label: frame.chapterLabel ?? String(index + 2).padStart(2, "0"),
      description: frame.copy ? frame.copy.description : content.description,
      body: frame.copy?.body ?? content.body,
    })),
  ];
}

type PlaybackOptions = {
  Observer?: typeof IntersectionObserver;
  motion?: MediaQueryList;
};

const CHAPTER_DURATION_MS = 8000;

function setupPlayback(
  story: HTMLElement,
  controls: HTMLElement,
  advance: () => void,
  options: PlaybackOptions,
) {
  const reading = story.querySelector<HTMLElement>("[data-story-reading]");
  const view = story.ownerDocument.defaultView;
  story.dataset.storyAutoplay = "false";
  if (story.dataset.storyTimed !== "true" || !view)
    return {
      reset: () => {},
      cleanup: () => {
        delete story.dataset.storyAutoplay;
      },
    };
  const motion =
    options.motion ?? view.matchMedia?.("(prefers-reduced-motion: reduce)");
  const Observer = options.Observer ?? view.IntersectionObserver;
  let visible = !Observer;
  let focused = false;
  let hovered = false;
  let disposed = false;
  let elapsed = 0;
  let lastTick = 0;
  let frame: number | undefined;
  const paint = () =>
    story.style.setProperty(
      "--story-progress",
      String(Math.min(1, elapsed / CHAPTER_DURATION_MS)),
    );
  const stop = () => {
    if (frame === undefined) return;
    elapsed = Math.min(
      CHAPTER_DURATION_MS,
      elapsed + view.performance.now() - lastTick,
    );
    view.cancelAnimationFrame(frame);
    frame = undefined;
    paint();
  };
  const tick = (now: number) => {
    if (disposed) return;
    elapsed += now - lastTick;
    lastTick = now;
    if (elapsed >= CHAPTER_DURATION_MS) {
      elapsed = 0;
      advance();
    }
    paint();
    frame = view.requestAnimationFrame(tick);
  };
  const sync = () => {
    if (disposed) return;
    const automatic = !motion?.matches;
    story.dataset.storyAutoplay = String(automatic);
    if (
      !automatic ||
      focused ||
      hovered ||
      !visible ||
      story.ownerDocument.hidden
    ) {
      stop();
      return;
    }
    if (frame === undefined) {
      lastTick = view.performance.now();
      frame = view.requestAnimationFrame(tick);
    }
  };
  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = true;
    sync();
  };
  const onPointerLeave = () => {
    hovered = false;
    sync();
  };
  const onFocus = (event: FocusEvent) => {
    if (
      event.target instanceof view.HTMLElement &&
      event.target.matches(":focus-visible")
    ) {
      focused = true;
      sync();
    }
  };
  const onBlur = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof view.Node &&
      controls.contains(event.relatedTarget)
    )
      return;
    focused = false;
    sync();
  };
  controls.addEventListener("focusin", onFocus);
  controls.addEventListener("focusout", onBlur);
  reading?.addEventListener("pointerenter", onPointerEnter);
  reading?.addEventListener("pointerleave", onPointerLeave);
  story.ownerDocument.addEventListener("visibilitychange", sync);
  motion?.addEventListener?.("change", sync);
  let observer: IntersectionObserver | undefined;
  if (Observer) {
    observer = new Observer(
      (entries) => {
        const entry = entries.find((entry) => entry.target === controls);
        if (!entry) return;
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        sync();
      },
      { threshold: 0.5 },
    );
    observer.observe(controls);
  }
  paint();
  sync();
  return {
    reset: () => {
      elapsed = 0;
      lastTick = view.performance.now();
      paint();
    },
    cleanup: () => {
      disposed = true;
      stop();
      observer?.disconnect();
      controls.removeEventListener("focusin", onFocus);
      controls.removeEventListener("focusout", onBlur);
      reading?.removeEventListener("pointerenter", onPointerEnter);
      reading?.removeEventListener("pointerleave", onPointerLeave);
      story.ownerDocument.removeEventListener("visibilitychange", sync);
      motion?.removeEventListener?.("change", sync);
      story.style.removeProperty("--story-progress");
      delete story.dataset.storyAutoplay;
    },
  };
}

export function setupStoryChapters(
  story: HTMLElement,
  options: PlaybackOptions = {},
): () => void {
  const controls = story.querySelector<HTMLElement>("[data-story-tabs]");
  const buttons = [
    ...story.querySelectorAll<HTMLButtonElement>("[data-story-chapter]"),
  ];
  const images = [...story.querySelectorAll<HTMLElement>("[data-story-frame]")];
  const panels = [
    ...story.querySelectorAll<HTMLElement>("[data-story-copy-frame]"),
  ];
  if (
    !controls ||
    buttons.length < 2 ||
    images.length !== buttons.length ||
    panels.length !== buttons.length
  )
    return () => undefined;

  let current = 0;
  const select = (selected: number) => {
    current = selected;
    buttons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(index === selected));
    });
    [images, panels].forEach((frames) => {
      frames.forEach((frame, index) => {
        const active = index === selected;
        if (active) frame.dataset.storyActive = "true";
        else delete frame.dataset.storyActive;
        frame.setAttribute("aria-hidden", String(!active));
      });
    });
    panels.forEach((panel, index) => {
      panel.inert = index !== selected;
    });
  };
  const playback = setupPlayback(
    story,
    controls,
    () => select((current + 1) % buttons.length),
    options,
  );
  const handlers = buttons.map((button, index) => {
    const handler = () => {
      select(index);
      playback.reset();
    };
    button.addEventListener("click", handler);
    return handler;
  });
  select(0);
  story.dataset.storyReady = "true";
  controls.hidden = false;

  return () => {
    playback.cleanup();
    buttons.forEach((button, index) => {
      button.removeEventListener("click", handlers[index]);
    });
    select(0);
    delete story.dataset.storyReady;
    controls.hidden = true;
    panels.forEach((panel) => {
      panel.removeAttribute("aria-hidden");
      panel.inert = false;
    });
  };
}
