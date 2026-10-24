// @vitest-environment jsdom
import type { GiftItem } from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftEditorView } from "./GiftEditorView";

const gift: GiftItem = {
  id: "gift-a",
  siteId: "site-a",
  title: "Café especial",
  description: "Uma pausa a dois",
  nominalCents: 10000,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  sortOrder: 0,
  publicationState: "DRAFT",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(gifts: GiftItem[] = [gift]) {
  const callbacks = {
    onRetry: vi.fn(),
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onPublication: vi.fn(async () => {}),
    onReorder: vi.fn(async () => {}),
  };
  await act(async () =>
    root.render(createElement(GiftEditorView, { gifts, ...callbacks })),
  );
  return callbacks;
}
describe("focused gift catalog", () => {
  it("opens one editor on demand, preserves unpublished drafts and returns to the catalog", async () => {
    await mount();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => button("Editar presente").click());
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>('input[name="title"]')?.value,
    ).toBe(gift.title);
    await act(async () => button("Voltar ao catálogo").click());
    expect(container.querySelector("form")).toBeNull();
  });
  it("previews saved content and explains draft visibility without publishing it", async () => {
    const callbacks = await mount();
    await act(async () => button("Ver prévia").click());
    const preview = document.querySelector('[role="dialog"]');
    expect(preview?.textContent).toContain("Café especial");
    expect(preview?.textContent).toContain("Uma pausa a dois");
    expect(preview?.textContent).toContain("apenas no painel");
    expect(preview?.textContent).not.toContain(gift.id);
    expect(callbacks.onPublication).not.toHaveBeenCalled();
  });
  it("edits a gift whose opaque ID matches a creation label", async () => {
    await mount([{ ...gift, id: "new" }]);
    await act(async () => button("Editar presente").click());
    expect(
      container.querySelector<HTMLInputElement>('input[name="title"]')?.value,
    ).toBe(gift.title);
    expect(container.textContent).toContain("Salvar alterações");
  });
  it("publishes explicitly and requires confirmation before archival", async () => {
    const callbacks = await mount();
    await act(async () => button("Publicar").click());
    expect(callbacks.onPublication).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      "PUBLISHED",
    );
    callbacks.onPublication.mockClear();
    await act(async () => button("Editar presente").click());
    await act(async () => button("Arquivar presente").click());
    expect(callbacks.onPublication).not.toHaveBeenCalled();
    const confirmation = document.querySelector('[role="alertdialog"]');
    expect(confirmation).not.toBeNull();
    const confirm = [...(confirmation?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent?.includes("Arquivar presente"),
    );
    await act(async () => confirm?.click());
    expect(callbacks.onPublication).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      "ARCHIVED",
    );
  });
  it("preserves entered details after a failed save and reports failure through toast", async () => {
    const callbacks = await mount([]);
    callbacks.onCreate.mockRejectedValueOnce(new Error("Server unavailable"));
    const notice = vi.spyOn(toast, "error");
    await act(async () => button("Adicionar presente").click());
    await enter(
      container.querySelector('input[name="title"]') as HTMLInputElement,
      "Jantar",
    );
    await enter(
      container.querySelector('input[name="nominalPrice"]') as HTMLInputElement,
      "25,25",
    );
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("Não foi possível salvar"),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[name="title"]')?.value,
    ).toBe("Jantar");
    expect(
      container.querySelector<HTMLInputElement>('input[name="nominalPrice"]')
        ?.value,
    ).toBe("25,25");
  });
  it("creates a draft with exact cents and confirms success through the shared toast", async () => {
    const callbacks = await mount([]);
    const notice = vi.spyOn(toast, "success");
    await act(async () => button("Adicionar presente").click());
    await enter(
      container.querySelector('input[name="title"]') as HTMLInputElement,
      "Jantar",
    );
    await enter(
      container.querySelector('input[name="nominalPrice"]') as HTMLInputElement,
      "25,25",
    );
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(callbacks.onCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Jantar",
        nominalCents: 2525,
        mediaAssetId: null,
      }),
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("rascunho"));
    expect(container.querySelector("form")).toBeNull();
  });
  it("filters by publication state and clears a search without mutating the catalog", async () => {
    const callbacks = await mount([
      gift,
      {
        ...gift,
        id: "gift-b",
        title: "Viagem",
        publicationState: "PUBLISHED",
        sortOrder: 1,
      },
    ]);
    await act(async () => button("Publicados").click());
    expect(container.textContent).not.toContain("Café especial");
    expect(container.textContent).toContain("Viagem");
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    ) as HTMLInputElement;
    await enter(search, "missing");
    expect(container.textContent).toContain("Nenhum presente encontrado");
    await act(async () => button("Limpar filtros").click());
    expect(container.textContent).toContain("Café especial");
    expect(callbacks.onUpdate).not.toHaveBeenCalled();
    expect(callbacks.onPublication).not.toHaveBeenCalled();
  });
  it("keeps full catalog order when publishing filters hide neighboring gifts", async () => {
    const callbacks = await mount([
      {
        ...gift,
        id: "gift-b",
        title: "Viagem",
        publicationState: "PUBLISHED",
        sortOrder: 1,
      },
      gift,
    ]);
    await act(async () => button("Publicados").click());
    const up = container.querySelector<HTMLButtonElement>(
      '[aria-label="Mover Viagem para cima"]',
    );
    expect(up?.disabled).toBe(false);
    await act(async () => up?.click());
    expect(callbacks.onReorder).toHaveBeenCalledExactlyOnceWith([
      "gift-b",
      "gift-a",
    ]);
  });
});
