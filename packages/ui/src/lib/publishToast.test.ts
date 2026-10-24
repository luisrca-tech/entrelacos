import { afterEach, describe, expect, it, vi } from "vitest";
import { publishToast, toast, toastEventName } from "./publishToast";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishToast", () => {
  it("preserves the optional action for a direct toast continuation", () => {
    const events: CustomEvent[] = [];
    vi.stubGlobal("window", {
      dispatchEvent(event: CustomEvent) {
        events.push(event);
        return true;
      },
    });
    const action = { label: "Continuar pagamento", onClick: vi.fn() };

    toast.warning("Pagamento aguardando conclusão.", { action });

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      kind: "warning",
      message: "Pagamento aguardando conclusão.",
      action,
    });
    expect(action.onClick).not.toHaveBeenCalled();
  });
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
