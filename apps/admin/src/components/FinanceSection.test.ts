// @vitest-environment jsdom
import type {
  GiftPurchaseHistoryDetailPage,
  GiftPurchaseHistoryPage,
  MeResponse,
  SiteAccess,
} from "@entrelacos/contracts";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FinanceSection } from "./FinanceSection";
import type { HistoryPorts } from "./giftPaymentHistory";
import { createPanelActorOwner } from "./panelActor";

vi.mock("./WithdrawalSetup", () => ({
  WithdrawalSetup: ({ sessionEpoch }: { sessionEpoch: number | null }) =>
    createElement("div", { "data-withdrawal-epoch": sessionEpoch }),
}));

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};

describe("finance section composition", () => {
  it("shows OWNER read surfaces while withholding the withdrawal setup entirely", () => {
    const selected: SiteAccess = {
      ...access,
      userId: "owner-one",
      membershipRole: "OWNER",
      membershipId: null,
      capabilities: {
        ...access.capabilities,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    const html = renderToStaticMarkup(
      createElement(FinanceSection, {
        siteId: "wedding-a",
        access: selected,
        sessionEpoch: 7,
      }),
    );
    expect(html).toContain("Consultando o financeiro");
    expect(html).toContain("Consultando o histórico de saques");
    expect(html).not.toMatch(
      /data-withdrawal-epoch|<form|<input|Solicitar saque|Confirme sua senha/,
    );
  });
  it("propagates only a real nullable verified epoch to the withdrawal caller", () => {
    const render = (sessionEpoch: number | null, candidate = access) =>
      renderToStaticMarkup(
        createElement(FinanceSection, {
          siteId: "wedding-a",
          access: candidate,
          sessionEpoch,
        }),
      );
    expect(render(null)).not.toContain("data-withdrawal-epoch");
    expect(render(7)).toContain('data-withdrawal-epoch="7"');
    expect(render(7, { ...access, siteId: "foreign" })).not.toContain(
      "data-withdrawal-epoch",
    );
    expect(
      render(7, { ...access, membershipRole: "SITE_ASSISTANT" }),
    ).not.toContain("data-withdrawal-epoch");
  });
  it("loads overview and history separately without guessed zero values or actions", () => {
    const html = renderToStaticMarkup(
      createElement(FinanceSection, { siteId: "wedding-a", access }),
    );
    expect(html).toContain("Consultando o financeiro");
    expect(html).toContain("Consultando o histórico de saques");
    expect(html).not.toMatch(
      /R\$|Nenhum saque|Solicitar saque|Refazer saque|Recebido no banco/,
    );
  });
  it.each([
    null,
    { ...access, siteId: "wedding-b" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipId: null },
    { ...access, capabilities: { ...access.capabilities, readFinance: false } },
  ])(
    "keeps both finance surfaces restricted for invalid authority",
    (candidate) => {
      const html = renderToStaticMarkup(
        createElement(FinanceSection, {
          siteId: "wedding-a",
          access: candidate as SiteAccess | null,
        }),
      );
      expect(html).toContain("Acesso financeiro restrito");
      expect(html).not.toMatch(/R\$|Consultando|Nenhum saque|<button/);
    },
  );
});

describe("gift history finance integration", () => {
  it("composes the real scoped reader and keeps existing financial children through read failures and navigation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    const now = Date.parse("2026-10-13T16:00:00Z");
    const actor: MeResponse = {
      user: {
        id: access.userId,
        name: "Admin",
        email: "admin@example.test",
        role: "SITE_ADMIN",
      },
      session: { id: "session-a", expiresAt: "2026-10-20T16:00:00Z" },
      siteId: access.siteId,
      memberships: [access],
    };
    const owner = createPanelActorOwner({
      request: async () => structuredClone(actor),
      now: () => now,
    });
    await owner.load();
    const original = {
      siteId: access.siteId,
      mode: "sandbox" as const,
      orderId: "order-a",
      quoteId: "quote-a",
      giftId: "gift-a",
      titleSnapshot: "Presente preservado",
      method: "PIX" as const,
      currency: "BRL" as const,
      purchasedAtMicros: "100",
      destinationVersion: 1,
      policyVersion: "policy-a",
      binding: "AVAILABLE" as const,
      quoted: {
        nominalCents: 10000,
        commissionCents: 1000,
        processingCents: 0,
        totalCents: 11000,
      },
    };
    const page: GiftPurchaseHistoryPage = {
      scope: { siteId: access.siteId, mode: "sandbox", policy: "SITE_HISTORY" },
      consistency: "PER_READ",
      readObservedAtMicros: "10000",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
      nextCursor: null,
      items: [original],
    };
    const { items: _items, ...envelope } = page;
    const detail: GiftPurchaseHistoryDetailPage = {
      ...envelope,
      originalPurchase: original,
      coverage: {
        payments: "AVAILABLE",
        receipts: "AVAILABLE",
        reversals: "UNAVAILABLE",
        bankSettlement: "UNAVAILABLE",
      },
      retainedPayments: [],
      validatedHistoricalReceipts: [],
    };
    let reply: unknown = { history: page };
    const request = vi.fn<NonNullable<HistoryPorts["request"]>>(
      async () => reply,
    );
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    try {
      await act(async () =>
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(FinanceSection, {
              siteId: access.siteId,
              access,
              sessionEpoch: owner.getSnapshot().sessionEpoch,
              historyPorts: { owner, request, now: () => now },
            }),
          ),
        ),
      );
      expect(node.textContent).toContain("Presente preservado");
      const withdrawal = node.querySelector(
        "[data-withdrawal-epoch]",
      ) as HTMLElement;
      expect(withdrawal).toBeTruthy();
      withdrawal.dataset.proof = "same-proof";
      withdrawal.dataset.deadline = "unchanged-deadline";
      withdrawal.dataset.marker = "same-marker";
      withdrawal.dataset.busy = "owned";
      const click = async (label: string) => {
        const button = [...node.querySelectorAll("button")].find(
          (value) => value.textContent === label,
        );
        expect(button).toBeTruthy();
        await act(async () => button?.click());
      };
      reply = { history: detail };
      await click("Ver histórico desta compra");
      request.mockRejectedValueOnce(new Error("unavailable"));
      await click("Reiniciar navegação do detalhe");
      await click("Tentar consulta novamente");
      await click("Fechar detalhe");
      reply = { history: page };
      await click("Reiniciar navegação das compras");
      expect(node.querySelector("[data-withdrawal-epoch]")).toBe(withdrawal);
      expect(withdrawal.dataset).toMatchObject({
        proof: "same-proof",
        deadline: "unchanged-deadline",
        marker: "same-marker",
        busy: "owned",
      });
      expect(writes).not.toHaveBeenCalled();
      expect(
        request.mock.calls.every(([path]) =>
          path.startsWith("/v1/sites/wedding-a/finance/purchases"),
        ),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
      owner.dispose();
      node.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
