import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoryTransitionController,
  resolveStoryEntryIndex,
} from "./storyMotion";

afterEach(() => {
  vi.useRealTimers();
});

describe("story motion", () => {
  it("keeps the latest requested image queued until the current transition settles", () => {
    vi.useFakeTimers();
    const transitions: Array<[number, number]> = [];
    let settlements = 0;
    const controller = createStoryTransitionController({
      initialIndex: 0,
      duration: 1100,
      onTransition: (from, to) => transitions.push([from, to]),
      onSettled: () => {
        settlements += 1;
      },
    });

    controller.request(1);
    controller.request(2);
    controller.request(3);

    expect(transitions).toEqual([[0, 1]]);
    vi.advanceTimersByTime(1099);
    expect(transitions).toEqual([[0, 1]]);
    vi.advanceTimersByTime(1);
    expect(transitions).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(settlements).toBe(1);
  });

  it("cancels a queued change when scroll settles back on the active entry", () => {
    vi.useFakeTimers();
    const transitions: Array<[number, number]> = [];
    const controller = createStoryTransitionController({
      initialIndex: 0,
      duration: 1100,
      onTransition: (from, to) => transitions.push([from, to]),
      onSettled: () => undefined,
    });

    controller.request(1);
    controller.request(2);
    controller.request(1);
    vi.advanceTimersByTime(1100);

    expect(transitions).toEqual([[0, 1]]);
  });

  it("uses separate forward and reverse thresholds to prevent boundary oscillation", () => {
    const viewportHeight = 1000;

    expect(resolveStoryEntryIndex([-300, 410, 980], 0, 1, viewportHeight)).toBe(
      1,
    );
    expect(
      resolveStoryEntryIndex([-290, 500, 990], 1, -1, viewportHeight),
    ).toBe(1);
    expect(
      resolveStoryEntryIndex([-200, 590, 1080], 1, -1, viewportHeight),
    ).toBe(0);
  });
});
