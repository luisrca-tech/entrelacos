import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceHeading } from "./siteWorkspaceHeading";

describe("site workspace heading", () => {
  it("titles the page by area for both roles", () => {
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: true,
        lifecycle: "DRAFT",
      }).title,
    ).toBe("Convites");
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: false,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Convites");
    expect(
      getWorkspaceHeading({
        area: "messages",
        owner: false,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Mensagens");
    expect(
      getWorkspaceHeading({
        area: "settings",
        owner: true,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Configurações");
  });

  it("shows the back link only to owners", () => {
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: true,
        lifecycle: "ACTIVE",
      }).showBackLink,
    ).toBe(true);
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: false,
        lifecycle: "ACTIVE",
      }).showBackLink,
    ).toBe(false);
  });

  it("always shows lifecycle status to owners", () => {
    expect(
      getWorkspaceHeading({
        area: "settings",
        owner: true,
        lifecycle: "DRAFT",
      }).showLifecycleBadge,
    ).toBe(true);
    expect(
      getWorkspaceHeading({
        area: "settings",
        owner: true,
        lifecycle: "ACTIVE",
      }).showLifecycleBadge,
    ).toBe(true);
  });

  it("shows lifecycle status to site admins only when inactive", () => {
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: false,
        lifecycle: "ACTIVE",
      }).showLifecycleBadge,
    ).toBe(false);
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: false,
        lifecycle: "IN_REVIEW",
      }).showLifecycleBadge,
    ).toBe(false);
    expect(
      getWorkspaceHeading({
        area: "invitations",
        owner: false,
        lifecycle: "INACTIVE",
      }).showLifecycleBadge,
    ).toBe(true);
  });
});

describe("site workspace markup", () => {
  const workspaceSource = readFileSync(
    resolve(import.meta.dirname, "SiteWorkspace.tsx"),
    "utf8",
  );

  it("renders the heading title from shared rules", () => {
    expect(workspaceSource).toContain("getWorkspaceHeading");
    expect(workspaceSource).toContain("displayHeading");
    expect(workspaceSource).not.toContain('owner ? "Gestão do casamento"');
  });

  it("uses the wedding identity as the heading subtitle", () => {
    expect(workspaceSource).toContain(
      "text-base leading-[1.6] text-admin-muted",
    );
    expect(workspaceSource).toContain("{site.displayName}");
    expect(workspaceSource).not.toContain("heading.lede");
    expect(workspaceSource).not.toMatch(
      /className="panel-heading workspace-heading"[\s\S]*className="lede"/,
    );
  });

  it("keeps the public site CTA in the heading", () => {
    expect(workspaceSource).toContain("Ir para o site");
    expect(workspaceSource).toContain(
      "publicSiteHandoffUrl(site.publicUrl, panelOrigin)",
    );
  });

  it("keeps status, dates, and publication in owner settings", () => {
    expect(workspaceSource).toContain('data-area="settings"');
    expect(workspaceSource).toContain('aria-label="Status e datas"');
    expect(workspaceSource).toContain("<strong>Publicação</strong>");
    expect(workspaceSource).not.toContain('data-area="overview"');
  });

  it("sizes the workspace heading as app chrome", () => {
    expect(workspaceSource).toContain("text-[clamp(1.85rem,3vw,2.6rem)]");
    expect(workspaceSource).toContain("items-end justify-between");
  });
});
