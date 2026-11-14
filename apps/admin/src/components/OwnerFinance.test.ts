// @vitest-environment jsdom
import type {
  OwnerFinanceAlert,
  OwnerFinanceGift,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import {
  alertListPath,
  emptyGiftFilters,
  formatAlertDate,
  formatPaymentMethod,
  giftFilterParams,
  OwnerFinance,
} from "./OwnerFinance";

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));

const request = vi.mocked(apiRequest);

const gift: OwnerFinanceGift = {
  orderId: "order-1",
  siteId: "site-1",
  siteName: "Ana & Bia",
  environment: "live",
  paidAt: "2026-10-10T15:00:00.000Z",
  giftTitle: "Jantar romântico",
  method: "CREDIT_CARD",
  installmentCount: 3,
  grossCents: 10600,
  coupleCreditedCents: 3334,
  coupleExpectedCents: 10000,
  creditedInstallments: 1,
  estimatedCommissionCents: 200,
  netCommissionCents: 60,
  status: "PARTIALLY_RECEIVED",
};

const alert: OwnerFinanceAlert = {
  id: "alert-1",
  kind: "SPLIT_DIVERGENCE_BLOCK",
  severity: "critical",
  environment: "live",
  siteId: "site-1",
  siteName: "Ana & Bia",
  paymentReference: "pay_123",
  amountCents: 10239,
  createdAt: "2026-10-14T12:00:00.000Z",
  dueAt: "2026-10-16T12:00:00.000Z",
  asaasPaymentUrl: "https://www.asaas.com/payment/show/123",
  resolvedAt: null,
  resolvedNote: null,
};

describe("owner finance helpers", () => {
  it("formats dates in Sao Paulo time and shows a dash for none", () => {
    expect(formatAlertDate(null)).toBe("—");
    expect(formatAlertDate("2026-10-14T12:00:00.000Z")).toContain("14/10/2026");
  });

  it("labels Pix and card installments", () => {
    expect(formatPaymentMethod({ method: "PIX", installmentCount: 1 })).toBe(
      "Pix",
    );
    expect(
      formatPaymentMethod({ method: "CREDIT_CARD", installmentCount: 3 }),
    ).toBe("Cartão 3x");
  });

  it("builds gift filters with whole Brasília days and repeated sites", () => {
    expect(giftFilterParams(emptyGiftFilters).toString()).toBe("");
    expect(
      giftFilterParams({
        siteIds: ["site-1", "site-2"],
        from: "2026-10-01",
        to: "2026-10-31",
        method: "PIX",
        status: "RECEIVED",
      }).toString(),
    ).toBe(
      "siteId=site-1&siteId=site-2&from=2026-10-01T00%3A00%3A00.000-03%3A00&to=2026-10-31T23%3A59%3A59.999-03%3A00&method=PIX&status=RECEIVED",
    );
  });

  it("builds the alert list path", () => {
    expect(
      alertListPath({ status: "resolved", siteIds: ["site-1"], cursor: "1_a" }),
    ).toBe("/v1/owner/finance/alerts?status=resolved&siteId=site-1&cursor=1_a");
  });
});

describe("OwnerFinance screen", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    request.mockReset();
    request.mockImplementation(async (path, options) => {
      if (path === "/v1/owner/finance/sites")
        return { sites: [{ id: "site-1", name: "Ana & Bia" }] };
      if (path.startsWith("/v1/owner/finance/summary"))
        return {
          giftCount: 1,
          grossChargedCents: 10600,
          coupleCreditedCents: 3334,
          estimatedCommissionCents: 200,
          netCommissionCents: 60,
          commissionDifferenceCents: 0,
        };
      if (path.startsWith("/v1/owner/finance/gifts"))
        return { gifts: [gift], nextCursor: null };
      if (path.startsWith("/v1/owner/finance/alerts?"))
        return {
          alerts: [alert],
          nextCursor: null,
          openCount: 1,
          criticalOpenCount: 1,
        };
      if (options?.method === "POST") return undefined;
      throw new Error(`Unexpected request ${path}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  });

  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.startsWith(label),
    );
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  async function select(label: string, value: string) {
    const field = [...container.querySelectorAll("label")]
      .find((entry) => entry.textContent?.startsWith(label))
      ?.querySelector("select");
    if (!field) throw new Error(`Select not found: ${label}`);
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(field, value);
    await act(async () =>
      field.dispatchEvent(new Event("change", { bubbles: true })),
    );
  }

  it("shows paid gifts with filtered totals and no anticipation column", async () => {
    await act(async () => root.render(createElement(OwnerFinance)));
    const text = container.textContent ?? "";
    expect(text).toContain("Financeiro Entrelaços");
    expect(text).toContain("Jantar romântico");
    expect(text).toContain("Cartão 3x");
    expect(text).toContain("1/3 parcelas");
    expect(text).toContain("Recebido parcialmente");
    expect(text).toContain("Comissão líquida real");
    expect(text.toLowerCase()).not.toContain("antecipação");

    await select("Forma de pagamento", "CREDIT_CARD");
    await select("Situação", "IN_REVIEW");
    const paths = request.mock.calls.map(([path]) => path);
    expect(paths).toContain(
      "/v1/owner/finance/summary?method=CREDIT_CARD&status=IN_REVIEW",
    );
    expect(paths).toContain(
      "/v1/owner/finance/gifts?method=CREDIT_CARD&status=IN_REVIEW",
    );
  });

  it("lists alerts in their own tab and resolves one with a note", async () => {
    await act(async () => root.render(createElement(OwnerFinance)));
    await act(async () => button("Alertas").click());
    expect(container.textContent).toContain("Divergência no split");
    expect(request).toHaveBeenCalledWith(
      "/v1/owner/finance/alerts?status=open",
    );

    await act(async () => button("Resolvidos").click());
    expect(request).toHaveBeenCalledWith(
      "/v1/owner/finance/alerts?status=resolved",
    );
    await act(async () => button("Abertos").click());

    await act(async () => button("Marcar resolvido").click());
    const note = container.querySelector<HTMLInputElement>("#note-alert-1");
    if (!note) throw new Error("Expected note field");
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(note, "Conferido no Asaas");
    await act(async () =>
      note.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await act(async () => button("Confirmar").click());
    expect(request).toHaveBeenCalledWith(
      "/v1/owner/finance/alerts/alert-1/resolve",
      { method: "POST", body: { note: "Conferido no Asaas" } },
    );
  });
});
