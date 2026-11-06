// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InvitationOverview } from "./InvitationOverview";

describe("invitation overview", () => {
  it("shows the approved metrics and actions without excluded features", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationOverview, {
        summary: {
          invitations: 2,
          guests: 3,
          adults: 2,
          children: 1,
          pending: 1,
          confirmed: 1,
          declined: 1,
          guestsByStatus: {
            confirmed: { adults: 1, children: 0 },
            pending: { adults: 0, children: 1 },
            declined: { adults: 1, children: 0 },
          },
        },
        inactive: false,
        onAdd: vi.fn(),
        onManageConfirmations: vi.fn(),
        onExport: vi.fn(),
        onConfigureDeadline: vi.fn(),
      }),
    );
    for (const label of [
      "2 convites",
      "3 convidados",
      "2 adultos",
      "1 criança",
      "Novo convite",
      "Gerenciar confirmações",
      "Exportar",
      "Prazo de confirmação",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/Importar|Mesas|Lembretes|Divulgar/);
  });

  it("blocks mutations when the wedding is inactive", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationOverview, {
        summary: {
          invitations: 0,
          guests: 0,
          adults: 0,
          children: 0,
          pending: 0,
          confirmed: 0,
          declined: 0,
          guestsByStatus: {
            confirmed: { adults: 0, children: 0 },
            pending: { adults: 0, children: 0 },
            declined: { adults: 0, children: 0 },
          },
        },
        inactive: true,
        onAdd: vi.fn(),
        onManageConfirmations: vi.fn(),
        onExport: vi.fn(),
        onConfigureDeadline: vi.fn(),
      }),
    );
    expect((html.match(/\sdisabled=""/g) ?? []).length).toBe(2);
  });

  it("uses wedding-wide guest types and shows the time left to answer", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationOverview, {
        summary: {
          invitations: 1,
          guests: 1,
          adults: 1,
          children: 0,
          pending: 1,
          confirmed: 0,
          declined: 0,
          guestsByStatus: {
            confirmed: { adults: 0, children: 0 },
            pending: { adults: 1, children: 0 },
            declined: { adults: 0, children: 0 },
          },
        },
        siteTotals: {
          total: 8,
          confirmed: 9,
          pending: 7,
          declined: 2,
          adults: 14,
          children: 4,
          byStatus: { confirmed: 4, pending: 2, declined: 1, partial: 1 },
          guestsByStatus: {
            confirmed: { adults: 7, children: 2 },
            pending: { adults: 5, children: 2 },
            declined: { adults: 2, children: 0 },
          },
        },
        inactive: false,
        onAdd: vi.fn(),
        onManageConfirmations: vi.fn(),
        onExport: vi.fn(),
        onConfigureDeadline: vi.fn(),
        deadline: "15/01/2027, 23:59",
        deadlineCountdown: "Faltam 71 dias para encerrar as respostas",
      }),
    );
    expect(html).toContain("9 de 18 convidados irão comparecer");
    expect(html).toContain("8 convites · 14 adultos · 4 crianças");
    expect(html).toContain("Faltam 71 dias para encerrar as respostas");
    const page = new DOMParser().parseFromString(html, "text/html");
    expect(
      [...page.querySelectorAll("tr")].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Situação", "Pessoas", "Adultos", "Crianças"],
      ["Confirmados", "9", "7", "2"],
      ["Sem resposta", "7", "5", "2"],
      ["Não irão", "2", "2", "0"],
    ]);
    const budget = page.querySelector(
      '[aria-label="Estimativa para orçamento"]',
    );
    expect(budget?.textContent).toContain(
      "Confirmados hoje: 9 pessoas (7 adultos e 2 crianças)",
    );
    expect(budget?.textContent).toContain(
      "No máximo: 16 pessoas (12 adultos e 4 crianças)",
    );
    expect(budget?.textContent).toContain(
      "Use o máximo para fechar orçamentos enquanto há respostas pendentes.",
    );
  });

  it("uses the singular for a single guest", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationOverview, {
        summary: {
          invitations: 1,
          guests: 1,
          adults: 0,
          children: 1,
          pending: 0,
          confirmed: 1,
          declined: 0,
          guestsByStatus: {
            confirmed: { adults: 0, children: 1 },
            pending: { adults: 0, children: 0 },
            declined: { adults: 0, children: 0 },
          },
        },
        inactive: false,
        onAdd: vi.fn(),
        onManageConfirmations: vi.fn(),
        onExport: vi.fn(),
        onConfigureDeadline: vi.fn(),
      }),
    );
    const text = new DOMParser().parseFromString(html, "text/html").body
      .textContent;
    expect(text).toContain("1 de 1 convidado irá comparecer");
    expect(text).toContain("1 convite · 0 adultos · 1 criança");
    expect(text).toContain(
      "Confirmados hoje: 1 pessoa (0 adultos e 1 criança)",
    );
    expect(text).toContain("No máximo: 1 pessoa (0 adultos e 1 criança)");
  });
});
