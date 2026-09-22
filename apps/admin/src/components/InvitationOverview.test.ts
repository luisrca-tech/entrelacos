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
      "Convites",
      "Convidados",
      "Adultos",
      "Crianças",
      "Adicionar convite",
      "Gerenciar confirmações",
      "Exportar CSV ou PDF",
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
});
