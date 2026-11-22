// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import {
  kycQrImageSource,
  ReceivingIdentityVerification,
} from "./ReceivingIdentityVerification";

/** In-memory Web Storage: the test does not depend on the environment's. */
class MemoryStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  clear() {
    this.#items.clear();
  }
}

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
  vi.unstubAllGlobals();
});

function tabs() {
  const opened: Array<{
    navigate: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const openTab = vi.fn(() => {
    const tab = { navigate: vi.fn(), close: vi.fn() };
    opened.push(tab);
    return tab;
  });
  return { openTab, opened };
}

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
  const { openTab, opened } = tabs();
  await act(async () =>
    root.render(
      createElement(ReceivingIdentityVerification, {
        siteId: "site one",
        request,
        openTab,
      }),
    ),
  );
  return { request, openTab, opened };
}

describe("identity verification link", () => {
  it("opens the Pagar.me link in a new tab and shows its QR Code for 20 minutes", async () => {
    const { request, openTab, opened } = await mount();
    expect(container.querySelector("img")).toBeNull();
    await act(async () => button("Verificar identidade").click());
    expect(request).toHaveBeenCalledWith(
      "/v1/owner/sites/site%20one/receiving/kyc-link",
      { method: "POST", body: undefined },
    );
    expect(openTab).toHaveBeenCalledOnce();
    expect(opened[0].navigate).toHaveBeenCalledWith(
      "https://pagar.me/kyc/session-1",
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
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const setLocal = vi.spyOn(local, "setItem");
    const setSession = vi.spyOn(session, "setItem");
    const { request, opened } = await mount();
    await act(async () => button("Verificar identidade").click());
    await act(async () => button("Gerar novo link").click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(opened[1].navigate).toHaveBeenCalledWith(
      "https://pagar.me/kyc/session-2",
    );
    expect(
      container.querySelector('a[href="https://pagar.me/kyc/session-1"]'),
    ).toBeNull();
    expect(setLocal).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });

  it("explains a failed request without opening a tab", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const { openTab, opened } = tabs();
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openTab,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(opened[0].navigate).not.toHaveBeenCalled();
    expect(opened[0].close).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Não foi possível gerar o link",
    );
  });

  it("explains that Pagar.me has not released the check yet and reloads the status", async () => {
    const request = vi.fn(async () => {
      throw new ApiError(409, "RECEIVING_KYC_LINK_UNAVAILABLE", {
        code: "RECEIVING_KYC_LINK_UNAVAILABLE",
      });
    });
    const onUnavailable = vi.fn();
    const { openTab, opened } = tabs();
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openTab,
          onUnavailable,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(opened[0].navigate).not.toHaveBeenCalled();
    expect(opened[0].close).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    const message = container.querySelector('[role="status"]')?.textContent;
    expect(message).toContain(
      "A Pagar.me ainda não liberou a verificação de identidade",
    );
    expect(message).toContain("Volte mais tarde");
    expect(container.textContent).not.toContain("Tente novamente em instantes");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the generic message for any other API failure", async () => {
    const request = vi.fn(async () => {
      throw new ApiError(409, "RECEIVING_ACCOUNT_REQUIRED");
    });
    const onUnavailable = vi.fn();
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openTab: tabs().openTab,
          onUnavailable,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Não foi possível gerar o link",
    );
  });

  it("rejects a response that is not a Pagar.me verification link", async () => {
    const request = vi.fn(async () => ({ ...link(1), url: "http://x.test" }));
    const { openTab, opened } = tabs();
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openTab,
        }),
      ),
    );
    await act(async () => button("Verificar identidade").click());
    expect(opened[0].navigate).not.toHaveBeenCalled();
    expect(opened[0].close).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens the tab inside the click, before the API answers (pop-up blockers)", async () => {
    let answer: (value: unknown) => void = () => {};
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { openTab, opened } = tabs();
    await act(async () =>
      root.render(
        createElement(ReceivingIdentityVerification, {
          siteId: "site-one",
          request,
          openTab,
        }),
      ),
    );
    act(() => button("Verificar identidade").click());
    expect(openTab).toHaveBeenCalledOnce();
    expect(opened[0].navigate).not.toHaveBeenCalled();
    await act(async () => answer(link(1)));
    expect(opened[0].navigate).toHaveBeenCalledWith(
      "https://pagar.me/kyc/session-1",
    );
  });

  it("declares the QR image type from its bytes (PNG or SVG)", () => {
    expect(kycQrImageSource(qr)).toBe(`data:image/png;base64,${qr}`);
    const svg = Buffer.from('<?xml version="1.0"?><svg/>').toString("base64");
    expect(kycQrImageSource(svg)).toBe(`data:image/svg+xml;base64,${svg}`);
    const bare = Buffer.from("<svg/>").toString("base64");
    expect(kycQrImageSource(bare)).toMatch(/^data:image\/svg\+xml;/);
  });
});
