import type { FinancialOverview, SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FinancialOverviewCard } from "./FinancialOverviewCard";

const access: SiteAccess = {
  siteId: "site-a",
  userId: "admin-a",
  membershipId: "membership-a",
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
const overview: FinancialOverview = {
  siteId: "site-a",
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
function render(
  props: Partial<Parameters<typeof FinancialOverviewCard>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(FinancialOverviewCard, {
      siteId: "site-a",
      access,
      overview,
      onRetry: vi.fn(),
      ...props,
    }),
  );
}

describe("financial overview card", () => {
  it("keeps private amounts hidden from missing, owner, assistant and other-site access", () => {
    for (const value of [
      null,
      { ...access, membershipRole: "OWNER" as const },
      { ...access, membershipRole: "SITE_ASSISTANT" as const },
      { ...access, siteId: "site-b" },
      { ...access, membershipId: null },
      {
        ...access,
        capabilities: { ...access.capabilities, readFinance: false },
      },
    ]) {
      const html = render({ access: value });
      expect(html).toContain("Acesso financeiro restrito");
      expect(html).not.toContain("Presentes recebidos");
      expect(html).not.toContain("100,00");
      expect(html).not.toContain("<button");
    }
  });

  it("never invents a zero balance while unavailable, loading or failed", () => {
    for (const props of [
      { overview: null },
      { overview: null, loading: true },
      { error: true },
    ]) {
      const html = render(props);
      expect(html).not.toContain("0,00");
      expect(html).not.toContain("Transferir");
    }
    expect(render({ error: true })).toContain("Tentar novamente");
    expect(render({ overview: null })).toContain(
      "Resumo financeiro indisponível",
    );
  });

  it("keeps unknown/stale available funds distinct from recorded receipts and labels sandbox", () => {
    const html = render();
    expect(html).toContain("Presentes recebidos");
    expect(html).toContain("100,00");
    expect(html).toContain("Saldo disponível");
    expect(html).toContain("Ainda não confirmado");
    expect(html).toContain("Sandbox");
    expect(html).not.toContain("<button");
    expect(
      render({
        overview: {
          ...overview,
          availability: "STALE",
          synchronizedAt: "2026-10-12T12:00:00.000Z",
        },
      }),
    ).toContain("Saldo desatualizado");
  });

  it("shows a current provider balance only from the valid matching projection", () => {
    const html = render({
      overview: {
        ...overview,
        availableCents: 5000,
        synchronizedAt: "2026-10-12T12:00:00.000Z",
        availability: "CURRENT",
        mode: "live",
      },
    });
    expect(html).toContain("50,00");
    expect(html).toContain("Última atualização");
    expect(html).not.toContain("Sandbox");
    expect(html).not.toContain("<form");
  });

  it("rejects contradictory, cross-site or private financial response fields", () => {
    for (const invalid of [
      { ...overview, siteId: "site-b" },
      { ...overview, availableCents: 5000 },
      { ...overview, walletId: "private-account" },
    ]) {
      const html = render({ overview: invalid as FinancialOverview });
      expect(html).toContain("Resumo financeiro indisponível");
      expect(html).not.toContain("100,00");
      expect(html).not.toContain("private-account");
    }
  });
});
