import type { SiteAccess, WithdrawalIntent } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WithdrawalHistoryView } from "./WithdrawalHistoryView";
import type { WithdrawalHistoryResult } from "./withdrawalHistory";

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

const withdrawal: WithdrawalIntent = {
  id: "withdrawal-private-id",
  siteId: "wedding-a",
  amountCents: 10000,
  feeCents: 200,
  netCents: 9800,
  currency: "BRL",
  destinationVersion: 7,
  state: "PROCESSING",
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T11:00:00.000Z",
  mode: "live",
};

function render(
  result: WithdrawalHistoryResult,
  options: {
    siteId?: string;
    access?: SiteAccess | null;
    onRefresh?: () => void;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(WithdrawalHistoryView, {
      siteId: options.siteId ?? "wedding-a",
      access: options.access === undefined ? access : options.access,
      result,
      onRefresh: options.onRefresh,
    }),
  );
}

describe("withdrawal history view", () => {
  it.each([
    ["missing access", null],
    ["another site", { ...access, siteId: "wedding-b" }],
    ["owner role", { ...access, membershipRole: "OWNER" }],
    ["assistant role", { ...access, membershipRole: "SITE_ASSISTANT" }],
    ["missing membership", { ...access, membershipId: null }],
    [
      "missing finance capability",
      {
        ...access,
        capabilities: { ...access.capabilities, readFinance: false },
      },
    ],
  ])("hides records and money with %s", (_reason, candidate) => {
    const html = render(
      { status: "ready", withdrawals: [withdrawal] },
      { access: candidate as SiteAccess | null },
    );

    expect(html).toContain("Acesso financeiro restrito");
    expect(html).not.toContain("R$");
    expect(html).not.toContain(withdrawal.id);
    expect(html).not.toContain("<button");
  });

  it.each([
    [{ status: "loading" }, "Consultando o histórico de saques"],
    [{ status: "unavailable" }, "Histórico de saques indisponível"],
    [{ status: "error" }, "Não foi possível consultar o histórico de saques."],
  ] as const)(
    "keeps %s distinct from a successful empty history",
    (result, message) => {
      const html = render(result as WithdrawalHistoryResult, {
        onRefresh: vi.fn(),
      });

      expect(html).toContain(message);
      expect(html).not.toContain("Ainda não há saques registrados");
      expect(html).not.toContain("R$");
      expect(html).not.toContain("0,00");
      expect(html).toContain("Consultar novamente");
      expect(html).not.toContain("Tentar novamente");
      if ((result as WithdrawalHistoryResult).status === "loading")
        expect(html).toContain('disabled=""');
    },
  );

  it("shows a separate empty state only for a successful empty history", () => {
    const html = render({ status: "ready", withdrawals: [] });

    expect(html).toContain("Ainda não há saques registrados.");
    expect(html).not.toContain("indisponível");
    expect(html).not.toContain("R$");
  });

  it.each([
    ["REQUESTED", "Solicitado"],
    ["AWAITING_AUTHORIZATION", "Aguardando autorização"],
    ["PROCESSING", "Em processamento"],
    ["COMPLETED", "Concluído pelo provedor"],
    ["FAILED", "Falha informada"],
    ["CANCELLED", "Cancelado"],
    ["UNKNOWN", "Resultado em verificação"],
  ] as const)("shows the observed %s state as %s", (state, label) => {
    const html = render({
      status: "ready",
      withdrawals: [{ ...withdrawal, state }],
    });

    expect(html).toContain(label);
  });

  it("shows BRL amount, fee, net, São Paulo date and hides private identifiers", () => {
    const html = render({ status: "ready", withdrawals: [withdrawal] });

    expect(html).toContain("R$");
    expect(html).toContain("100,00");
    expect(html).toContain("2,00");
    expect(html).toContain("98,00");
    expect(html).toContain("12/10/2026");
    expect(html).toContain("07:00");
    expect(html).toContain("Atualizado em");
    expect(html).toContain("08:00");
    expect(html).not.toContain(withdrawal.id);
    expect(html).not.toContain("destinationVersion");
    expect(html).not.toContain("Asaas");
    expect(html).not.toContain("conta bancária");
  });

  it("clearly marks sandbox values as test money", () => {
    const html = render({
      status: "ready",
      withdrawals: [{ ...withdrawal, mode: "sandbox" }],
    });

    expect(html).toContain("Sandbox");
    expect(html).toContain("valores de teste");
  });

  it("does not present provider completion as bank receipt", () => {
    const html = render({
      status: "ready",
      withdrawals: [{ ...withdrawal, state: "COMPLETED" }],
    });

    expect(html).toContain("Concluído pelo provedor");
    expect(html).toContain("não confirma o crédito na conta bancária");
  });

  it("shows only the read refresh action", () => {
    const html = render(
      { status: "ready", withdrawals: [withdrawal] },
      { onRefresh: vi.fn() },
    );

    expect(html).toMatch(/<button[^>]*>Consultar novamente<\/button>/);
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("Solicitar saque");
    expect(html).not.toContain("Repetir saque");
  });

  it.each([
    [
      "private provider data",
      [{ ...withdrawal, providerReference: "private-provider-payload" }],
    ],
    ["another site", [{ ...withdrawal, siteId: "wedding-b" }]],
    ["duplicate records", [withdrawal, { ...withdrawal }]],
    ["contradictory fee and net", [{ ...withdrawal, netCents: 9900 }]],
    [
      "an update before creation",
      [{ ...withdrawal, updatedAt: "2026-10-12T09:59:59.000Z" }],
    ],
    ["invalid timestamps", [{ ...withdrawal, createdAt: "tomorrow" }]],
  ] as const)(
    "replaces ready data with %s by a generic error",
    (_reason, records) => {
      const html = render({
        status: "ready",
        withdrawals: records as unknown as WithdrawalIntent[],
      });

      expect(html).toContain(
        "Não foi possível consultar o histórico de saques.",
      );
      expect(html).not.toContain("private-provider-payload");
      expect(html).not.toContain("R$");
    },
  );
});

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
afterEach(() => vi.unstubAllGlobals());

it("shows actual terminal debit and fee with the unused maximum returned", () => {
  const html = render({
    status: "ready",
    withdrawals: [
      {
        ...withdrawal,
        state: "COMPLETED",
        feeSemantics: "MAXIMUM",
        settlement: {
          totalDebitCents: 9800,
          feeCents: 0,
          netCents: 9800,
          releasedCents: 200,
        },
      },
    ],
  });
  expect(html).toContain("Valor debitado");
  expect(html).toContain("Taxa efetiva");
  expect(html).toContain("Reserva liberada");
});
