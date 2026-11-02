import type { Media, StoryContent } from "../content";

export const STORY_MEDIA_HOLD_MS = 5000;
export const STORY_MEDIA_CROSSFADE_MS = 1800;
const CURTAIN_FALLBACK_MS = 1600;

export type StoryMediaClock = {
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
};

type StoryFrame = {
  dataset: {
    storyActive?: string;
    storyOutgoing?: string;
  };
};

export function storyBackgroundFrames(
  content: Pick<StoryContent, "media" | "sequence">,
): Media[] {
  if (content.media.kind !== "image" || content.sequence === undefined)
    return [content.media];
  return [content.media, ...content.sequence];
}

export function setupStoryMediaCycle(
  story: HTMLElement,
  options: {
    reducedMotion: boolean;
    Observer?: typeof IntersectionObserver;
    clock?: StoryMediaClock;
  },
): () => void {
  const frames = Array.from(
    story.querySelectorAll<HTMLElement>("[data-story-frame]"),
  ) as StoryFrame[];
  if (options.reducedMotion || frames.length < 2) return () => undefined;

  const clock = options.clock ?? globalThis;
  const Observer = options.Observer;
  const curtain = story.querySelector<HTMLElement>(
    '[data-template-reveal="curtain"]',
  );
  const media = curtain?.querySelector<HTMLElement>(
    "[data-template-reveal-media]",
  );
  let timer: number | undefined;
  let outgoingTimer: number | undefined;
  let revealTimer: number | undefined;
  let startupTimer: number | undefined;
  let current = frames.findIndex(
    (frame) => frame.dataset.storyActive === "true",
  );
  if (current < 0) current = 0;
  let visible = !Observer || !curtain || !media;
  let revealed = !Observer || !curtain || !media;
  let advanced = false;
  let opening = false;
  let disposed = false;

  const clear = () => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  const queue = () => {
    if (disposed || !visible || !revealed || timer !== undefined) return;
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        const previous = current;
        current = (current + 1) % frames.length;
        frames.forEach((frame, index) => {
          if (index === previous) frame.dataset.storyOutgoing = "true";
          else delete frame.dataset.storyOutgoing;
          if (index === current) frame.dataset.storyActive = "true";
          else delete frame.dataset.storyActive;
        });
        outgoingTimer = clock.setTimeout(() => {
          delete frames[previous]?.dataset.storyOutgoing;
          outgoingTimer = undefined;
        }, STORY_MEDIA_CROSSFADE_MS);
        advanced = true;
        queue();
      },
      STORY_MEDIA_HOLD_MS + (advanced ? STORY_MEDIA_CROSSFADE_MS : 0),
    );
  };
  const completeReveal = () => {
    if (disposed || revealed) return;
    revealed = true;
    if (revealTimer !== undefined) clock.clearTimeout(revealTimer);
    revealTimer = undefined;
    queue();
  };
  const syncReveal = () => {
    if (disposed || !curtain) return;
    if (
      !advanced &&
      curtain.dataset.templateMotionReady === "true" &&
      curtain.dataset.templateRevealState === "hidden"
    ) {
      revealed = false;
      clear();
      return;
    }
    if (revealed) return;
    if (curtain.dataset.templateMotionReady !== "true") {
      completeReveal();
      return;
    }
    if (curtain.dataset.templateRevealState !== "visible" || opening) return;
    opening = true;
    revealTimer = clock.setTimeout(completeReveal, CURTAIN_FALLBACK_MS);
  };
  const onTransitionEnd = (event: Event) => {
    if (
      event.target !== media ||
      (event as TransitionEvent).propertyName !== "clip-path"
    )
      return;
    if (curtain?.dataset.templateRevealState === "visible") completeReveal();
  };

  let observer: IntersectionObserver | undefined;
  let stateObserver: MutationObserver | undefined;
  if (Observer && curtain && media) {
    try {
      observer = new Observer((entries) => {
        entries.forEach((entry) => {
          if (entry.target !== curtain) return;
          visible = entry.isIntersecting;
          if (visible) queue();
          else clear();
        });
      });
      observer.observe(curtain);
      media.addEventListener("transitionend", onTransitionEnd);
      const Mutation = story.ownerDocument.defaultView?.MutationObserver;
      if (Mutation) {
        stateObserver = new Mutation(syncReveal);
        stateObserver.observe(curtain, {
          attributes: true,
          attributeFilter: [
            "data-template-motion-ready",
            "data-template-reveal-state",
          ],
        });
      }
      // The shared observer may initialize later in this same document task.
      startupTimer = clock.setTimeout(syncReveal, 0);
    } catch {
      observer?.disconnect();
      stateObserver?.disconnect();
      media.removeEventListener("transitionend", onTransitionEnd);
      visible = true;
      revealed = true;
      queue();
    }
  } else {
    queue();
  }

  return () => {
    disposed = true;
    clear();
    if (outgoingTimer !== undefined) clock.clearTimeout(outgoingTimer);
    frames.forEach((frame) => {
      delete frame.dataset.storyOutgoing;
    });
    if (startupTimer !== undefined) clock.clearTimeout(startupTimer);
    if (revealTimer !== undefined) clock.clearTimeout(revealTimer);
    observer?.disconnect();
    stateObserver?.disconnect();
    media?.removeEventListener("transitionend", onTransitionEnd);
  };
}
