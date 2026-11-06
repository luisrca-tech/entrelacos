// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStoryChapters, setupStoryChapters } from "./storyChapters";

describe("host-authored story chapters", () => {
  it("preserves omitted descriptions in replacement copy and uses neutral numbered fallbacks", () => {
    const media = {
      kind: "image" as const,
      src: "/one.jpg",
      alt: "One",
      width: 1200,
      height: 800,
    };
    const chapters = buildStoryChapters({
      id: "story",
      title: "Our story",
      body: "First",
      description: "First description",
      media,
      sequence: [
        { ...media, copy: { body: "Second" } },
        { ...media, chapterLabel: "Our home" },
      ],
    });
    expect(chapters.map((chapter) => chapter.description)).toEqual([
      "First description",
      undefined,
      "First description",
    ]);
    expect(chapters.map((chapter) => chapter.label)).toEqual([
      "01",
      "02",
      "Our home",
    ]);
    expect(chapters.map((chapter) => chapter.body)).toEqual([
      "First",
      "Second",
      "First",
    ]);
  });
});

function fixture(count = 3) {
  const story = document.createElement("section");
  story.innerHTML = `<div data-story-tabs hidden>${Array.from({ length: count }, (_, i) => `<button data-story-chapter aria-pressed="${i === 0}" aria-controls="story-copy-${i}">Chapter ${i + 1}</button>`).join("")}</div>${Array.from({ length: count }, (_, i) => `<img data-story-frame ${i === 0 ? 'data-story-active="true"' : ""}><div id="story-copy-${i}" data-story-copy-frame>Story ${i + 1}</div>`).join("")}`;
  document.body.append(story);
  return {
    story,
    buttons: [...story.querySelectorAll<HTMLButtonElement>("button")],
    images: [...story.querySelectorAll<HTMLElement>("img")],
    panels: [...story.querySelectorAll<HTMLElement>("[data-story-copy-frame]")],
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("manual story chapters", () => {
  it("changes the matching photo and copy only on selection, even with reduced motion", () => {
    vi.useFakeTimers();
    const { story, buttons, images, panels } = fixture();
    const cleanup = setupStoryChapters(story);
    expect(story.querySelector<HTMLElement>("[data-story-tabs]")?.hidden).toBe(
      false,
    );
    vi.advanceTimersByTime(60000);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    buttons[2].click();
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(images.map((i) => i.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
      "false",
    ]);
    expect(panels.map((p) => p.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
      "false",
    ]);
    expect(panels[0].inert).toBe(true);
    expect(panels[2].inert).toBe(false);
    buttons[0].click();
    expect(images[0].dataset.storyActive).toBe("true");
    expect(images[2].dataset.storyActive).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it("restores readable content and removes handlers on cleanup", () => {
    const { story, buttons, panels } = fixture();
    const cleanup = setupStoryChapters(story);
    buttons[1].click();
    cleanup();
    expect(story.dataset.storyReady).toBeUndefined();
    expect(story.querySelector<HTMLElement>("[data-story-tabs]")?.hidden).toBe(
      true,
    );
    expect(
      panels.every((p) => !p.inert && !p.hasAttribute("aria-hidden")),
    ).toBe(true);
    buttons[2].click();
    expect(buttons[2].getAttribute("aria-pressed")).toBe("false");
  });

  it("leaves a single photo or video story readable without chapter controls", () => {
    const { story } = fixture(1);
    setupStoryChapters(story);
    expect(story.dataset.storyReady).toBeUndefined();
    expect(story.querySelector<HTMLElement>("[data-story-tabs]")?.hidden).toBe(
      true,
    );
  });

  it("does not hide content when chapter markup is incomplete", () => {
    const { story, panels } = fixture();
    panels[2].remove();
    setupStoryChapters(story);
    expect(story.dataset.storyReady).toBeUndefined();
    expect(panels[0].hasAttribute("aria-hidden")).toBe(false);
  });
});

function autoplayFixture() {
  vi.useFakeTimers();
  const values = fixture();
  values.story.dataset.storyTimed = "true";
  const reading = document.createElement("div");
  reading.dataset.storyReading = "";
  values.story.append(reading);
  let observe: IntersectionObserverCallback = () => undefined;
  const disconnect = vi.fn();
  const Observer = class {
    constructor(callback: IntersectionObserverCallback) {
      observe = callback;
    }
    observe() {}
    disconnect = disconnect;
  } as unknown as typeof IntersectionObserver;
  const motion = new EventTarget() as MediaQueryList;
  Object.defineProperty(motion, "matches", { value: false, writable: true });
  const cleanup = setupStoryChapters(values.story, { Observer, motion });
  return {
    ...values,
    reading,
    cleanup,
    disconnect,
    motion,
    visible: (visible: boolean) =>
      observe(
        [
          {
            target: values.story.querySelector("[data-story-tabs]"),
            isIntersecting: visible,
            intersectionRatio: visible ? 1 : 0,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    progress: () =>
      Number(values.story.style.getPropertyValue("--story-progress")),
  };
}

describe("story chapter playback", () => {
  it("fills progress over eight visible seconds, advances and wraps", () => {
    const value = autoplayFixture();
    vi.advanceTimersByTime(16000);
    expect(value.buttons[0].getAttribute("aria-pressed")).toBe("true");
    value.visible(true);
    vi.advanceTimersByTime(4000);
    expect(value.progress()).toBeCloseTo(0.5, 2);
    vi.advanceTimersByTime(4016);
    expect(value.buttons[1].getAttribute("aria-pressed")).toBe("true");
    vi.advanceTimersByTime(16000);
    expect(value.buttons[0].getAttribute("aria-pressed")).toBe("true");
    value.cleanup();
    expect(vi.getTimerCount()).toBe(0);
    expect(value.disconnect).toHaveBeenCalled();
  });

  it("preserves progress while paused or offscreen and resets after manual selection", () => {
    const value = autoplayFixture();
    value.visible(true);
    vi.advanceTimersByTime(3000);
    value.reading.dispatchEvent(new Event("pointerenter"));
    const paused = value.progress();
    vi.advanceTimersByTime(20000);
    expect(value.progress()).toBe(paused);
    value.reading.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1000);
    expect(value.progress()).toBeCloseTo(0.5, 2);
    value.visible(false);
    const offscreen = value.progress();
    vi.advanceTimersByTime(20000);
    expect(value.progress()).toBe(offscreen);
    value.buttons[2].click();
    expect(value.progress()).toBe(0);
    value.visible(true);
    vi.advanceTimersByTime(8016);
    expect(value.buttons[0].getAttribute("aria-pressed")).toBe("true");
    value.cleanup();
  });

  it("stops during keyboard focus and resumes after focus leaves the controls", () => {
    const value = autoplayFixture();
    value.visible(true);
    vi.spyOn(value.buttons[0], "matches").mockReturnValue(true);
    value.buttons[0].focus();
    vi.advanceTimersByTime(20000);
    expect(value.buttons[0].getAttribute("aria-pressed")).toBe("true");
    value.buttons[0].blur();
    vi.advanceTimersByTime(8016);
    expect(value.buttons[1].getAttribute("aria-pressed")).toBe("true");
    value.cleanup();
  });

  it("pauses in a hidden tab and disables automatic motion when requested", () => {
    const value = autoplayFixture();
    value.visible(true);
    vi.advanceTimersByTime(1000);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    const progress = value.progress();
    vi.advanceTimersByTime(20000);
    expect(value.progress()).toBe(progress);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    Object.assign(value.motion, { matches: true });
    value.motion.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(20000);
    expect(value.buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(value.story.dataset.storyAutoplay).toBe("false");
    value.buttons[1].click();
    expect(value.buttons[1].getAttribute("aria-pressed")).toBe("true");
    value.cleanup();
    hidden.mockRestore();
  });
});
