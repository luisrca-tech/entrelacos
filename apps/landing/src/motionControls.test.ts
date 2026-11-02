// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountMotionControls } from "./motionControls";

afterEach(() => {
  document.documentElement.removeAttribute("data-motion");
  document.body.innerHTML = "";
});
function setup(reduced = false) {
  document.body.innerHTML =
    '<button data-motion-toggle hidden aria-pressed="false">Pausar animações</button>';
  const preference = new EventTarget() as EventTarget & { matches: boolean };
  preference.matches = reduced;
  const dispose = mountMotionControls(document, preference);
  return {
    button: document.querySelector("button") as HTMLButtonElement,
    preference,
    dispose,
  };
}
describe("motion accessibility", () => {
  it("exposes the control only after mounting and pauses on demand", () => {
    const { button, dispose } = setup();
    expect(button.hidden).toBe(false);
    button.click();
    expect(document.documentElement.dataset.motion).toBe("paused");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("Ativar animações");
    button.click();
    expect(document.documentElement.dataset.motion).toBe("active");
    dispose();
  });
  it("honors the operating system preference initially", () => {
    const { button, dispose } = setup(true);
    expect(document.documentElement.dataset.motion).toBe("paused");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    dispose();
  });
  it("honors a changed preference until an explicit user choice", () => {
    const { preference, button, dispose } = setup();
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.motion).toBe("paused");
    button.click();
    preference.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.motion).toBe("active");
    dispose();
  });
  it("removes listeners on disposal", () => {
    const { button, dispose } = setup();
    dispose();
    button.click();
    expect(document.documentElement.dataset.motion).toBe("active");
  });
  it("tolerates pages without a control", () => {
    document.body.innerHTML = "";
    expect(() =>
      mountMotionControls(
        document,
        Object.assign(new EventTarget(), { matches: false }),
      )(),
    ).not.toThrow();
  });
});
