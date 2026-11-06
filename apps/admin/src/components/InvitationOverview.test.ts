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
        },
        siteTotals: {
          total: 8,
          confirmed: 9,
          pending: 7,
          declined: 2,
          adults: 14,
          children: 4,
          byStatus: { confirmed: 4, pending: 2, declined: 1, partial: 1 },
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
  });
});
