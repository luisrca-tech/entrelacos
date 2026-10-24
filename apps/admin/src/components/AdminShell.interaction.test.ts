// @vitest-environment jsdom
import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AdminShell } from "./AdminShell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    activeOptions: _activeOptions,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    activeOptions?: unknown;
  }) => createElement("a", { ...props, href: to }, children),
}));
const actor: MeResponse = {
  user: {
    id: "admin-a",
    name: "Ana",
    email: "ana@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2027-01-01T00:00:00Z" },
  siteId: "wedding-a",
};
describe("mobile panel navigation", () => {
  it("keeps four main destinations and opens the other pages on demand", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(
            AdminShell,
            {
              actor,
              siteId: "wedding-a",
              siteName: "Ana e João",
              area: "home",
              onLogout: vi.fn(),
            },
            createElement("p", null, "Home"),
          ),
        ),
      );
      const mobile = node.querySelector(
        'nav[aria-label="Navegação do casamento no celular"]',
      );
      expect(mobile).not.toBeNull();
      expect(mobile?.querySelectorAll("a")).toHaveLength(4);
      expect(mobile?.textContent).toContain("Início");
      const more = mobile?.querySelector<HTMLButtonElement>(
        'button[aria-label="Mais páginas"]',
      );
      expect(more).not.toBeNull();
      await act(async () => more?.click());
      expect(
        document.querySelector('a[href="/sites/wedding-a/team"]'),
      ).not.toBeNull();
      expect(
        [...document.querySelectorAll('a[href="/sites/wedding-a/messages"]')]
          .length,
      ).toBeGreaterThan(1);
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
  it("uses the current wedding role in the account menu", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const access: SiteAccess = {
      siteId: "wedding-a",
      userId: actor.user.id,
      membershipId: "member-a",
      membershipRole: "SITE_ASSISTANT",
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: false,
        readFinance: false,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    try {
      await act(async () =>
        root.render(
          createElement(
            AdminShell,
            {
              actor,
              siteId: access.siteId,
              siteAccess: access,
              area: "home",
              onLogout: vi.fn(),
            },
            createElement("p", null, "Home"),
          ),
        ),
      );
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Abrir menu de Ana"]',
          )
          ?.click(),
      );
      expect(document.body.textContent).toContain("Assessor do casamento");
      const mobile = node.querySelector(
        'nav[aria-label="Navegação do casamento no celular"]',
      );
      expect(mobile?.querySelectorAll("a")).toHaveLength(4);
      expect(mobile?.textContent).not.toContain("Mais");
      expect(mobile?.textContent).not.toContain("Recebimentos");
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
});
