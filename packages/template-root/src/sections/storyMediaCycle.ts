import type { Media, StoryContent } from "../content";

export const STORY_MEDIA_HOLD_MS = 2600;

export type StoryMediaClock = {
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
};

type StoryFrame = {
  dataset: {
    storyActive?: string;
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
  let timer: number | undefined;
  let current = frames.findIndex(
    (frame) => frame.dataset.storyActive === "true",
  );
  if (current < 0) current = 0;

  const clear = () => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  const show = (index: number) => {
    frames.forEach((frame, frameIndex) => {
      if (frameIndex === index) frame.dataset.storyActive = "true";
      else delete frame.dataset.storyActive;
    });
    current = index;
  };
  const queue = () => {
    clear();
    timer = clock.setTimeout(() => {
      show((current + 1) % frames.length);
      queue();
    }, STORY_MEDIA_HOLD_MS);
  };
  const stop = () => {
    clear();
  };
  const start = () => {
    if (timer !== undefined) return;
    queue();
  };

  if (!Observer) {
    start();
    return () => {
      stop();
    };
  }

  let observer: IntersectionObserver;
  try {
    observer = new Observer((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) start();
        else stop();
      });
    });
    observer.observe(story);
  } catch {
    return () => undefined;
  }

  return () => {
    stop();
    observer.disconnect();
  };
}
