export type StoryScrollDirection = -1 | 0 | 1;

type StoryTransitionControllerOptions = {
  initialIndex: number;
  duration: number;
  onTransition: (from: number, to: number) => void;
  onSettled: () => void;
};

export function createStoryTransitionController({
  initialIndex,
  duration,
  onTransition,
  onSettled,
}: StoryTransitionControllerOptions) {
  let activeIndex = initialIndex;
  let transitionTimer: ReturnType<typeof setTimeout> | undefined;

  function settle() {
    transitionTimer = undefined;
    onSettled();
  }

  function start(nextIndex: number) {
    if (transitionTimer !== undefined) {
      globalThis.clearTimeout(transitionTimer);
    }
    const previousIndex = activeIndex;
    activeIndex = nextIndex;
    onTransition(previousIndex, nextIndex);
    transitionTimer = globalThis.setTimeout(settle, duration);
  }

  return {
    request(nextIndex: number) {
      if (nextIndex === activeIndex) return;
      start(nextIndex);
    },
  };
}

export function resolveStoryEntryIndex(
  entryTops: readonly number[],
  currentIndex: number,
  direction: StoryScrollDirection,
  viewportHeight: number,
): number {
  if (entryTops.length === 0) return currentIndex;
  let nextIndex = Math.min(Math.max(currentIndex, 0), entryTops.length - 1);

  if (direction < 0) {
    const reverseLine = viewportHeight * 0.58;
    while (nextIndex > 0 && entryTops[nextIndex] > reverseLine) nextIndex -= 1;
    return nextIndex;
  }

  const forwardLine = viewportHeight * 0.42;
  for (let index = nextIndex + 1; index < entryTops.length; index += 1) {
    if (entryTops[index] > forwardLine) break;
    nextIndex = index;
  }
  return nextIndex;
}
