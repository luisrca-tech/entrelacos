// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvitationFormDialog } from "./InvitationFormDialog";

let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onSave.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(InvitationFormDialog, {
        open: true,
        invitation: null,
        inactive: false,
        busy: false,
        onOpenChange: vi.fn(),
        onSave,
      }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing ${selector}`);
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  await act(async () =>
    input.dispatchEvent(new Event("input", { bubbles: true })),
  );
}

it("organizes the invitation in numbered sheet sections with a fixed footer", () => {
  const sheet = document.querySelector('[data-slot="dialog-content"]');
  expect(sheet?.getAttribute("data-layout")).toBe("sheet");
  const legends = [...document.querySelectorAll("legend")].map((legend) =>
    legend.textContent?.trim(),
  );
  expect(legends).toEqual(
    expect.arrayContaining(["1Identificação", "2Pessoas", "3Revisar"]),
  );
  const footer = document.querySelector('[data-slot="sheet-footer"]');
  expect(footer?.textContent).toContain("Cancelar");
  expect(footer?.textContent).toContain("Salvar convite");
});

it("reviews people by age group and saves the same invitation payload", async () => {
  await type("#invitation-name", "Família Lima");
  await type("#invitation-phone", "11999999999");
  await type("#invitation-guest-name-0", "Ana Lima");
  await act(async () => button("Adicionar pessoa").click());
  await type("#invitation-guest-name-1", "Bia Lima");
  const child = document.querySelectorAll<HTMLInputElement>(
    'input[name="guests.1.guestType"]',
  )[1];
  await act(async () => child.click());
  const review = [...document.querySelectorAll("fieldset")].find((entry) =>
    entry.querySelector("legend")?.textContent?.includes("Revisar"),
  );
  expect(review?.textContent).toContain("Família Lima");
  expect(review?.textContent).toContain("2 pessoas");
  expect(review?.textContent).toContain("1 adulto");
  expect(review?.textContent).toContain("1 criança");
  const form = document.querySelector("form");
  await act(async () =>
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0]).toMatchObject({
    name: "Família Lima",
    guests: [
      { fullName: "Ana Lima", guestType: "ADULT" },
      { fullName: "Bia Lima", guestType: "CHILD" },
    ],
  });
});

it("keeps validation messages when required data is missing", async () => {
  const form = document.querySelector("form");
  await act(async () =>
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(onSave).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "Informe a identificação do convite.",
  );
  expect(document.body.textContent).toContain("Informe o nome do convidado.");
});
