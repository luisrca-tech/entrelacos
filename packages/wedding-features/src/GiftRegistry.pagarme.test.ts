// @vitest-environment jsdom
import { allocateGiftInstallmentCents } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftRegistry } from "./GiftRegistry";

const siteId = "wedding-a";
const apiOrigin = "https://api.example.test";
const gift = {
  id: "gift-1",
  siteId,
  title: "Jantar especial",
  description: "Simbólico",
  nominalCents: 10_000,
  currency: "BRL",
  image: null,
  sortOrder: 0,
};
const catalog = {
  siteId,
  mode: "sandbox",
  page: 1,
  pageSize: 20,
  q: "",
  total: 1,
  totalPages: 1,
  hasNext: false,
  gifts: [gift],
};
const totals = [10_521, 10_870, 11_010];
function quote(method: "PIX" | "CREDIT_CARD", installmentCount = 1) {
  const options = totals.map((totalCents, index) => ({
    installmentCount: index + 1,
    totalCents,
    installmentSurchargeCents: totalCents - totals[0],
    installmentCents: allocateGiftInstallmentCents(totalCents, index + 1),
  }));
  const selected = options[installmentCount - 1];
  return {
    quote: {
      id: `quote-${method}-${installmentCount}`,
      giftId: gift.id,
      siteId,
      title: gift.title,
      method,
      currency: "BRL",
      nominalCents: 10_000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: (selected?.totalCents ?? totals[0]) - 10_200,
      totalCents: method === "PIX" ? totals[0] : selected?.totalCents,
      feeAllocation: "BUYER_GROSS_UP",
      settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
      policyVersion: "policy-1",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      mode: "sandbox",
      ...(method === "CREDIT_CARD" && selected
        ? { ...selected, installmentOptions: options }
        : {}),
    },
  };
}
const pix = {
  qrCode: "00020101021226820014br.gov.bcb.pix",
  qrCodeUrl: "https://api.pagar.me/core/v5/qr.png",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let statusState: string;
function fetcher(options: { checkoutStatus: string; withPix?: boolean }) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.pagar.me/core/v5/tokens"))
      return Response.json({ id: "token_card123", type: "card" });
    const resource = new URL(url).pathname.split("/").slice(5).join("/");
    if (resource === "gifts")
      // The catalog reader accepts only a native byte stream.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              Uint8Array.from(
                new TextEncoder().encode(JSON.stringify(catalog)),
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (resource === "gift-quotes")
      return Response.json(quote(body.method, body.installmentCount ?? 1));
    if (resource === "gift-checkouts")
      return Response.json({
        checkoutId: "checkout-1",
        status: options.checkoutStatus,
        ...(options.withPix ? { pix } : {}),
      });
    if (resource === "gift-checkouts/status")
      return Response.json({
        status: {
          siteId,
          quoteId: body.quoteId,
          requestId: body.requestId,
          checkoutId: "checkout-1",
          method: options.withPix ? "PIX" : "CREDIT_CARD",
          mode: "sandbox",
          state: statusState,
          observedAt: new Date().toISOString(),
          closedReason: null,
          mayStartNewAttempt: false,
          pix:
            statusState === "AWAITING_PAYMENT" && options.withPix ? pix : null,
        },
      });
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  });
}

let root: Root;
let surface: HTMLElement;
const toasts: string[] = [];
const recordToast = (event: Event) =>
  toasts.push((event as CustomEvent<{ message: string }>).detail.message);
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function settle() {
  await act(async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  });
}
beforeEach(() => {
  calls = [];
  toasts.length = 0;
  statusState = "AWAITING_PAYMENT";
  window.sessionStorage.clear();
  window.addEventListener("entrelacos:toast", recordToast);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const name of ["showModal", "close"] as const)
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = name === "showModal";
        if (name === "close") this.dispatchEvent(new Event("close"));
      },
    });
  surface = document.createElement("section");
  surface.dataset.giftSection = "";
  document.body.append(surface);
  root = createRoot(surface);
});
afterEach(async () => {
  await act(async () => root.unmount());
  surface.remove();
  window.removeEventListener("entrelacos:toast", recordToast);
  vi.unstubAllGlobals();
});

async function mount(fetch: typeof globalThis.fetch) {
  await act(async () =>
    root.render(
      createElement(GiftRegistry, {
        siteId,
        apiOrigin,
        fetcher: fetch,
        pagarmePublicKey: "pk_test_public1",
      }),
    ),
  );
  await settle();
}
async function clickButton(label: string) {
  const button = [...surface.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
  await settle();
}
async function type(label: string, value: string) {
  const input = [...surface.querySelectorAll("label")]
    .find((element) => element.textContent?.trim().startsWith(label))
    ?.querySelector("input");
  if (!input) throw new Error(`Missing field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillBuyer() {
  await type("Nome completo", "Ana Souza");
  await type("CPF", "529.982.247-25");
  await type("E-mail", "ana@example.com");
  await type("Celular", "11 98765-4321");
}
async function submit() {
  const button = [...surface.querySelectorAll("button")].find(
    (element) => element.getAttribute("type") === "submit",
  );
  if (!button) throw new Error("Missing submit");
  await act(async () => button.click());
  await settle();
}

describe("transparent checkout on the couple site", () => {
  it("tokenizes the card with Pagar.me and sends our API only the token", async () => {
    statusState = "RECEIVED";
    const fetch = fetcher({ checkoutStatus: "RECEIVED" });
    await mount(fetch);
    await clickButton("Escolher presente");
    await clickButton("Cartão de crédito");
    await fillBuyer();
    await type("Número do cartão", "4000 0000 0000 0010");
    await type("Nome impresso no cartão", "ANA SOUZA");
    await type("Validade", "12/30");
    await type("CVV", "123");
    await submit();

    const token = calls.find((call) => call.url.includes("api.pagar.me"));
    expect(token?.url).toBe(
      "https://api.pagar.me/core/v5/tokens?appId=pk_test_public1",
    );
    const checkout = calls.find((call) => call.url.endsWith("/gift-checkouts"));
    const body = JSON.parse(String(checkout?.init?.body));
    expect(body).toMatchObject({
      method: "CREDIT_CARD",
      installments: 1,
      cardToken: "token_card123",
      buyer: { cpf: "52998224725", phone: "11987654321" },
    });
    const ownApi = calls
      .filter((call) => call.url.startsWith(apiOrigin))
      .map((call) => String(call.init?.body ?? ""))
      .join("\n");
    expect(ownApi).not.toContain("4000000000000010");
    expect(ownApi).not.toMatch(/"cvv"|"number"|"holder_name"/);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toMatch(
      /4000000000000010|cvv|token_card123|52998224725/,
    );
    expect(toasts).toContain("Pagamento confirmado. Obrigado pelo presente!");
  });

  it("shows the Pix QR right after creation and keeps the recovery identity only", async () => {
    const fetch = fetcher({
      checkoutStatus: "AWAITING_PAYMENT",
      withPix: true,
    });
    await mount(fetch);
    await clickButton("Escolher presente");
    await clickButton("Pix");
    await fillBuyer();
    await submit();
    expect(calls.some((call) => call.url.includes("api.pagar.me"))).toBe(false);
    const dialog = surface.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="gift-payment-heading"]',
    );
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("Pix copia e cola");
    expect(dialog?.innerHTML).toContain(pix.qrCodeUrl);
    const stored = JSON.parse(
      window.sessionStorage.getItem(
        "entrelacos:pending-gift-checkout:wedding-a",
      ) ?? "{}",
    );
    expect(Object.keys(stored).sort()).toEqual(
      [
        "giftId",
        "method",
        "mode",
        "quoteId",
        "recoveryToken",
        "requestId",
      ].sort(),
    );
  });
});
