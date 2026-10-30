// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureRenderedLines, setupLineReveals } from "./lineReveal";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("heading line reveal", () => {
  it("measures wrapped words and preserves their text order", () => {
    const heading = document.createElement("h2");
    heading.textContent = "A day worth remembering";
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "40px",
    } as CSSStyleDeclaration);
    let index = -1;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart: () => {
        index++;
      },
      setEnd: () => {},
      getBoundingClientRect: () => ({ top: index < 2 ? 105 : 145, height: 30 }),
    } as unknown as Range);
    expect(measureRenderedLines(heading)).toEqual([
      { text: "A day", top: 0, height: 40 },
      { text: "worth remembering", top: 40, height: 40 },
    ]);
  });

  it("falls back when Range measurement is unsupported", () => {
    const heading = document.createElement("h2");
    heading.textContent = "A day";
    vi.spyOn(document, "createRange").mockImplementation(() => {
      throw new Error("Range unavailable");
    });
    expect(measureRenderedLines(heading)).toEqual([]);
  });

  it("restores the original heading if an animation cannot start", async () => {
    document.body.innerHTML =
      '<div data-template-reveal data-template-motion-ready="true" data-template-reveal-state="hidden"><h2 data-template-line-reveal>A day</h2></div>';
    const heading = document.querySelector("h2");
    const target = document.querySelector<HTMLElement>(
      "[data-template-reveal]",
    );
    if (!heading || !target) throw new Error("Missing heading");
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "40px",
    } as CSSStyleDeclaration);
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => ({ top: 105, height: 30 }),
    } as unknown as Range);
    Object.defineProperty(Element.prototype, "animate", {
      value: () => {
        throw new Error("Animation unavailable");
      },
      configurable: true,
    });
    const cleanup = setupLineReveals(document, false);
    await Promise.resolve();
    target.dataset.templateRevealState = "visible";
    await Promise.resolve();
    expect(heading.textContent).toBe("A day");
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
    cleanup();
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it("keeps original text visible when motion is reduced or measurement fails", () => {
    document.body.innerHTML =
      "<div data-template-reveal><h2 data-template-line-reveal>A day</h2></div>";
    const heading = document.querySelector("h2");
    if (!heading) throw new Error("Missing heading");
    const cleanup = setupLineReveals(document, true);
    expect(heading.textContent).toBe("A day");
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
    cleanup();
  });
  it("leaves text visible if the reveal observer is unavailable", async () => {
    document.body.innerHTML =
      "<div data-template-reveal><h2 data-template-line-reveal>A day</h2></div>";
    Object.defineProperty(Element.prototype, "animate", {
      value: vi.fn(),
      configurable: true,
    });
    const heading = document.querySelector("h2");
    const cleanup = setupLineReveals(document, false);
    await Promise.resolve();
    expect(heading?.textContent).toBe("A day");
    expect(heading?.querySelector('[aria-hidden="true"]')).toBeNull();
    cleanup();
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it("prepares an initially unready heading when its wrapper becomes ready", async () => {
    document.body.innerHTML =
      "<div data-template-reveal><h2 data-template-line-reveal>A day</h2></div>";
    const heading = document.querySelector("h2");
    const target = document.querySelector<HTMLElement>(
      "[data-template-reveal]",
    );
    if (!heading || !target) throw new Error("Missing heading");
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "40px",
    } as CSSStyleDeclaration);
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => ({ top: 105, height: 30 }),
    } as unknown as Range);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, finished: new Promise(() => {}) }));
    Object.defineProperty(Element.prototype, "animate", {
      value: animate,
      configurable: true,
    });
    const cleanup = setupLineReveals(document, false);
    await Promise.resolve();
    expect(heading.textContent).toBe("A day");
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
    target.dataset.templateMotionReady = "true";
    target.dataset.templateRevealState = "hidden";
    await Promise.resolve();
    expect(heading.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "A day",
    );
    target.dataset.templateRevealState = "visible";
    await Promise.resolve();
    expect(animate).toHaveBeenCalledOnce();
    delete target.dataset.templateMotionReady;
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(heading.textContent).toBe("A day");
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
    cleanup();
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it("animates masked copies once and restores the accessible original on cleanup", async () => {
    document.body.innerHTML =
      '<div data-template-reveal data-template-motion-ready="true" data-template-reveal-state="hidden"><h2 data-template-line-reveal>A day</h2></div>';
    const heading = document.querySelector("h2");
    const target = document.querySelector<HTMLElement>(
      "[data-template-reveal]",
    );
    if (!heading || !target) throw new Error("Missing heading");
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "40px",
    } as CSSStyleDeclaration);
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => ({ top: 105, height: 30 }),
    } as unknown as Range);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, finished: new Promise(() => {}) }));
    Object.defineProperty(Element.prototype, "animate", {
      value: animate,
      configurable: true,
    });
    heading.style.position = "sticky";
    const cleanup = setupLineReveals(document, false);
    await Promise.resolve();
    expect(heading.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "A day",
    );
    target.dataset.templateRevealState = "visible";
    await Promise.resolve();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toMatchObject({
      duration: 1200,
      delay: 0,
    });
    cleanup();
    expect(cancel).toHaveBeenCalledOnce();
    expect(heading.textContent).toBe("A day");
    expect(heading.style.position).toBe("sticky");
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
    delete (Element.prototype as { animate?: unknown }).animate;
  });
});
