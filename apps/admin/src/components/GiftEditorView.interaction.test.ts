// @vitest-environment jsdom
import type { GiftItem } from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui";
import { act, createElement, useState } from "react";
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
function publishButton() {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith("Salvar e publicar"),
  );
  if (!found) throw new Error("Missing button: Salvar e publicar");
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
  it("blocks publishing a historical amount below the minimum and allows unpublishing it", async () => {
    const callbacks = await mount([
      { ...gift, nominalCents: 499 },
      {
        ...gift,
        id: "gift-published",
        nominalCents: 499,
        publicationState: "PUBLISHED",
      },
    ]);
    const publish = button("Publicar");
    const unpublish = button("Despublicar");
    expect(publish.disabled).toBe(true);
    expect(unpublish.disabled).toBe(false);
    const help = document.getElementById(
      publish.getAttribute("aria-describedby") ?? "",
    );
    expect(help?.textContent).toMatch(
      /Ajuste o valor para pelo menos R\$\s*5,00/,
    );
    await act(async () => publish.click());
    expect(callbacks.onPublication).not.toHaveBeenCalled();
    await act(async () => unpublish.click());
    expect(callbacks.onPublication).toHaveBeenCalledExactlyOnceWith(
      "gift-published",
      "DRAFT",
    );
  });

  it("opens one editor on demand, preserves unpublished drafts and returns to the catalog", async () => {
    await mount();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => button("Editar presente").click());
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>('input[name="title"]')?.value,
    ).toBe(gift.title);
    await act(async () => button("Lista de presentes").click());
    expect(container.querySelector("form")).toBeNull();
  });
  it("previews saved content and explains draft visibility without publishing it", async () => {
    const callbacks = await mount();
    const more = container.querySelector<HTMLButtonElement>(
      '[aria-label="Mais ações para Café especial"]',
    );
    await act(async () => more?.click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (value) => value.textContent?.includes("Ver prévia"),
    ) as HTMLElement | undefined;
    expect(item).toBeDefined();
    await act(async () => item?.click());
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
    expect(container.textContent).toContain("Salvar rascunho");
    expect(container.textContent).toContain("Salvar e publicar");
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
  it("enables save and publish only when the photo, name and value are ready", async () => {
    await mount();
    await act(async () => button("Editar presente").click());
    expect(container.textContent).toContain("Pronto para publicar? 2/3");
    expect(publishButton().disabled).toBe(true);
  });
  it("saves the draft and then publishes it in one click once complete", async () => {
    const ready = { ...gift, mediaAssetId: "asset-a", altText: "Xícaras" };
    const callbacks = await mount([ready]);
    await act(async () => button("Editar presente").click());
    expect(container.textContent).toContain("Pronto para publicar? 3/3");
    const publish = publishButton();
    expect(publish.disabled).toBe(false);
    await act(async () => publish.click());
    expect(callbacks.onUpdate).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      expect.objectContaining({ title: gift.title, nominalCents: 10000 }),
    );
    expect(callbacks.onPublication).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      "PUBLISHED",
    );
    expect(callbacks.onUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.onPublication.mock.invocationCallOrder[0],
    );
  });
  it("keeps a saved draft unpublished when only the draft is saved", async () => {
    const ready = { ...gift, mediaAssetId: "asset-a", altText: "Xícaras" };
    const callbacks = await mount([ready]);
    await act(async () => button("Editar presente").click());
    await act(async () => button("Salvar rascunho").click());
    expect(callbacks.onUpdate).toHaveBeenCalledOnce();
    expect(callbacks.onPublication).not.toHaveBeenCalled();
  });
  it("publishes a photo without a description", async () => {
    const ready = { ...gift, mediaAssetId: "asset-a", altText: "" };
    const callbacks = await mount([ready]);
    await act(async () => button("Editar presente").click());
    expect(container.textContent).toContain("Pronto para publicar? 3/3");
    expect(container.textContent).not.toContain("Foto com descrição");
    const publish = publishButton();
    expect(publish.disabled).toBe(false);
    await act(async () => publish.click());
    expect(callbacks.onPublication).toHaveBeenCalledExactlyOnceWith(
      gift.id,
      "PUBLISHED",
    );
  });
  it("passes each card's 1-based catalog position to its preview", async () => {
    const renderPreview = vi.fn(() => null);
    const gifts = [
      { ...gift, id: "gift-b", sortOrder: 1 },
      { ...gift, id: "gift-a", sortOrder: 0 },
    ];
    await act(async () =>
      root.render(
        createElement(GiftEditorView, {
          gifts,
          renderPreview,
          onRetry: vi.fn(),
          onCreate: vi.fn(async () => {}),
          onUpdate: vi.fn(async () => {}),
          onPublication: vi.fn(async () => {}),
          onReorder: vi.fn(async () => {}),
        }),
      ),
    );
    expect(renderPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gift-a" }),
      1,
    );
    expect(renderPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gift-b" }),
      2,
    );
  });
});

describe("photo on a new gift", () => {
  const failure =
    "O presente foi salvo, mas a foto não foi enviada. Tente enviar de novo.";
  const png = () =>
    new File([new Uint8Array([1, 2, 3])], "mesa.png", { type: "image/png" });
  beforeEach(() => {
    let next = 0;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:new-gift-${++next}`),
      revokeObjectURL: vi.fn(),
    });
  });
  // Mirrors the controller: creating a gift adds it to the catalog and
  // resolves with the created item.
  async function mountCreating(
    upload: (giftId: string, file: File, alt: string) => Promise<void>,
    create: () => Promise<void> = async () => {},
  ) {
    const calls = {
      onCreate: vi.fn(),
      onUploadPhoto: vi.fn(upload),
      onUpdate: vi.fn(async () => {}),
      onPublication: vi.fn(async () => {}),
    };
    function Harness() {
      const [gifts, setGifts] = useState<GiftItem[]>([]);
      return createElement(GiftEditorView, {
        gifts,
        onRetry: vi.fn(),
        onReorder: vi.fn(async () => {}),
        onUpdate: calls.onUpdate,
        onPublication: calls.onPublication,
        onUploadPhoto: calls.onUploadPhoto,
        onCreate: async (input) => {
          calls.onCreate(input);
          await create();
          const created: GiftItem = { ...gift, ...input, id: "gift-new" };
          setGifts((current) => [...current, created]);
          return created;
        },
      });
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => button("Adicionar presente").click());
    await enter(
      container.querySelector('input[name="title"]') as HTMLInputElement,
      "Jantar",
    );
    await enter(
      container.querySelector('input[name="nominalPrice"]') as HTMLInputElement,
      "25,25",
    );
    return calls;
  }
  async function choosePhoto(selected = png()) {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [selected],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return selected;
  }
  function draftButton() {
    const found = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Salvar rascunho"),
    );
    if (!found) throw new Error("Missing button: Salvar rascunho");
    return found;
  }

  it("picks a photo before the gift exists and previews it immediately", async () => {
    await mountCreating(async () => {});
    expect(container.textContent).not.toContain("Salve o rascunho");
    expect(publishButton().disabled).toBe(true);
    await choosePhoto();
    const image = container.querySelector('img[src="blob:new-gift-1"]');
    expect(image).not.toBeNull();
    expect(container.textContent).toContain("Trocar foto");
    expect(container.textContent).toContain("Pronto para publicar? 3/3");
    expect(publishButton().disabled).toBe(false);
  });

  it("creates the gift once and then uploads the kept photo when saving the draft", async () => {
    const calls = await mountCreating(async () => {});
    const selected = await choosePhoto();
    await act(async () => draftButton().click());
    expect(calls.onCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Jantar", mediaAssetId: null }),
    );
    expect(calls.onUploadPhoto).toHaveBeenCalledExactlyOnceWith(
      "gift-new",
      selected,
      "",
    );
    expect(calls.onCreate.mock.invocationCallOrder[0]).toBeLessThan(
      calls.onUploadPhoto.mock.invocationCallOrder[0],
    );
    expect(calls.onPublication).not.toHaveBeenCalled();
  });

  it("keeps the created gift after an upload failure and retries only the upload", async () => {
    const error = vi.spyOn(toast, "error");
    let attempts = 0;
    const calls = await mountCreating(async () => {
      if (++attempts === 1) throw new Error("upload failed");
    });
    const selected = await choosePhoto();
    await act(async () => draftButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      failure,
    );
    expect(error).toHaveBeenCalledWith(failure);
    await act(async () => button("Enviar foto de novo").click());
    expect(calls.onCreate).toHaveBeenCalledOnce();
    expect(calls.onUploadPhoto).toHaveBeenCalledTimes(2);
    expect(calls.onUploadPhoto).toHaveBeenLastCalledWith(
      "gift-new",
      selected,
      "",
    );
    expect(container.textContent).not.toContain(failure);
  });

  it("retries the upload, not the creation, when the draft is saved again", async () => {
    let attempts = 0;
    const calls = await mountCreating(async () => {
      if (++attempts === 1) throw new Error("upload failed");
    });
    await choosePhoto();
    await act(async () => draftButton().click());
    await act(async () => draftButton().click());
    expect(calls.onCreate).toHaveBeenCalledOnce();
    expect(calls.onUpdate).toHaveBeenCalledExactlyOnceWith(
      "gift-new",
      expect.objectContaining({ title: "Jantar" }),
    );
    expect(calls.onUploadPhoto).toHaveBeenCalledTimes(2);
  });

  it("creates, uploads and only then publishes", async () => {
    const calls = await mountCreating(async () => {});
    await choosePhoto();
    await act(async () => publishButton().click());
    expect(calls.onPublication).toHaveBeenCalledExactlyOnceWith(
      "gift-new",
      "PUBLISHED",
    );
    const order = [
      calls.onCreate.mock.invocationCallOrder[0],
      calls.onUploadPhoto.mock.invocationCallOrder[0],
      calls.onPublication.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("does not publish when the photo upload fails", async () => {
    const calls = await mountCreating(async () => {
      throw new Error("upload failed");
    });
    await choosePhoto();
    await act(async () => publishButton().click());
    expect(calls.onCreate).toHaveBeenCalledOnce();
    expect(calls.onPublication).not.toHaveBeenCalled();
    expect(container.textContent).toContain(failure);
  });

  it("disables the photo and save actions while the gift is being saved", async () => {
    let finish!: () => void;
    const created = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await mountCreating(
      async () => {},
      () => created,
    );
    await choosePhoto();
    await act(async () => {
      draftButton().click();
    });
    expect(draftButton().disabled).toBe(true);
    expect(publishButton().disabled).toBe(true);
    expect(button("Trocar foto").disabled).toBe(true);
    await act(async () => finish());
  });
});
