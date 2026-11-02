// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  navigationStateForHero,
  setupMobileNavigation,
  setupTemplateMotion,
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

  it("closes when a pointer lands outside the open menu", () => {
    const rootListeners = new Map<string, Listener>();
    const menuListeners = new Map<string, Listener>();
    const summary = {
      focusCalls: 0,
      focus() {
        this.focusCalls += 1;
      },
    };
    const details = {
      open: true,
      contains: (node: unknown) => node === "inside",
      querySelector: () => summary,
      addEventListener: (type: string, listener: Listener) =>
        menuListeners.set(type, listener),
      removeEventListener: () => undefined,
    };
    const root = {
      querySelectorAll: () => [details],
      addEventListener: (type: string, listener: Listener) =>
        rootListeners.set(type, listener),
      removeEventListener: () => undefined,
    } as unknown as ParentNode;

    const cleanup = setupMobileNavigation(root);
    rootListeners.get("pointerdown")?.({ target: "outside" });
    expect(details.open).toBe(false);
    expect(summary.focusCalls).toBe(0);

    details.open = true;
    rootListeners.get("pointerdown")?.({ target: "inside" });
    expect(details.open).toBe(true);
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

describe("template reveal lifecycle", () => {
  function setup(
    options: {
      reduced?: boolean;
      failObserve?: boolean;
      noObserver?: boolean;
    } = {},
  ) {
    const media = createMediaQuery(options.reduced ?? false);
    const elements = [0, 1].map(() => {
      const element = document.createElement("div");
      element.setAttribute("data-template-reveal", "");
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
        top: 1200,
        bottom: 1500,
        height: 300,
        width: 300,
      } as DOMRect);
      return element;
    });
    let notify: IntersectionObserverCallback = () => undefined;
    let observerOptions: IntersectionObserverInit | undefined;
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    class FakeObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        notify = callback;
        observerOptions = options;
      }
      observe = vi.fn(() => {
        if (options.failObserve) throw new Error("Observer unavailable");
      });
      disconnect = disconnect;
      unobserve = unobserve;
    }
    const cleanup = setupTemplateMotion(
      { querySelectorAll: () => elements } as unknown as ParentNode,
      {
        matchMedia: () => media,
        innerHeight: 1000,
        IntersectionObserver: options.noObserver ? undefined : FakeObserver,
      } as unknown as Window,
    );
    return {
      elements,
      media,
      cleanup,
      disconnect,
      unobserve,
      getOptions: () => observerOptions,
      reveal: (
        index: number,
        isIntersecting = true,
        intersectionRatio = 0.15,
      ) =>
        notify(
          [
            { target: elements[index], isIntersecting, intersectionRatio },
          ] as unknown as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
    };
  }

  it("requires fifteen percent visibility inside the viewport inset and reveals once", () => {
    const state = setup();
    expect(state.getOptions()).toEqual({
      threshold: [0, 0.15],
      rootMargin: "0px 0px -280px 0px",
    });
    expect(state.elements[0]?.dataset).toMatchObject({
      templateMotionReady: "true",
      templateRevealState: "hidden",
    });
    state.reveal(0, false);
    expect(state.unobserve).not.toHaveBeenCalled();
    state.reveal(0, true, 0.01);
    expect(state.unobserve).not.toHaveBeenCalled();
    state.reveal(0);
    expect(state.elements[0]?.dataset).toMatchObject({
      templateRevealState: "visible",
    });
    expect(state.unobserve).toHaveBeenCalledWith(state.elements[0]);
    state.cleanup();
    expect(state.disconnect).toHaveBeenCalled();
    expect({ ...state.elements[0]?.dataset }).toEqual({ templateReveal: "" });
  });

  it("reveals pending content immediately when reduced motion becomes active", () => {
    const state = setup();
    state.media.emit(true);
    expect(
      state.elements.every(
        (element) =>
          (element.dataset as DOMStringMap).templateRevealState === "visible",
      ),
    ).toBe(true);
    expect(state.disconnect).toHaveBeenCalled();
    state.media.emit(false);
    expect(
      state.elements.every(
        (element) =>
          (element.dataset as DOMStringMap).templateRevealState === "visible",
      ),
    ).toBe(true);
    state.cleanup();
    state.media.emit(false);
    expect({ ...state.elements[0]?.dataset }).toEqual({ templateReveal: "" });
  });

  it("never hides content when reduced motion starts active or the observer is absent", () => {
    for (const options of [{ reduced: true }, { noObserver: true }]) {
      const state = setup(options);
      expect({ ...state.elements[0]?.dataset }).toEqual({ templateReveal: "" });
      state.media.emit(false);
      expect({ ...state.elements[0]?.dataset }).toEqual({ templateReveal: "" });
      state.cleanup();
    }
  });

  it("disconnects a partially initialized observer and restores visible content after failure", () => {
    const state = setup({ failObserve: true });
    expect({ ...state.elements[0]?.dataset }).toEqual({ templateReveal: "" });
    expect(state.disconnect).toHaveBeenCalled();
    state.cleanup();
  });
});

describe("template reveal DOM safety", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  function fixture({ height = 300, top = 1400 } = {}) {
    vi.stubGlobal("innerHeight", 1000);
    const media = createMediaQuery(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(
      media as unknown as MediaQueryList,
    );
    let failObservation = false;
    const observers: Array<{
      callback: IntersectionObserverCallback;
      options: IntersectionObserverInit;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    let resized: ResizeObserverCallback = () => {};
    class FakeObserver {
      disconnect = vi.fn();
      observe = vi.fn(() => {
        if (failObservation)
          throw new Error("Observer failed during hydration");
      });
      unobserve = vi.fn();
      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit,
      ) {
        observers.push({ callback, options, disconnect: this.disconnect });
      }
    }
    class FakeResize {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.stubGlobal("ResizeObserver", FakeResize);
    const root = document.createElement("main");
    document.body.append(root);
    const make = (parent: HTMLElement, dimensions = { height, top }) => {
      const element = document.createElement("div");
      element.setAttribute("data-template-reveal", "");
      element.innerHTML = "<button data-template-reveal-item>Action</button>";
      vi.spyOn(element, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            height: dimensions.height,
            width: 300,
            top: dimensions.top,
            bottom: dimensions.top + dimensions.height,
          }) as DOMRect,
      );
      parent.append(element);
      return element;
    };
    const element = make(root);
    const cleanup = setupTemplateMotion(root, window);
    return {
      element,
      root,
      make,
      cleanup,
      observers,
      media,
      fail: () => {
        failObservation = true;
      },
      resize: () => resized([], {} as ResizeObserver),
      intersect: (target: HTMLElement, intersectionRatio: number) =>
        observers
          .at(-1)
          ?.callback(
            [
              { target, isIntersecting: true, intersectionRatio },
            ] as unknown as IntersectionObserverEntry[],
            {} as IntersectionObserver,
          ),
    };
  }
  it("caps tall-wrapper visibility at a reachable portion of the viewport", () => {
    const f = fixture({ height: 20000 });
    expect(f.observers.at(-1)?.options).toEqual({
      threshold: [0, 0.018, 0.15],
      rootMargin: "0px 0px -280px 0px",
    });
    f.intersect(f.element, 0.017);
    expect(f.element.dataset.templateRevealState).toBe("hidden");
    f.intersect(f.element, 0.018);
    expect(f.element.dataset.templateRevealState).toBe("visible");
    f.cleanup();
  });
  it("settles a block skipped by fast scrolling even away from the page end", () => {
    const f = fixture();
    vi.mocked(f.element.getBoundingClientRect).mockReturnValue({
      height: 300,
      width: 300,
      top: -500,
      bottom: -200,
    } as DOMRect);
    window.dispatchEvent(new Event("scroll"));
    expect(f.element.dataset.templateRevealState).toBe("visible");
    expect(f.element.dataset.templateMotionReady).toBeUndefined();
    f.cleanup();
  });
  it("reveals focused content immediately and restores content at the page end", () => {
    const f = fixture();
    f.element.querySelector("button")?.focus();
    expect(f.element.dataset.templateRevealState).toBe("visible");
    expect(f.element.dataset.templateMotionReady).toBeUndefined();
    const end = f.make(f.root, { height: 100, top: 950 });
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      2000,
    );
    vi.stubGlobal("scrollY", 1000);
    return Promise.resolve().then(() => {
      window.dispatchEvent(new Event("scroll"));
      expect(end.dataset.templateRevealState).toBe("visible");
      f.cleanup();
    });
  });
  it("finishes an entrance immediately when focus arrives after its trigger", () => {
    const f = fixture();
    f.intersect(f.element, 0.15);
    expect(f.element.dataset.templateMotionReady).toBe("true");
    f.element.querySelector("button")?.focus();
    expect(f.element.dataset.templateMotionReady).toBeUndefined();
    f.cleanup();
  });
  it("keeps zero-size content readable until layout provides an observable size", () => {
    const f = fixture({ height: 0 });
    expect(f.element.dataset.templateMotionReady).toBeUndefined();
    vi.mocked(f.element.getBoundingClientRect).mockReturnValue({
      height: 300,
      width: 300,
      top: 1400,
      bottom: 1700,
    } as DOMRect);
    f.resize();
    expect(f.element.dataset.templateRevealState).toBe("hidden");
    f.intersect(f.element, 0.15);
    expect(f.element.dataset.templateRevealState).toBe("visible");
    f.cleanup();
  });
  it("restores all content if observing a late card fails", async () => {
    const f = fixture();
    f.fail();
    const card = f.make(f.root);
    await Promise.resolve();
    expect(card.dataset.templateMotionReady).toBeUndefined();
    expect(f.element.dataset.templateMotionReady).toBeUndefined();
    f.cleanup();
  });
  it("registers late React cards once and never re-hides an already revealed moved card", async () => {
    const f = fixture();
    const card = f.make(f.root);
    await Promise.resolve();
    expect(card.dataset.templateRevealState).toBe("hidden");
    f.intersect(card, 0.15);
    expect(card.dataset.templateRevealState).toBe("visible");
    const container = document.createElement("div");
    f.root.append(container);
    container.append(card);
    await Promise.resolve();
    expect(card.dataset.templateRevealState).toBe("visible");
    f.media.emit(true);
    const reducedCard = f.make(f.root);
    await Promise.resolve();
    expect(reducedCard.dataset.templateMotionReady).toBeUndefined();
    f.cleanup();
    const later = f.make(f.root);
    await Promise.resolve();
    expect(later.dataset.templateMotionReady).toBeUndefined();
  });
});
