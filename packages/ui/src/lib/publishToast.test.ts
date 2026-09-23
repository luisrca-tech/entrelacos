import { afterEach, describe, expect, it, vi } from "vitest";
import { publishToast, toastEventName } from "./publishToast";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishToast", () => {
  it("dispatches kind and message for the mounted toaster", () => {
    const events: CustomEvent[] = [];
    vi.stubGlobal("window", {
      dispatchEvent(event: CustomEvent) {
        events.push(event);
        return true;
      },
    });

    publishToast("success", "Acesso confirmado.");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(toastEventName);
    expect(events[0]?.detail).toEqual({
      kind: "success",
      message: "Acesso confirmado.",
    });
  });
});
