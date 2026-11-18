// @vitest-environment jsdom
import {
  allocateGiftInstallmentCents,
  type GiftQuote,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftQuoteView } from "./GiftQuoteView";

const now = new Date("2026-10-12T12:00:00.000Z");
const totals = [10_521, 10_870, 11_010, 11_150, 11_300, 11_450, 11_600];
const options = totals.map((totalCents, index) => ({
  installmentCount: index + 1,
  totalCents,
  installmentSurchargeCents: totalCents - totals[0],
  installmentCents: allocateGiftInstallmentCents(totalCents, index + 1),
}));
const cardQuote: GiftQuote = {
  id: "quote-card",
  giftId: "gift-1",
  siteId: "site-1",
  title: "Jantar especial",
  method: "CREDIT_CARD",
  currency: "BRL",
  nominalCents: 10_000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 321,
  totalCents: 10_521,
  feeAllocation: "BUYER_GROSS_UP",
  settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
  policyVersion: "policy-1",
  expiresAt: "2026-10-12T15:30:00.000Z",
  mode: "sandbox",
  installmentCount: 1,
  installmentCents: [10_521],
  installmentSurchargeCents: 0,
  installmentOptions: options,
};
const pixQuote: GiftQuote = {
  ...cardQuote,
  id: "quote-pix",
  method: "PIX",
  installmentCount: undefined,
  installmentCents: undefined,
  installmentSurchargeCents: undefined,
  installmentOptions: undefined,
};

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__APP_ENV__", "development");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<Parameters<typeof GiftQuoteView>[0]> = {}) {
  const onConfirm = vi.fn();
  act(() =>
    root.render(
      createElement(GiftQuoteView, {
        quote: cardQuote,
        method: "CREDIT_CARD",
        installmentCount: 1,
        loading: false,
        pending: false,
        onSelectMethod: vi.fn(),
        onConfirm,
        onCancel: vi.fn(),
        now,
        ...props,
      }),
    ),
  );
  return onConfirm;
}

function field(label: string): HTMLInputElement {
  const match = [...container.querySelectorAll("label")].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  const input = match?.querySelector("input");
  if (!input) throw new Error(`Missing field ${label}`);
  return input;
}

function type(label: string, value: string) {
  const input = field(label);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fillBuyer() {
  type("Nome completo", "  Ana Souza ");
  type("CPF", "529.982.247-25");
  type("E-mail", "ana@example.com");
  type("Celular", "(11) 98765-4321");
}

function submit() {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("type") === "submit",
  );
  if (!button) throw new Error("Missing submit button");
  act(() => button.click());
}

describe("transparent card checkout form", () => {
  it("offers 1x to 6x with the installment value and total from the quote", () => {
    render();
    const labels = [...container.querySelectorAll("option")].map(
      (option) => option.textContent ?? "",
    );
    expect(labels).toHaveLength(6);
    expect(labels[0]).toMatch(/^1x à vista · R\$\s*105,21$/);
    expect(labels[2]).toMatch(/^3x de R\$\s*36,70 · total R\$\s*110,10$/);
    expect(labels[5]).toMatch(/^6x de R\$\s*19,08 · total R\$\s*114,50$/);
    expect(labels.join(" ")).not.toContain("7x");
  });

  it("collects the card and the buyer and hands them over only on submit", () => {
    const onConfirm = render();
    for (const label of [
      "Número do cartão",
      "Nome impresso no cartão",
      "Validade",
      "CVV",
      "Nome completo",
      "CPF",
      "E-mail",
      "Celular",
    ])
      expect(field(label)).toBeTruthy();
    expect(field("Número do cartão").getAttribute("autocomplete")).toBe(
      "cc-number",
    );
    expect(field("CVV").getAttribute("autocomplete")).toBe("cc-csc");
    // Card inputs carry no name, so no form serialization can pick them up.
    for (const label of ["Número do cartão", "Validade", "CVV"])
      expect(field(label).hasAttribute("name")).toBe(false);
    fillBuyer();
    type("Número do cartão", "4000 0000 0000 0010");
    type("Nome impresso no cartão", "ANA SOUZA");
    type("Validade", "12/30");
    type("CVV", "123");
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      buyer: {
        name: "Ana Souza",
        cpf: "52998224725",
        email: "ana@example.com",
        phone: "11987654321",
      },
      card: {
        number: "4000000000000010",
        holderName: "ANA SOUZA",
        expMonth: 12,
        expYear: 2030,
        cvv: "123",
      },
    });
    expect(container.textContent).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
  });

  it("keeps invalid buyer or card data in the form", () => {
    const onConfirm = render();
    fillBuyer();
    type("CPF", "111.111.111-11");
    type("Número do cartão", "4000 0000 0000 0010");
    type("Nome impresso no cartão", "ANA SOUZA");
    type("Validade", "12/30");
    type("CVV", "123");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "CPF",
    );
    type("CPF", "529.982.247-25");
    type("Validade", "13/30");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "validade",
    );
  });
});

describe("Pix checkout form", () => {
  it("asks only for the buyer and generates the Pix", () => {
    const onConfirm = render({ quote: pixQuote, method: "PIX" });
    expect(() => field("Número do cartão")).toThrow();
    expect(container.querySelector("select")).toBeNull();
    fillBuyer();
    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      buyer: {
        name: "Ana Souza",
        cpf: "52998224725",
        email: "ana@example.com",
        phone: "11987654321",
      },
    });
    expect(container.textContent).toContain("Gerar Pix");
  });
});
