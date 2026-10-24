// @vitest-environment jsdom

import type {
  GiftPurchaseHistoryDetailPage,
  GiftPurchaseHistoryPage,
  MeResponse,
  SiteAccess,
} from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui";
import {
  act,
  createElement,
  Fragment,
  StrictMode,
  useInsertionEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GiftPaymentHistoryView } from "./GiftPaymentHistoryView";
import type { HistoryPorts } from "./giftPaymentHistory";
import { createPanelActorOwner } from "./panelActor";

const now = Date.parse("2026-10-13T16:00:00Z");
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
const actor: MeResponse = {
  user: {
    id: "admin-a",
    name: "Admin",
    email: "admin@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2026-10-20T16:00:00Z" },
  siteId: access.siteId,
  memberships: [access],
};
const original = {
  siteId: access.siteId,
  mode: "sandbox" as const,
  orderId: "order-a",
  quoteId: "quote-a",
  giftId: "gift-a",
  titleSnapshot: "Lua de mel privada",
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
  items: [original],
  nextCursor: null,
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
  retainedPayments: [
    {
      paymentId: "payment-a",
      attemptId: "attempt-a",
      orderId: "order-a",
      currency: "BRL",
      recordedState: "RESTRICTED",
      createdAtMicros: "200",
      observedAtMicros: null,
      grossCents: null,
      processingCents: 0,
      commissionCents: null,
      recipientNetCents: null,
    },
  ],
  validatedHistoricalReceipts: [
    {
      effectId: "effect-a",
      paymentId: "payment-earlier",
      orderId: "order-a",
      currency: "BRL",
      recipientCreditCents: 10000,
      postedAtMicros: "400",
      sourceObservedAtMicros: "300",
      source: "CORRELATED_STORED_POSTING",
    },
  ],
};
const roots: Root[] = [],
  owners: ReturnType<typeof createPanelActorOwner>[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const owner of owners.splice(0)) owner.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mounted(strict = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const owner = createPanelActorOwner({
    request: async () => structuredClone(actor),
    now: () => now,
  });
  owners.push(owner);
  await owner.load();
  let reply: unknown = { history: page };
  const request = vi.fn(async () => reply);
  const ports: HistoryPorts = { owner, request, now: () => now };
  let props = {
    siteId: access.siteId,
    access: structuredClone(access) as SiteAccess | null,
    sessionEpoch: owner.getSnapshot().sessionEpoch,
    ports,
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  const beforeEffects: string[] = [];
  function BeforeEffects() {
    useInsertionEffect(() => {
      beforeEffects.push(node.textContent ?? "");
    });
    return null;
  }
  async function render(next = props) {
    props = next;
    await act(async () =>
      root.render(
        strict
          ? createElement(
              StrictMode,
              null,
              createElement(
                Fragment,
                null,
                createElement(GiftPaymentHistoryView, props),
                createElement(BeforeEffects),
              ),
            )
          : createElement(
              Fragment,
              null,
              createElement(GiftPaymentHistoryView, props),
              createElement(BeforeEffects),
            ),
      ),
    );
  }
  await render();
  return {
    node,
    owner,
    request,
    ports,
    props,
    render,
    beforeEffects,
    setReply(value: unknown) {
      reply = value;
    },
  };
}
async function click(node: HTMLElement, label: string) {
  const button = [...node.querySelectorAll("button")].find(
    (value) => value.textContent === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button?.click());
}
describe("mounted gift history", () => {
  it("does not announce an API failure during a successful initial mount", async () => {
    const error = vi.spyOn(toast, "error");
    const f = await mounted(true);
    expect(f.node.textContent).toContain("Lua de mel privada");
    expect(error).not.toHaveBeenCalled();
  });
  it("denies SSR private data and props-only authority", () => {
    const html = renderToStaticMarkup(
      createElement(GiftPaymentHistoryView, {
        siteId: access.siteId,
        access,
        sessionEpoch: 7,
      }),
    );
    expect(html).toContain("Acesso financeiro restrito");
    expect(html).not.toMatch(/Lua de mel|R\$|<button/);
  });
  it("mounts once under StrictMode and separates quote, samples, receipts and unknown current state", async () => {
    const f = await mounted(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.node.textContent).toContain("Lua de mel privada");
    f.setReply({ history: detail });
    await click(f.node, "Ver histórico desta compra");
    expect(f.node.textContent).toContain("Valores da cotação");
    expect(f.node.textContent).toContain("Observação retida nesta consulta");
    expect(f.node.textContent).toContain(
      "Recebimento histórico registrado no razão",
    );
    expect(f.node.textContent).toContain(
      "Situação financeira atual não confirmada",
    );
    expect(f.node.textContent).toContain("Não registrado");
    expect(f.node.textContent).toContain("0,00");
    expect(f.node.textContent).not.toMatch(
      /Saldo disponível|Reembolso disponível|Recebido no banco/,
    );
  });
  it("retains receipt after close/reopen, retry and explicit navigation restart", async () => {
    const f = await mounted();
    f.setReply({ history: detail });
    await click(f.node, "Ver histórico desta compra");
    expect(f.node.textContent).toContain("Crédito histórico");
    await click(f.node, "Fechar detalhe");
    f.setReply({
      history: {
        ...detail,
        retainedPayments: [],
        validatedHistoricalReceipts: [],
      },
    });
    await click(f.node, "Ver histórico desta compra");
    expect(f.node.textContent).toContain("Crédito histórico");
    f.request.mockRejectedValueOnce(new Error("private upstream secret"));
    await click(f.node, "Consultar histórico novamente");
    expect(f.node.textContent).toContain("Crédito histórico");
    expect(f.node.textContent).not.toContain("private upstream");
    await click(f.node, "Tentar consulta novamente");
    expect(f.node.textContent).toContain("Crédito histórico");
  });
  it("masks before effects on site/access/session replacement and native invalidation", async () => {
    const f = await mounted();
    expect(f.node.textContent).toContain("Lua de mel privada");
    await f.render({
      ...f.props,
      access: {
        ...access,
        capabilities: { ...access.capabilities, readFinance: false },
      },
    });
    expect(f.beforeEffects.at(-1)).not.toMatch(/Lua de mel|R\$/);
    expect(f.node.textContent).not.toMatch(/Lua de mel|R\$/);
    expect(f.node.textContent).toContain("Acesso financeiro restrito");
    await f.render(f.props);
    await act(async () => f.owner.invalidate(false));
    expect(f.node.textContent).not.toMatch(/Lua de mel|R\$/);
  });
  it("rebinds same-object ports without losing facts or resetting64 admissions", async () => {
    const f = await mounted(true);
    f.ports.request = vi.fn(async () => ({ history: { ...page, items: [] } }));
    await f.render();
    expect(f.node.textContent).toContain("Lua de mel privada");
    await click(f.node, "Consultar compras");
    expect(f.node.textContent).toContain("Lua de mel privada");
    expect(f.ports.request).toHaveBeenCalledTimes(1);
    expect(f.node.textContent).toContain("2 de 64");
  });
  it("masks late native-getter access changes in the committed DOM before effects", async () => {
    let exercised = 0;
    for (let boundary = 1; boundary <= 20; boundary++) {
      const f = await mounted();
      const native = f.owner.getSnapshot;
      let reads = 0,
        changed = false;
      Object.defineProperty(f.owner, "getSnapshot", {
        configurable: true,
        get() {
          if (++reads === boundary) {
            changed = true;
            if (f.props.access) f.props.access.capabilities.readFinance = false;
          }
          return native;
        },
      });
      await f.render();
      if (changed) {
        exercised++;
        expect(
          f.beforeEffects.at(-1),
          `render native getter ${boundary}`,
        ).not.toMatch(/Lua de mel|R\$/);
        expect(f.node.textContent).not.toMatch(/Lua de mel|R\$/);
      }
    }
    expect(exercised).toBeGreaterThan(1);
  });
  it("does not traverse empty fresh cursors automatically", async () => {
    const f = await mounted();
    f.setReply({ history: { ...page, items: [], nextCursor: "gh1.next" } });
    await click(f.node, "Consultar compras");
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.node.textContent).toContain("Esta consulta não retornou compras");
    expect(f.node.textContent).toContain("Carregar mais compras");
  });
  it("treats transient read-port failure as unavailable and restores retained receipts without another read", async () => {
    const f = await mounted();
    f.setReply({ history: detail });
    await click(f.node, "Ver histórico desta compra");
    const request = f.ports.request;
    let unavailable = true;
    Object.defineProperty(f.ports, "request", {
      configurable: true,
      get() {
        if (unavailable) throw new Error("private port failure");
        return request;
      },
    });
    await f.render();
    expect(f.node.textContent).toContain("Histórico de presentes indisponível");
    expect(f.node.textContent).not.toContain("Acesso financeiro restrito");
    expect(f.node.textContent).not.toMatch(
      /Lua de mel|R\$|private port failure/,
    );
    expect(f.owner.getSnapshot().status).toBe("verified");
    unavailable = false;
    await f.render();
    expect(f.node.textContent).toContain("Crédito histórico");
    expect(f.node.textContent).toContain("2 de 64");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
