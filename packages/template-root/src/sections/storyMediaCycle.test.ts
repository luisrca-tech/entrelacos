import { describe, expect, it } from "vitest";
import type { Media } from "../content";
import {
  STORY_MEDIA_HOLD_MS,
  setupStoryMediaCycle,
  storyBackgroundFrames,
} from "./storyMediaCycle";

const still: Media = {
  kind: "image",
  src: "/one.jpg",
  alt: "One",
  width: 1200,
  height: 800,
};

function createFrame(active = false) {
  return {
    dataset: active ? { storyActive: "true" } : {},
  };
}

function createClock() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let now = 0;
  return {
    setTimeout(callback: () => void, delay: number) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay: now + delay });
      return id;
    },
    clearTimeout(id: number) {
      pending.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.delay > now) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

function createObserver() {
  let callback: IntersectionObserverCallback = () => undefined;
  const observed = new Set<Element>();
  const Observer = class {
    constructor(next: IntersectionObserverCallback) {
      callback = next;
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  } as unknown as typeof IntersectionObserver;

  return {
    Observer,
    emit(target: Element, isIntersecting: boolean) {
      callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
  };
}

describe("story background frames", () => {
  it("keeps a single primary still when no sequence is supplied", () => {
    expect(storyBackgroundFrames({ media: still })).toEqual([still]);
  });

  it("prepends the primary still to an image sequence", () => {
    const second: Media = { ...still, src: "/two.jpg", alt: "Two" };
    expect(storyBackgroundFrames({ media: still, sequence: [second] })).toEqual(
      [still, second],
    );
  });

  it("ignores a sequence when the primary media is video", () => {
    const video: Media = {
      kind: "video",
      src: "/story.mp4",
      poster: "/story.jpg",
      alt: "Film",
      width: 1200,
      height: 800,
    };
    expect(storyBackgroundFrames({ media: video, sequence: [still] })).toEqual([
      video,
    ]);
  });
});

describe("story media cycle", () => {
  it("does not schedule a cycle for a single frame or reduced motion", () => {
    const clock = createClock();
    const story = {
      querySelectorAll: () => [createFrame(true)],
    } as unknown as HTMLElement;

    setupStoryMediaCycle(story, {
      reducedMotion: false,
      clock,
    });
    clock.advance(STORY_MEDIA_HOLD_MS * 2);
    expect(story.querySelectorAll("").length).toBe(1);

    const frames = [createFrame(true), createFrame()];
    setupStoryMediaCycle(
      { querySelectorAll: () => frames } as unknown as HTMLElement,
      { reducedMotion: true, clock },
    );
    clock.advance(STORY_MEDIA_HOLD_MS);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    expect(frames[1]?.dataset.storyActive).toBeUndefined();
  });

  it("crossfades to the next still after the hold while the section is in view", () => {
    const clock = createClock();
    const observer = createObserver();
    const frames = [createFrame(true), createFrame(), createFrame()];
    const story = {
      querySelectorAll: () => frames,
    } as unknown as HTMLElement;

    setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    observer.emit(story, true);
    expect(frames[0]?.dataset.storyActive).toBe("true");

    clock.advance(STORY_MEDIA_HOLD_MS - 1);
    expect(frames[0]?.dataset.storyActive).toBe("true");

    clock.advance(1);
    expect(frames[0]?.dataset.storyActive).toBeUndefined();
    expect(frames[1]?.dataset.storyActive).toBe("true");

    clock.advance(STORY_MEDIA_HOLD_MS);
    expect(frames[1]?.dataset.storyActive).toBeUndefined();
    expect(frames[2]?.dataset.storyActive).toBe("true");

    clock.advance(STORY_MEDIA_HOLD_MS);
    expect(frames[2]?.dataset.storyActive).toBeUndefined();
    expect(frames[0]?.dataset.storyActive).toBe("true");
  });

  it("pauses while the section leaves the viewport and resumes from the current still", () => {
    const clock = createClock();
    const observer = createObserver();
    const frames = [createFrame(true), createFrame()];
    const story = {
      querySelectorAll: () => frames,
    } as unknown as HTMLElement;

    setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    observer.emit(story, true);
    clock.advance(STORY_MEDIA_HOLD_MS);
    expect(frames[1]?.dataset.storyActive).toBe("true");

    observer.emit(story, false);
    clock.advance(STORY_MEDIA_HOLD_MS * 2);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    expect(frames[0]?.dataset.storyActive).toBeUndefined();

    observer.emit(story, true);
    clock.advance(STORY_MEDIA_HOLD_MS);
    expect(frames[0]?.dataset.storyActive).toBe("true");
  });
});
