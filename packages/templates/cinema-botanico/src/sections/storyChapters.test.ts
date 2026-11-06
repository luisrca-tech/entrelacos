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
