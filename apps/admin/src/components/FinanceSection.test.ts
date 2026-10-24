// @vitest-environment jsdom
import type {
  FinancialOverview,
  GiftPurchaseHistoryDetailPage,
  GiftPurchaseHistoryPage,
  MeResponse,
  SiteAccess,
  WithdrawalIntent,
} from "@entrelacos/contracts";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FinanceSection } from "./FinanceSection";
import * as financialOverview from "./financialOverview";
import type { HistoryPorts } from "./giftPaymentHistory";
import { createPanelActorOwner } from "./panelActor";
import * as withdrawalHistory from "./withdrawalHistory";

const withdrawalSignals = vi.hoisted(() => ({
  callbacks: [] as Array<(() => void) | undefined>,
}));

vi.mock("./WithdrawalSetup", () => ({
  WithdrawalSetup: ({
    sessionEpoch,
    onFinancialChange,
  }: {
    sessionEpoch: number | null;
    onFinancialChange?: () => void;
  }) => {
    withdrawalSignals.callbacks.push(onFinancialChange);
    return createElement("div", { "data-withdrawal-epoch": sessionEpoch });
  },
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
        page: "withdrawals",
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
          page: "withdrawals",
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
      createElement(FinanceSection, {
        page: "withdrawals",
        siteId: "wedding-a",
        access,
      }),
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
          page: "withdrawals",
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
              page: "payments",
              siteId: access.siteId,
              access,
              sessionEpoch: owner.getSnapshot().sessionEpoch,
              historyPorts: { owner, request, now: () => now },
            }),
          ),
        ),
      );
      expect(node.textContent).toContain("Presente preservado");
      expect(node.querySelector("[data-withdrawal-epoch]")).toBeNull();
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
      await click("Consultar histórico novamente");
      await click("Tentar consulta novamente");
      await click("Fechar detalhe");
      reply = { history: page };
      await click("Consultar compras");
      expect(node.querySelector("[data-withdrawal-epoch]")).toBeNull();
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

describe("withdrawal settlement read invalidation", () => {
  const overview: FinancialOverview = {
    siteId: access.siteId,
    currency: "BRL",
    nominalReceivedCents: 10000,
    netReceivedCents: 10000,
    processingCents: 100,
    commissionCents: 200,
    awaitingReleaseCents: 10000,
    availableCents: null,
    pendingCommitmentsCents: 0,
    withdrawnCents: 0,
    refundedCents: 0,
    synchronizedAt: null,
    availability: "UNKNOWN",
    mode: "sandbox",
  };
  const requested: WithdrawalIntent = {
    id: "withdrawal-a",
    siteId: access.siteId,
    amountCents: 300,
    feeCents: 200,
    netCents: 100,
    destinationVersion: 1,
    currency: "BRL",
    state: "REQUESTED",
    mode: "sandbox",
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
  };
  function pending<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }
  async function setup() {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    withdrawalSignals.callbacks.length = 0;
    const overviewRead = vi
      .spyOn(financialOverview, "loadFinancialOverview")
      .mockResolvedValue(overview);
    const historyRead = vi
      .spyOn(withdrawalHistory, "loadWithdrawalHistory")
      .mockResolvedValue([]);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const render = async (
      props: Partial<Parameters<typeof FinanceSection>[0]> = {},
    ) =>
      act(async () =>
        root.render(
          createElement(FinanceSection, {
            page: "withdrawals",
            siteId: access.siteId,
            access,
            sessionEpoch: 7,
            ...props,
          }),
        ),
      );
    await render();
    return {
      node,
      root,
      render,
      overviewRead,
      historyRead,
      async cleanup() {
        await act(async () => root.unmount());
        node.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      },
    };
  }
  it("reloads overview and withdrawal history without remounting the financial action controls", async () => {
    const f = await setup();
    try {
      const child = f.node.querySelector("[data-withdrawal-epoch]");
      const signal = withdrawalSignals.callbacks.at(-1);
      expect(signal).toBeTypeOf("function");
      expect(f.node.textContent).toContain("Ainda não há saques registrados");
      f.historyRead.mockResolvedValue([requested]);
      await act(async () => signal?.());
      expect(f.overviewRead).toHaveBeenCalledTimes(2);
      expect(f.historyRead).toHaveBeenCalledTimes(2);
      expect(f.node.querySelector("[data-withdrawal-epoch]")).toBe(child);
      expect(f.node.textContent).toContain("Solicitado");
      expect(f.node.textContent).not.toContain("Concluído");
    } finally {
      await f.cleanup();
    }
  });
  it.each(["site", "access", "epoch", "denied", "owner"])(
    "ignores an old withdrawal signal after %s changes",
    async (change) => {
      const f = await setup();
      try {
        const oldSignal = withdrawalSignals.callbacks.at(-1);
        expect(oldSignal).toBeTypeOf("function");
        const nextAccess =
          change === "site"
            ? { ...access, siteId: "wedding-b" }
            : change === "access"
              ? { ...access }
              : change === "denied"
                ? null
                : change === "owner"
                  ? {
                      ...access,
                      membershipRole: "OWNER" as const,
                      membershipId: null,
                      capabilities: {
                        ...access.capabilities,
                        configureReceiving: false,
                        requestWithdrawal: false,
                      },
                    }
                  : access;
        await f.render({
          access: nextAccess,
          siteId: change === "site" ? "wedding-b" : access.siteId,
          sessionEpoch: change === "epoch" ? 8 : 7,
        });
        const calls = [
          f.overviewRead.mock.calls.length,
          f.historyRead.mock.calls.length,
        ];
        await act(async () => oldSignal?.());
        expect([
          f.overviewRead.mock.calls.length,
          f.historyRead.mock.calls.length,
        ]).toEqual(calls);
      } finally {
        await f.cleanup();
      }
    },
  );
  it("hides the previous session's history until its own fresh read settles", async () => {
    const f = await setup();
    try {
      f.historyRead.mockResolvedValue([requested]);
      await act(async () => withdrawalSignals.callbacks.at(-1)?.());
      expect(f.node.textContent).toContain("Solicitado");
      const current = pending<WithdrawalIntent[]>();
      f.historyRead.mockReturnValueOnce(current.promise);
      await f.render({ sessionEpoch: 8 });
      expect(f.node.textContent).toContain("Consultando o histórico de saques");
      expect(f.node.textContent).not.toContain("Solicitado");
      await act(async () => current.resolve([]));
      expect(f.node.textContent).toContain("Ainda não há saques registrados");
    } finally {
      await f.cleanup();
    }
  });
  it("discards an older history reply after a newer explicit status refresh", async () => {
    const f = await setup();
    try {
      const signal = withdrawalSignals.callbacks.at(-1);
      expect(signal).toBeTypeOf("function");
      const older = pending<WithdrawalIntent[]>();
      f.historyRead.mockReturnValueOnce(older.promise);
      await act(async () => signal?.());
      f.historyRead.mockResolvedValue([requested]);
      await act(async () => signal?.());
      expect(f.node.textContent).toContain("Solicitado");
      await act(async () =>
        older.resolve([{ ...requested, state: "COMPLETED" }]),
      );
      expect(f.node.textContent).toContain("Solicitado");
      expect(f.node.textContent).not.toContain("Concluído");
    } finally {
      await f.cleanup();
    }
  });
});

describe("receiving page read isolation", () => {
  it.each(["overview", "payments", "withdrawals"] as const)(
    "loads only the financial reads required by %s",
    async (page) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const overviewRead = vi
        .spyOn(financialOverview, "loadFinancialOverview")
        .mockResolvedValue(null as never);
      const historyRead = vi
        .spyOn(withdrawalHistory, "loadWithdrawalHistory")
        .mockResolvedValue([]);
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      try {
        await act(async () =>
          root.render(
            createElement(FinanceSection, {
              siteId: access.siteId,
              access,
              sessionEpoch: 7,
              page,
            }),
          ),
        );
        expect(overviewRead).toHaveBeenCalledTimes(page === "payments" ? 0 : 1);
        expect(historyRead).toHaveBeenCalledTimes(
          page === "withdrawals" ? 1 : 0,
        );
        expect(!!node.querySelector("[data-withdrawal-epoch]")).toBe(
          page === "withdrawals",
        );
        expect(!!node.querySelector("#gift-payment-history-title")).toBe(
          page === "payments",
        );
      } finally {
        await act(async () => root.unmount());
        node.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );
});
