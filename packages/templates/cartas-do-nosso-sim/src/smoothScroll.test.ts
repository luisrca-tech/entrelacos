// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSmoothScroll } from "./smoothScroll";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

function setup(reduced = false, fail = false) {
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  const instances: Array<{
    destroy: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  }> = [];
  const create = vi.fn((_options: import("lenis").LenisOptions) => {
    if (fail) throw new Error("Smooth scroll unavailable");
    const instance = { destroy: vi.fn(), stop: vi.fn(), start: vi.fn() };
    instances.push(instance);
    return instance;
  });
  cleanup = setupSmoothScroll(document, window, preference, create);
  return { preference, create, instances };
}
describe("Letters smooth scroll", () => {
  it("uses the Botanical wheel cadence without intercepting touch or nested dialogs", () => {
    const { create } = setup();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        autoRaf: true,
        lerp: 0.07,
        wheelMultiplier: 0.65,
        smoothWheel: true,
        syncTouch: false,
        anchors: { duration: 1.15, lerp: 0 },
      }),
    );
    document.body.innerHTML = "<dialog><div></div></dialog><section></section>";
    const options = create.mock.calls[0][0];
    expect(
      options.prevent?.(document.querySelector("dialog div") as HTMLElement),
    ).toBe(true);
    expect(
      options.prevent?.(document.querySelector("section") as HTMLElement),
    ).toBe(false);
  });
  it("keeps reduced motion native, restores smoothing, and cleans up listeners", () => {
    const { preference, create, instances } = setup(true);
    expect(create).not.toHaveBeenCalled();
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(create).toHaveBeenCalledOnce();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(instances[0].destroy).toHaveBeenCalledOnce();
    cleanup();
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(create).toHaveBeenCalledOnce();
  });
  it("stops page movement for modal and root locks, then resumes", async () => {
    const { instances } = setup();
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);
    await Promise.resolve();
    expect(instances[0].stop).toHaveBeenCalledOnce();
    dialog.remove();
    await Promise.resolve();
    expect(instances[0].start).toHaveBeenCalledOnce();
    document.documentElement.style.overflow = "hidden";
    await Promise.resolve();
    expect(instances[0].stop).toHaveBeenCalledTimes(2);
  });
  it("destroys on pagehide and restores exactly one instance on cached return", () => {
    const { instances, create } = setup();
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    expect(instances[0].destroy).toHaveBeenCalledOnce();
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(create).toHaveBeenCalledTimes(2);
    cleanup();
    expect(instances[1].destroy).toHaveBeenCalledOnce();
  });
  it("falls back to native scrolling if enhancement throws", () => {
    const { create } = setup(false, true);
    expect(create).toHaveBeenCalledOnce();
    expect(() => cleanup()).not.toThrow();
  });
});
