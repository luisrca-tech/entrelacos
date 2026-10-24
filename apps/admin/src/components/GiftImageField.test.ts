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
    await act(async () => button(f.container, "Enviar imagem").click());
    expect(f.props.onUpload).toHaveBeenCalledOnce();
    expect(button(f.container, "Enviar imagem").disabled).toBe(true);
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
    await act(async () => button(f.container, "Enviar imagem").click());
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
  it("shows alt text and image controls without exposing private media identifiers", () => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift,
        disabled: false,
        onUpload: vi.fn(),
        onRemove: vi.fn(),
        onAltChange: vi.fn(),
      }),
    );
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("Descrição da imagem");
    expect(html).toContain("Mesa para o jantar");
    expect(html).toContain("Remover imagem");
    expect(html).not.toContain("private-asset");
    expect(html).not.toContain("private-gift");
  });
  it("disables all media actions with the parent catalog", () => {
    const html = renderToStaticMarkup(
      createElement(GiftImageField, {
        gift,
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
});
