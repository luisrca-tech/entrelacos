// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceivingIdentityVerification } from "./ReceivingIdentityVerification";

const qr =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
function link(index: number) {
  return {
    url: `https://pagar.me/kyc/session-${index}`,
    base64QrCode: qr,
    expiresAt: "2026-11-18T15:20:00.000Z",
  };
}

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

async function mount() {
  let count = 0;
  const request = vi.fn(async () => link(++count));
  const openWindow = vi.fn(() => null);
  await act(async () =>
    root.render(
      createElement(ReceivingIdentityVerification, {
        siteId: "site one",
        request,
        openWindow,
      }),
    ),
  );
  return { request, openWindow };
}

describe("identity verification link", () => {
  it("opens the Pagar.me link in a new tab and shows its QR Code for 20 minutes", async () => {
    const { request, openWindow } = await mount();
    expect(container.querySelector("img")).toBeNull();
    await act(async () => button("Verificar identidade").click());
    expect(request).toHaveBeenCalledWith(
      "/v1/owner/sites/site%20one/receiving/kyc-link",
      { method: "POST", body: undefined },
    );
    expect(openWindow).toHaveBeenCalledWith(
      "https://pagar.me/kyc/session-1",
      "_blank",
      "noopener,noreferrer",
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(`data:image/png;base64,${qr}`);
    expect(image?.getAttribute("alt")).toContain("QR Code");
    expect(container.textContent).toContain("20 minutos");
    const fallback = container.querySelector<HTMLAnchorElement>(
      'a[href="https://pagar.me/kyc/session-1"]',
    );
    expect(fallback?.target).toBe("_blank");
    expect(fallback?.rel).toBe("noopener noreferrer");
  });

  it("asks Pagar.me for a new link on every click and stores nothing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { request, openWindow } = await mount();
    await act(async () => button("Verificar identidade").click());
    await act(async () => button("Gerar novo link").click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(openWindow).toHaveBeenLastCalledWith(
      "https://pagar.me/kyc/session-2",
      "_blank",
      "noopener,noreferrer",
    );
    expect(
      container.querySelector('a[href="https://pagar.me/kyc/session-1"]'),
    ).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("explains a failed request without opening a tab", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const openWindow = vi.fn(() => null);
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openWindow,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(openWindow).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Não foi possível gerar o link",
    );
  });

  it("rejects a response that is not a Pagar.me verification link", async () => {
    const request = vi.fn(async () => ({ ...link(1), url: "http://x.test" }));
    const openWindow = vi.fn(() => null);
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openWindow,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(openWindow).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });
});
