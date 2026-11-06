// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LoadMoreButton } from "./LoadMoreButton";

it("coalesces a visible sentinel and a manual click and keeps manual retry available", async () => {
  let intersect: (() => void) | undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  let finish: (() => void) | undefined;
  const load = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(LoadMoreButton, { cursor: "next", onLoad: load }),
      ),
    );
    await act(async () => {
      intersect?.();
      node.querySelector("button")?.click();
      intersect?.();
    });
    expect(load).toHaveBeenCalledExactlyOnceWith("next");
    await act(async () => {
      finish?.();
    });
    await act(async () =>
      root.render(
        createElement(LoadMoreButton, {
          cursor: "next",
          onLoad: load,
          manualOnly: true,
        }),
      ),
    );
    await act(async () => node.querySelector("button")?.click());
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
  }
});
