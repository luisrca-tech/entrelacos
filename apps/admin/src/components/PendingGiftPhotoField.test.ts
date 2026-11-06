// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PendingGiftPhoto,
  PendingGiftPhotoField,
} from "./PendingGiftPhotoField";

const png = (name = "mesa.png") =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("new gift photo field", () => {
  let root: Root;
  let container: HTMLDivElement;
  let urls: string[];
  let revoked: string[];
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    urls = [];
    revoked = [];
    let next = 0;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const url = `blob:local-${++next}`;
        urls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  async function render(
    value: PendingGiftPhoto,
    extra: Partial<Parameters<typeof PendingGiftPhotoField>[0]> = {},
  ) {
    const props = {
      value,
      position: 3,
      disabled: false,
      onChange: vi.fn(),
      ...extra,
    };
    await act(async () =>
      root.render(createElement(PendingGiftPhotoField, props)),
    );
    return props;
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(label),
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }
  function fileInput() {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    return input;
  }
  async function choose(selected: File) {
    const input = fileInput();
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [selected],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("offers a clickable, keyboard-reachable picker before the gift exists", async () => {
    await render({ file: null, alt: "" });
    expect(container.textContent).not.toContain("Salve o rascunho");
    const click = vi.spyOn(fileInput(), "click");
    const pick = button("Escolher foto");
    expect(pick.disabled).toBe(false);
    await act(async () => pick.click());
    expect(click).toHaveBeenCalledOnce();
    expect(fileInput().accept).toBe("image/jpeg,image/png,image/webp");
  });

  it("keeps a valid picked or dropped file and rejects other files", async () => {
    const props = await render({ file: null, alt: "Mesa" });
    const selected = png();
    await choose(selected);
    expect(props.onChange).toHaveBeenLastCalledWith({
      file: selected,
      alt: "Mesa",
    });
    await choose(new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "não é uma imagem",
    );
    await choose(new File([], "empty.png", { type: "image/png" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "vazio",
    );
    expect(props.onChange).toHaveBeenCalledOnce();
    const dropped = png("drop.png");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [dropped], types: ["Files"], dropEffect: "none" },
    });
    await act(async () => {
      container.querySelector("[data-dropzone]")?.dispatchEvent(drop);
    });
    expect(props.onChange).toHaveBeenLastCalledWith({
      file: dropped,
      alt: "Mesa",
    });
  });

  it("previews the kept file immediately and revokes its URL on change and unmount", async () => {
    const first = png("first.png");
    const props = await render({ file: first, alt: "" });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:local-1");
    expect(image?.getAttribute("alt")).toBe("Imagem do presente 3 na lista");
    expect(container.textContent).toContain("first.png");
    expect(button("Trocar foto")).toBeTruthy();
    await render(
      { file: png("second.png"), alt: "" },
      { onChange: props.onChange },
    );
    expect(revoked).toEqual(["blob:local-1"]);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:local-2",
    );
    await act(async () => root.unmount());
    expect(revoked).toEqual(["blob:local-1", "blob:local-2"]);
    root = createRoot(container);
  });

  it("describes and removes the kept file", async () => {
    const selected = png();
    const props = await render({ file: selected, alt: "" });
    const input = container.querySelector<HTMLInputElement>(
      'input:not([type="file"])',
    );
    if (!input) throw new Error("Missing description input");
    expect(container.textContent).toContain("· Opcional");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "Mesa posta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(props.onChange).toHaveBeenLastCalledWith({
      file: selected,
      alt: "Mesa posta",
    });
    await act(async () => button("Remover").click());
    expect(props.onChange).toHaveBeenLastCalledWith({ file: null, alt: "" });
  });

  it("shows the upload failure and offers an upload-only retry", async () => {
    const retry = vi.fn();
    await render(
      { file: png(), alt: "" },
      {
        error:
          "O presente foi salvo, mas a foto não foi enviada. Tente enviar de novo.",
        onRetry: retry,
      },
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "O presente foi salvo, mas a foto não foi enviada. Tente enviar de novo.",
    );
    await act(async () => button("Enviar foto de novo").click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("blocks every action while the gift is being saved", async () => {
    await render(
      { file: png(), alt: "" },
      { disabled: true, uploading: true, onRetry: vi.fn() },
    );
    for (const item of container.querySelectorAll("button"))
      expect(item.disabled).toBe(true);
    expect(fileInput().disabled).toBe(true);
    expect(container.textContent).toContain("Enviando foto…");
  });
});
