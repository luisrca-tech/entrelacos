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

  it("names the gifts workspace before catalog activation", () => {
    expect(
      getWorkspaceHeading({
        area: "gifts",
        owner: false,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Presentes");
  });

  it("lets receiving and gifts render their own page header", () => {
    for (const area of ["receiving", "gifts"] as const)
      expect(
        getWorkspaceHeading({ area, owner: false, lifecycle: "ACTIVE" })
          .ownPageHeader,
      ).toBe(true);
    for (const area of [
      "home",
      "invitations",
      "messages",
      "receiving-guide",
      "team",
      "settings",
    ] as const)
      expect(
        getWorkspaceHeading({ area, owner: true, lifecycle: "ACTIVE" })
          .ownPageHeader,
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

  it("describes the redesigned areas and keeps the wedding name as a fallback", () => {
    expect(workspaceSource).toContain("Acompanhe a preparação do casamento");
    expect(workspaceSource).toContain("Quem vocês convidaram");
    expect(workspaceSource).toContain("Leia os recados recebidos");
    expect(workspaceSource).toContain("Gerencie quem ajuda");
    expect(workspaceSource).toContain("site.displayName");
  });

  it("keeps the public site CTA in the heading", () => {
    expect(workspaceSource).toContain("Ir para o site");
    expect(workspaceSource).toContain(
      "publicSiteHandoffUrl(site.publicUrl, panelOrigin)",
    );
  });

  it("keeps status, dates, and publication in owner settings", () => {
    expect(workspaceSource).toContain('data-area="settings"');
    const settingsSource = readFileSync(
      resolve(import.meta.dirname, "SiteSettingsView.tsx"),
      "utf8",
    );
    expect(settingsSource).toContain("Situação do casamento");
    expect(settingsSource).toContain('tab === "dates"');
    expect(settingsSource).toContain('tab === "publication"');
    expect(settingsSource).toContain("{labels[site.publicationState]}");
    expect(workspaceSource).not.toContain('data-area="overview"');
  });

  it("sizes the workspace heading as app chrome", () => {
    expect(workspaceSource).toContain("text-[clamp(1.85rem,3vw,2.6rem)]");
    expect(workspaceSource).toContain("items-end justify-between");
  });
});
