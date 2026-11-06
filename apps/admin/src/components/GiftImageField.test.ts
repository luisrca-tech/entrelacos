// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftImageField } from "./GiftImageField";

const gift = {
  id: "private-gift",
  siteId: "wedding-a",
  title: "Jantar",
  description: "",
  nominalCents: 10000,
  currency: "BRL",
  mediaAssetId: "private-asset",
  altText: "Mesa para o jantar",
  sortOrder: 0,
  publicationState: "DRAFT",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
} as const;
describe("gift image editor presentation", () => {
  const mounted: Root[] = [];
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    for (const root of mounted.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
  });
  async function mount(extra = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    const props = {
      gift,
      position: 1,
      disabled: false,
      onUpload: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
      onAltChange: vi.fn(async () => {}),
      ...extra,
    };
    await act(async () => root.render(createElement(GiftImageField, props)));
    return { container, root, props };
  }
  function choose(container: HTMLElement) {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        new File([new Uint8Array([1, 2, 3])], "image.png", {
          type: "image/png",
        }),
      ],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input;
  }
  function button(container: HTMLElement, label: string) {
    const result = [...container.querySelectorAll("button")].find((value) =>
      value.textContent?.includes(label),
    );
    if (!result) throw new Error("Missing field button");
    return result;
  }
  it("accepts a valid local file without requiring a precomputed hash and clears it only after owned success", async () => {
    const f = await mount();
    await act(async () => {
      choose(f.container);
    });
    await act(async () => button(f.container, "Enviar foto").click());
    expect(f.props.onUpload).toHaveBeenCalledOnce();
    // The sent file is cleared, so no second upload is offered.
    expect(
      [...f.container.querySelectorAll("button")].some((value) =>
        value.textContent?.includes("Enviar foto"),
      ),
    ).toBe(false);
  });
  it("offers manual consultation and recovery for unknown retained correlation without automatic callbacks", async () => {
    const consult = vi.fn(async () => {});
    const recover = vi.fn(async () => {});
    const f = await mount({
      mediaState: {
        state: "UNKNOWN",
        busy: false,
        retained: true,
        canRetrySameBytes: false,
        media: null,
        error: "",
      },
      onConsult: consult,
      onRecover: recover,
    });
    expect(f.container.textContent).toContain(
      "O envio ainda não foi confirmado",
    );
    expect(consult).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    await act(async () => button(f.container, "Consultar envio").click());
    expect(consult).toHaveBeenCalledOnce();
    await act(async () => button(f.container, "Recuperar imagem").click());
    expect(recover).toHaveBeenCalledOnce();
    expect(f.props.onUpload).not.toHaveBeenCalled();
    expect(f.container.innerHTML).not.toContain("private-asset");
  });
  it("requires authoritative retry permission before explicitly sending a retained file", async () => {
    const state = {
      state: "UNKNOWN" as const,
      busy: false,
      retained: true,
      canRetrySameBytes: false,
      media: null,
      error: "",
    };
    const f = await mount({ mediaState: state });
    await act(async () => {
      choose(f.container);
    });
    expect(button(f.container, "Reenviar mesmo arquivo").disabled).toBe(true);
    await act(async () =>
      f.root.render(
        createElement(GiftImageField, {
          ...f.props,
          mediaState: { ...state, canRetrySameBytes: true },
        }),
      ),
    );
    await act(async () =>
      button(f.container, "Reenviar mesmo arquivo").click(),
    );
    expect(f.props.onUpload).toHaveBeenCalledOnce();
  });
  it("does not clear a replacement field or paint an old upload failure", async () => {
    let reject!: (value: unknown) => void;
    const pending = new Promise<void>((_yes, no) => {
      reject = no;
    });
    void pending.catch(() => {});
    const f = await mount({ onUpload: vi.fn(() => pending) });
    await act(async () => {
      choose(f.container);
    });
    await act(async () => button(f.container, "Enviar foto").click());
    await act(async () =>
      f.root.render(
        createElement(GiftImageField, {
          ...f.props,
          gift: { ...gift, id: "replacement", altText: "Nova descrição" },
        }),
      ),
    );
    await act(async () => {
      reject(new Error("Old failure"));
    });
    expect(f.container.textContent).not.toContain("Não foi possível atualizar");
    expect(
      f.container.querySelector<HTMLInputElement>('input:not([type="file"])')
        ?.value,
    ).toBe("Nova descrição");
  });
  it("masks a lost owner and blocks stale action callbacks", async () => {
    const f = await mount({ isCurrent: () => false });
    expect(f.container.querySelector('input[type="file"]')).toBeNull();
    expect(f.props.onUpload).not.toHaveBeenCalled();
    expect(f.container.textContent).toContain("Verifique sua sessão");
  });
  const emptyGift = { ...gift, mediaAssetId: null, altText: "" };
  function fileInput(container: HTMLElement) {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    return input;
  }
  function dropzone(container: HTMLElement) {
    const zone = container.querySelector<HTMLElement>("[data-dropzone]");
    if (!zone) throw new Error("Missing dropzone");
    return zone;
  }
  function dragEvent(type: string, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files, types: ["Files"], dropEffect: "none" },
    });
    return event;
  }
  const png = () =>
    new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  it("opens the native picker from a visible button and from the whole dropzone", async () => {
    const f = await mount({ gift: emptyGift });
    const click = vi.spyOn(fileInput(f.container), "click");
    await act(async () => button(f.container, "Escolher foto").click());
    expect(click).toHaveBeenCalledTimes(1);
    await act(async () => dropzone(f.container).click());
    expect(click).toHaveBeenCalledTimes(2);
    expect(fileInput(f.container).accept).toBe(
      "image/jpeg,image/png,image/webp",
    );
    expect(fileInput(f.container).hasAttribute("capture")).toBe(false);
  });
  it("rejects unsupported or oversized files chosen in the picker with a described error", async () => {
    const f = await mount({ gift: emptyGift });
    const input = fileInput(f.container);
    for (const [selected, message] of [
      [
        new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
        "não é uma imagem",
      ],
      [
        new File([new Uint8Array(5_242_881)], "big.png", { type: "image/png" }),
        "5 MB",
      ],
    ] as const) {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [selected],
      });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const alert = f.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(message);
      expect(input.getAttribute("aria-describedby")).toContain(alert?.id);
      expect(f.container.textContent).not.toContain("Enviar foto");
    }
  });
  it("highlights the dropzone while dragging and stages a dropped image", async () => {
    const f = await mount({ gift: emptyGift });
    const zone = dropzone(f.container);
    await act(async () => {
      zone.dispatchEvent(dragEvent("dragenter"));
    });
    expect(zone.dataset.dragging).toBe("true");
    const over = dragEvent("dragover");
    await act(async () => {
      zone.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    await act(async () => {
      zone.dispatchEvent(dragEvent("drop", [png()]));
    });
    expect(f.container.querySelector("[data-dropzone]")).toBeNull();
    expect(f.container.textContent).toContain("Pronta para enviar");
    expect(button(f.container, "Trocar foto")).toBeTruthy();
    await act(async () => button(f.container, "Remover").click());
    expect(f.container.querySelector("[data-dropzone]")).not.toBeNull();
  });
  it("rejects a dropped non-image file and clears the highlight", async () => {
    const f = await mount({ gift: emptyGift });
    const zone = dropzone(f.container);
    await act(async () => {
      zone.dispatchEvent(dragEvent("dragenter"));
      zone.dispatchEvent(
        dragEvent("drop", [
          new File(["x"], "notes.txt", { type: "text/plain" }),
        ]),
      );
    });
    expect(zone.dataset.dragging).toBe("false");
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      "não é uma imagem",
    );
  });
  it("shows alt text and image controls without exposing private media identifiers", () => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift,
        position: 1,
        disabled: false,
        onUpload: vi.fn(),
        onRemove: vi.fn(),
        onAltChange: vi.fn(),
      }),
    );
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("Descreva a foto");
    expect(html).toContain("Mesa para o jantar");
    expect(html).toContain("Remover foto");
    expect(html).not.toContain("private-asset");
    expect(html).not.toContain("private-gift");
  });
  it("disables all media actions with the parent catalog", () => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift,
        position: 1,
        disabled: true,
        onUpload: vi.fn(),
        onRemove: vi.fn(),
        onAltChange: vi.fn(),
      }),
    );
    for (const button of html.matchAll(/<button[^>]*>/g))
      expect(button[0]).toContain("disabled");
    expect(html).toContain('type="file"');
    expect(html).not.toContain("<form");
  });
  it("labels the description optional without mentioning the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift,
        position: 2,
        disabled: false,
        onUpload: vi.fn(),
        onRemove: vi.fn(),
        onAltChange: vi.fn(),
      }),
    );
    expect(html).toContain("Descreva a foto");
    expect(html).toContain("· Opcional");
    expect(html).not.toContain("Obrigatório");
    expect(html).toContain("Ajuda quem usa leitor de tela.");
    expect(html).not.toContain("na lista");
  });
  it("sends a chosen photo without a description", async () => {
    const f = await mount({ gift: { ...gift, altText: "" } });
    await act(async () => {
      choose(f.container);
    });
    const send = button(f.container, "Enviar foto");
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(f.props.onUpload).toHaveBeenCalledWith(expect.any(File), "");
  });
  it("saves a cleared description as empty", async () => {
    const f = await mount();
    const input = f.container.querySelector<HTMLInputElement>(
      'input:not([type="file"])',
    );
    if (!input) throw new Error("Missing description input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "   ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = button(f.container, "Salvar descrição");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(f.props.onAltChange).toHaveBeenCalledWith("");
  });
  it("recovers a retained image without a description", async () => {
    const recover = vi.fn(async () => {});
    const f = await mount({
      gift: { ...gift, altText: "" },
      mediaState: {
        state: "UNKNOWN",
        busy: false,
        retained: true,
        canRetrySameBytes: false,
        media: null,
        error: "",
      },
      onRecover: recover,
    });
    const action = button(f.container, "Recuperar imagem");
    expect(action.disabled).toBe(false);
    await act(async () => action.click());
    expect(recover).toHaveBeenCalledWith("");
  });
  it.each([
    ["Mesa para o jantar", "Mesa para o jantar"],
    ["", "Imagem do presente 4 na lista"],
  ])("describes the saved preview %j as %j", (altText, expected) => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift: { ...gift, altText },
        position: 4,
        preview: {
          id: gift.mediaAssetId,
          siteId: gift.siteId,
          url: "https://media.example.test/a.webp",
          contentType: "image/webp",
          byteLength: 10,
          width: 10,
          height: 10,
        },
        disabled: false,
        onUpload: vi.fn(),
        onRemove: vi.fn(),
        onAltChange: vi.fn(),
      }),
    );
    expect(html).toContain(`alt="${expected}"`);
  });
});
