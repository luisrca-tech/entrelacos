import type { InvitationRecord } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InvitationList } from "./InvitationList";

const invitation: InvitationRecord = {
  id: "invitation-1",
  siteId: "site-1",
  name: "Família Silva",
  phone: "+5511999999999",
  email: null,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  guests: [
    {
      id: "guest-1",
      fullName: "Ana",
      guestType: "ADULT",
      rsvpState: "CONFIRMED",
      rsvpRevision: 1,
    },
    {
      id: "guest-2",
      fullName: "Bia",
      guestType: "CHILD",
      rsvpState: "PENDING",
      rsvpRevision: 0,
    },
  ],
};

describe("invitation list", () => {
  it("shows each guest status and age type under the invitation", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationList, {
        invitations: [invitation],
        hasFilters: false,
        onOpen: vi.fn(),
      }),
    );
    for (const text of [
      "Família Silva",
      "Ana",
      "Bia",
      "Adulto",
      "Criança",
      "Irá comparecer",
      "Sem resposta",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("+5511999999999");
    expect(html).not.toContain("PIN");
  });

  it("distinguishes empty list from unmatched filters", () => {
    const render = (hasFilters: boolean) =>
      renderToStaticMarkup(
        createElement(InvitationList, {
          invitations: [],
          hasFilters,
          onOpen: vi.fn(),
        }),
      );
    expect(render(false)).toContain("Ainda não há convites");
    expect(render(true)).toContain("Nenhum convite encontrado");
  });
});
