// @vitest-environment jsdom
import type { GiftItem } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftEditorView } from "./GiftEditorView";

const gift: GiftItem = {
  id: "gift-one",
  siteId: "site-one",
  title: "Jantar",
  description: "Presente simbólico",
  nominalCents: 12345,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  sortOrder: 0,
  publicationState: "DRAFT",
  createdAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};
const roots: Root[] = [];
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function mount(gifts: GiftItem[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const callbacks = {
    onRetry: vi.fn(),
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onPublication: vi.fn(async () => {}),
    onReorder: vi.fn(async () => {}),
  };
  const render = async (next = gifts) => {
    await act(async () =>
      root.render(createElement(GiftEditorView, { gifts: next, ...callbacks })),
    );
  };
  await render();
  const open = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(
      gifts.length ? "Editar presente" : "Adicionar presente",
    ),
  );
  if (!open) throw new Error("Missing gift editor action");
  await act(async () => open.click());
  return { container, callbacks, render };
}
async function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("Native input value setter unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}
function requiredElement<T extends Element = Element>(
  parent: ParentNode,
  selector: string,
): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing expected form element: ${selector}`);
  return element;
}
function amounts(section: Element): string[] {
  return [...section.querySelectorAll("dd")].map((element) => text(element));
}
describe("private gift price commission preview", () => {
  it("shows the configured price, deducted commission and net estimate while creating without changing the submitted base", async () => {
    const v = await mount();
    const form = requiredElement(v.container, "form");
    const input = requiredElement<HTMLInputElement>(
      form,
      'input[name="nominalPrice"]',
    );
    await enter(input, "100,00");
    expect(text(form)).toContain("Valor que o convidado pagará");
    expect(text(form)).toContain("Comissão");
    expect(text(form)).toContain("Líquido do casal");
    expect(amounts(form)).toEqual([
      "R$ 100,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "R$ 100,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
    ]);
    expect(text(form)).toContain("O convidado paga o valor cadastrado");
    expect(text(form)).toContain("Indisponível");
    expect(text(form)).toContain("sem garantia");
    expect(input.value).toBe("100,00");
    expect(v.callbacks.onCreate).not.toHaveBeenCalled();
    await enter(
      requiredElement<HTMLInputElement>(form, 'input[name="title"]'),
      "Jantar",
    );
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(v.callbacks.onCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nominalCents: 10000 }),
    );
  });
  it("previews the saved edit value and updates only the edited gift with exact cent rounding", async () => {
    const v = await mount([gift]);
    const form = requiredElement(v.container, "article form");
    const input = requiredElement<HTMLInputElement>(
      form,
      'input[name="nominalPrice"]',
    );
    expect(amounts(form)).toEqual([
      "R$ 123,45",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "R$ 123,45",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
    ]);
    await enter(input, "25,25");
    expect(amounts(form)).toEqual([
      "R$ 25,25",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "R$ 25,25",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
    ]);
    expect(v.callbacks.onUpdate).not.toHaveBeenCalled();
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(v.callbacks.onUpdate).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      expect.objectContaining({ nominalCents: 2525 }),
    );
  });
  it("does not retain a stale preview for an invalid or empty price", async () => {
    const v = await mount();
    const form = requiredElement(v.container, "form");
    const input = requiredElement<HTMLInputElement>(
      form,
      'input[name="nominalPrice"]',
    );
    await enter(input, "100");
    expect(amounts(form)).toHaveLength(10);
    for (const value of ["", "0", "1,001", "not-a-price"]) {
      await enter(input, value);
      expect(amounts(form)).toHaveLength(0);
    }
    expect(v.callbacks.onCreate).not.toHaveBeenCalled();
  });
  it("keeps an edit draft through an unchanged server value and resets after the persisted price changes", async () => {
    const v = await mount([gift]);
    await enter(
      requiredElement<HTMLInputElement>(
        v.container,
        'article input[name="nominalPrice"]',
      ),
      "100",
    );
    await v.render([{ ...gift }]);
    expect(amounts(requiredElement(v.container, "article form"))).toEqual([
      "R$ 100,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "R$ 100,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
    ]);
    await v.render([{ ...gift, nominalCents: 20000 }]);
    expect(amounts(requiredElement(v.container, "article form"))).toEqual([
      "R$ 200,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "R$ 200,00",
      "Indisponível",
      "Indisponível",
      "Indisponível",
      "Indisponível",
    ]);
  });
});
