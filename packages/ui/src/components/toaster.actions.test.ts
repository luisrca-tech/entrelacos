// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "../lib/publishToast";
import { Toaster } from "./toaster";

const nativeToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ Toaster: () => null, toast: nativeToast }));

afterEach(() => {
  vi.clearAllMocks();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Toaster action bridge", () => {
  it("passes the action to Sonner without invoking it and detaches on unmount", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const surface = document.createElement("div");
    const root = createRoot(surface);
    const action = { label: "Continuar pagamento", onClick: vi.fn() };
    await act(async () => root.render(createElement(Toaster)));
    try {
      toast.warning("Pagamento aguardando conclusão.", { action });
      expect(nativeToast.warning).toHaveBeenCalledWith(
        "Pagamento aguardando conclusão.",
        { action },
      );
      expect(action.onClick).not.toHaveBeenCalled();
      const options = nativeToast.warning.mock.calls[0]?.[1];
      options.action.onClick();
      expect(action.onClick).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
    toast.warning("No mounted listener.", { action });
    expect(nativeToast.warning).toHaveBeenCalledTimes(1);
  });
});
