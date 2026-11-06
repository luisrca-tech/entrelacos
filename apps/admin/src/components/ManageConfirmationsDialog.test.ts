// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManageConfirmationsDialog } from "./ManageConfirmationsDialog";

let root: Root;
let container: HTMLDivElement;
const onOpenChange = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onOpenChange.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ManageConfirmationsDialog, {
        open: true,
        onOpenChange,
        view: null,
        history: null,
        loading: false,
        busy: false,
        inactive: false,
        onSave: vi.fn(),
        onLoadMoreHistory: vi.fn(),
      }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});

function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")];
}

it("offers a close button and a cancel action in an opaque footer", async () => {
  const close = buttons().find(
    (button) => button.getAttribute("data-slot") === "dialog-close",
  );
  expect(close).toBeDefined();
  const cancel = buttons().find(
    (button) => button.textContent?.trim() === "Cancelar",
  );
  expect(cancel).toBeDefined();
  const footer = cancel?.closest("[data-confirmations-footer]");
  expect(footer?.className).toContain("bg-admin-surface");
  expect(footer?.className).toContain("sticky");
  await act(async () => cancel?.click());
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
