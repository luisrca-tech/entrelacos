import { describe, expect, it } from "vitest";
import { captureFocus, restoreFocus } from "./dialogFocus";

describe("dialog focus helpers", () => {
  it("captures a focusable opener and restores focus when it remains connected", () => {
    let focused = 0;
    const opener = {
      isConnected: true,
      focus: () => {
        focused += 1;
      },
    };

    const target = captureFocus(opener);
    restoreFocus(target);

    expect(focused).toBe(1);
  });

  it("does not focus a removed opener", () => {
    let focused = 0;
    const target = captureFocus({
      isConnected: false,
      focus: () => {
        focused += 1;
      },
    });

    restoreFocus(target);

    expect(focused).toBe(0);
    expect(captureFocus(null)).toBeNull();
  });
});
