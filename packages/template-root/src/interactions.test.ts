import { describe, expect, it } from "vitest";
import {
  LENIS_OPTIONS,
  navigationStateForHero,
  type SmoothScrollConstructor,
  setupMobileNavigation,
  setupSmoothScroll,
} from "./interactions";

type Listener = (event: {
  key?: string;
  target?: unknown;
  preventDefault?: () => void;
}) => void;

function createMediaQuery(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    matches,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
    emit(next: boolean) {
      this.matches = next;
      listeners.forEach((listener) => {
        listener({ matches: next } as MediaQueryListEvent);
      });
    },
  };
}

describe("template smooth-scroll lifecycle", () => {
  it("creates Lenis with the approved options and recreates it across motion changes", () => {
    const media = createMediaQuery(false);
    const instances: Array<{ options: unknown; destroyed: boolean }> = [];
    class FakeLenis {
      options: unknown;
      destroyed = false;

      constructor(options: unknown) {
        this.options = options;
        instances.push(this);
      }

      destroy() {
        this.destroyed = true;
      }
    }

    const cleanup = setupSmoothScroll(
      { matchMedia: () => media } as unknown as Pick<Window, "matchMedia">,
      FakeLenis as unknown as SmoothScrollConstructor,
    );

    expect(instances).toHaveLength(1);
    expect(instances[0]?.options).toEqual(LENIS_OPTIONS);

    media.emit(true);
    expect(instances[0]?.destroyed).toBe(true);
    expect(instances).toHaveLength(1);

    media.emit(false);
    expect(instances).toHaveLength(2);
    cleanup();
    expect(instances[1]?.destroyed).toBe(true);
  });

  it("does not instantiate while reduced motion is active, then starts after it is disabled", () => {
    const media = createMediaQuery(true);
    let created = 0;
    class FakeLenis {
      constructor() {
        created += 1;
      }

      destroy() {}
    }

    const cleanup = setupSmoothScroll(
      { matchMedia: () => media } as unknown as Pick<Window, "matchMedia">,
      FakeLenis as unknown as SmoothScrollConstructor,
    );

    expect(created).toBe(0);
    media.emit(false);
    expect(created).toBe(1);
    cleanup();
  });
});

describe("mobile navigation focus", () => {
  it("closes on Escape and restores focus after the anchor default action", () => {
    const listeners = new Map<string, Listener>();
    const summary = {
      focusCalls: 0,
      focus() {
        this.focusCalls += 1;
      },
    };
    const details = {
      open: true,
      querySelector: () => summary,
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, listener),
      removeEventListener: () => undefined,
    };
    const root = {
      querySelectorAll: () => [details],
    } as unknown as ParentNode;

    const scheduled: Array<() => void> = [];
    const cleanup = setupMobileNavigation(root, (callback) => {
      scheduled.push(callback);
    });
    listeners.get("keydown")?.({
      key: "Escape",
      preventDefault() {},
    });
    expect(details.open).toBe(false);
    expect(summary.focusCalls).toBe(1);

    details.open = true;
    listeners.get("click")?.({ target: { closest: () => ({}) } });
    expect(details.open).toBe(false);
    expect(summary.focusCalls).toBe(1);
    scheduled.shift()?.();
    expect(summary.focusCalls).toBe(2);
    cleanup();
  });
});

describe("hero navigation state", () => {
  it("uses the transparent state only while the header overlaps the hero", () => {
    expect(navigationStateForHero({ top: 900, bottom: 1700 }, 80)).toBe(
      "solid",
    );
    expect(navigationStateForHero({ top: 0, bottom: 900 }, 80)).toBe("hero");
    expect(navigationStateForHero({ top: -900, bottom: 40 }, 80)).toBe("solid");
  });
});
