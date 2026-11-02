// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Media } from "../content";
import { setupStoryMediaCycle, storyBackgroundFrames } from "./storyMediaCycle";

const still: Media = {
  kind: "image",
  src: "/one.jpg",
  alt: "One",
  width: 1200,
  height: 800,
};

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
    isObserving: (target: Element) => observed.has(target),
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

function createStory() {
  const story = document.createElement("section");
  story.innerHTML =
    '<div data-template-reveal="curtain" data-template-motion-ready="true" data-template-reveal-state="hidden"><figure data-template-reveal-media><img data-story-frame data-story-active="true"><img data-story-frame></figure></div>';
  document.body.append(story);
  const curtain = story.querySelector<HTMLElement>(
    '[data-template-reveal="curtain"]',
  );
  const media = story.querySelector<HTMLElement>(
    "[data-template-reveal-media]",
  );
  const frames = [...story.querySelectorAll<HTMLElement>("[data-story-frame]")];
  if (!curtain || !media) throw new Error("Missing story media");
  return { story, curtain, media, frames };
}

describe("story media cycle", () => {
  it("waits for the curtain end before a five-second first hold, then allows 1.8 seconds for each crossfade", async () => {
    const clock = createClock();
    const observer = createObserver();
    const { story, curtain, media, frames } = createStory();
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    expect(observer.isObserving(curtain)).toBe(true);
    expect(observer.isObserving(story)).toBe(false);
    observer.emit(curtain, true);
    clock.advance(10000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    curtain.dataset.templateRevealState = "visible";
    await Promise.resolve();
    clock.advance(1000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    const transition = new Event("transitionend", { bubbles: true });
    Object.defineProperty(transition, "propertyName", { value: "clip-path" });
    media.dispatchEvent(transition);
    clock.advance(4999);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    clock.advance(1);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    expect(frames[0]?.dataset.storyOutgoing).toBe("true");
    clock.advance(1800);
    expect(frames[0]?.dataset.storyOutgoing).toBeUndefined();
    clock.advance(4999);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    clock.advance(1);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    cleanup();
    expect(frames[1]?.dataset.storyOutgoing).toBeUndefined();
    expect(observer.isObserving(curtain)).toBe(false);
    story.remove();
  });

  it("cancels the initial dwell if shared motion initializes after the cycle", async () => {
    const clock = createClock();
    const observer = createObserver();
    const { story, curtain, media, frames } = createStory();
    delete curtain.dataset.templateMotionReady;
    delete curtain.dataset.templateRevealState;
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    observer.emit(curtain, true);
    clock.advance(0);
    clock.advance(3000);
    curtain.dataset.templateMotionReady = "true";
    curtain.dataset.templateRevealState = "hidden";
    await Promise.resolve();
    clock.advance(5000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    curtain.dataset.templateRevealState = "visible";
    await Promise.resolve();
    const transition = new Event("transitionend");
    Object.defineProperty(transition, "propertyName", { value: "clip-path" });
    media.dispatchEvent(transition);
    clock.advance(4999);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    clock.advance(1);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    cleanup();
    story.remove();
  });

  it("uses a bounded curtain fallback and pauses when the media itself is offscreen", async () => {
    const clock = createClock();
    const observer = createObserver();
    const { story, curtain, frames } = createStory();
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    observer.emit(curtain, true);
    curtain.dataset.templateRevealState = "visible";
    await Promise.resolve();
    clock.advance(1599);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    clock.advance(1);
    observer.emit(curtain, false);
    clock.advance(20000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    observer.emit(curtain, true);
    clock.advance(5000);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    cleanup();
    clock.advance(20000);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    story.remove();
  });

  it("cycles without a curtain wrapper when an observer is provided", () => {
    const clock = createClock();
    const observer = createObserver();
    const story = document.createElement("section");
    story.innerHTML =
      '<img data-story-frame data-story-active="true"><img data-story-frame>';
    const frames = story.querySelectorAll<HTMLElement>("[data-story-frame]");
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    clock.advance(5000);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    cleanup();
  });

  it("removes the curtain listener when observer setup fails", () => {
    const clock = createClock();
    const observer = createObserver();
    const { story, media, frames } = createStory();
    const remove = vi.spyOn(media, "removeEventListener");
    const mutation = vi
      .spyOn(window, "MutationObserver")
      .mockImplementation(() => {
        throw new Error("unavailable");
      });
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      Observer: observer.Observer,
      clock,
    });
    expect(remove).toHaveBeenCalledWith("transitionend", expect.any(Function));
    clock.advance(5000);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    cleanup();
    mutation.mockRestore();
    story.remove();
  });

  it("retains reduced motion, single-frame and unavailable observer fallbacks", () => {
    const clock = createClock();
    const { story, curtain, frames } = createStory();
    setupStoryMediaCycle(story, { reducedMotion: true, clock });
    clock.advance(20000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    frames[1]?.remove();
    setupStoryMediaCycle(story, { reducedMotion: false, clock });
    clock.advance(20000);
    expect(frames[0]?.dataset.storyActive).toBe("true");
    mediaAppend(curtain, frames[1]);
    const cleanup = setupStoryMediaCycle(story, {
      reducedMotion: false,
      clock,
    });
    clock.advance(5000);
    expect(frames[1]?.dataset.storyActive).toBe("true");
    cleanup();
    story.remove();
  });
});

function mediaAppend(curtain: HTMLElement, frame: HTMLElement | undefined) {
  if (frame)
    curtain.querySelector("[data-template-reveal-media]")?.append(frame);
}
