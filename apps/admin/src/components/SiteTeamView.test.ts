import type { SiteTeamResponse } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SiteTeamView } from "./SiteTeamView";

const team: SiteTeamResponse = {
  members: [
    {
      userId: "user-active",
      siteId: "site-1",
      name: "Ana Assistente",
      email: "ana@example.com",
      membershipRole: "SITE_ASSISTANT",
      revokedAt: null,
    },
    {
      userId: "user-revoked",
      siteId: "site-1",
      name: "Bia Revogada",
      email: "bia@example.com",
      membershipRole: "SITE_ASSISTANT",
      revokedAt: "2026-10-10T14:45:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invitation-pending",
      siteId: "site-1",
      email: "clara@example.com",
      inviteeName: "Clara Pendente",
      expiresAt: "2026-10-12T15:30:00.000Z",
      consumedAt: null,
      revokedAt: null,
    },
    {
      id: "invitation-used",
      siteId: "site-1",
      email: "duda@example.com",
      inviteeName: "Duda Utilizada",
      expiresAt: "2026-10-11T15:30:00.000Z",
      consumedAt: "2026-10-10T15:30:00.000Z",
      revokedAt: null,
    },
    {
      id: "invitation-revoked",
      siteId: "site-1",
      email: "eva@example.com",
      inviteeName: "Eva Revogada",
      expiresAt: "2026-10-11T15:30:00.000Z",
      consumedAt: null,
      revokedAt: "2026-10-10T16:30:00.000Z",
    },
  ],
};
const observedNow = new Date("2026-10-12T12:00:00.000Z");

const callbacks = () => ({
  inviteOpen: false,
  onInviteOpenChange: vi.fn(),
  onInvite: vi.fn(),
  onRevokeMember: vi.fn(),
  onRevokeInvitation: vi.fn(),
  onRetry: vi.fn(),
});

describe("site team view", () => {
  it("keeps contact details and management controls hidden without access", () => {
    const html = renderToStaticMarkup(
      createElement(SiteTeamView, {
        team,
        canManage: false,
        pending: false,
        now: observedNow,
        error: "raw_hash private token",
        ...callbacks(),
      }),
    );

    expect(html).toContain("Você não tem acesso para gerenciar a equipe.");
    expect(html).not.toContain("Ana Assistente");
    expect(html).not.toContain("ana@example.com");
    expect(html).not.toContain("Clara Pendente");
    expect(html).not.toContain("raw_hash");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  it("shows a loading status and a safe retry message after an error", () => {
    const render = (props: { pending: boolean; error?: string }) =>
      renderToStaticMarkup(
        createElement(SiteTeamView, {
          team: null,
          canManage: true,
          ...props,
          ...callbacks(),
        }),
      );

    expect(render({ pending: true })).toContain('role="status"');
    expect(render({ pending: true })).toContain("Carregando equipe");
    const errorMarkup = render({
      pending: false,
      error: "database password raw_hash provider secret",
    });
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("Não foi possível carregar a equipe.");
    expect(errorMarkup).toContain("Tentar novamente");
    expect(errorMarkup).not.toContain("database password");
    expect(errorMarkup).not.toContain("raw_hash");
    expect(errorMarkup).not.toContain("provider secret");
  });

  it("keeps invitation fields in a focused dialog and shows one invite action", () => {
    const html = renderToStaticMarkup(
      createElement(SiteTeamView, {
        team,
        canManage: true,
        pending: false,
        now: observedNow,
        ...callbacks(),
      }),
    );
    expect(html).not.toContain("<form");
    expect(html).toMatch(/>Convidar assessor<\/button>/);
    expect(html).toContain("Assessores com acesso");
    expect(html).toContain("Convites da equipe");
  });

  it("offers revoke actions only for active members and pending invitations", () => {
    const html = renderToStaticMarkup(
      createElement(SiteTeamView, {
        team,
        canManage: true,
        pending: false,
        now: observedNow,
        ...callbacks(),
      }),
    );

    expect(html).toContain("Ana Assistente");
    expect(html).toContain("Bia Revogada");
    expect(html).toContain("Clara Pendente");
    expect(html).toContain("Duda Utilizada");
    expect(html).toContain("Eva Revogada");
    expect(html).toContain("Acesso ativo");
    expect(html).toContain("Acesso revogado");
    expect(html).toContain("Pendente");
    expect(html).toContain("Utilizado");
    expect(html).toContain("Revogado");
    expect(html).toContain("12/10/2026");
    expect(html).toContain("Revogar acesso de Ana Assistente");
    expect(html).not.toContain("Revogar acesso de Bia Revogada");
    expect(html).toContain("Revogar convite para Clara Pendente");
    expect(html).not.toContain("Revogar convite para Duda Utilizada");
    expect(html).not.toContain("Revogar convite para Eva Revogada");
    expect(html).not.toMatch(/token|hash|Asaas|banco|conta bancária|R\$/i);
  });

  it("expires an unconsumed invitation at its exact expiry time", () => {
    const expiringTeam: SiteTeamResponse = {
      members: [],
      invitations: [
        {
          ...team.invitations[0],
          id: "invitation-expiring",
          inviteeName: "Clara no limite",
        },
      ],
    };
    const render = (now: Date) =>
      renderToStaticMarkup(
        createElement(SiteTeamView, {
          team: expiringTeam,
          canManage: true,
          pending: false,
          now,
          ...callbacks(),
        }),
      );

    const justBefore = render(new Date("2026-10-12T15:29:59.999Z"));
    expect(justBefore).toContain("Pendente");
    expect(justBefore).toContain("Revogar convite para Clara no limite");

    const atExpiry = render(new Date("2026-10-12T15:30:00.000Z"));
    expect(atExpiry).toContain("Expirado");
    expect(atExpiry).not.toContain("Revogar convite para Clara no limite");
  });
});
