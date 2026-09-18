import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceHeading } from "./siteWorkspaceHeading";

describe("site workspace heading", () => {
  it("titles the page by area for both roles", () => {
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: true,
        lifecycle: "DRAFT",
      }).title,
    ).toBe("Visão geral");
    expect(
      getWorkspaceHeading({
        area: "guests",
        owner: false,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Convidados");
    expect(
      getWorkspaceHeading({
        area: "rsvp",
        owner: false,
        lifecycle: "ACTIVE",
      }).title,
    ).toBe("Confirmações");
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

  it("does not carry area ledes", () => {
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: true,
        lifecycle: "ACTIVE",
      }),
    ).not.toHaveProperty("lede");
  });

  it("shows the back link only to owners", () => {
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: true,
        lifecycle: "ACTIVE",
      }).showBackLink,
    ).toBe(true);
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: false,
        lifecycle: "ACTIVE",
      }).showBackLink,
    ).toBe(false);
  });

  it("always shows lifecycle status to owners", () => {
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: true,
        lifecycle: "DRAFT",
      }).showLifecycleBadge,
    ).toBe(true);
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: true,
        lifecycle: "ACTIVE",
      }).showLifecycleBadge,
    ).toBe(true);
  });

  it("shows lifecycle status to site admins only when inactive", () => {
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: false,
        lifecycle: "ACTIVE",
      }).showLifecycleBadge,
    ).toBe(false);
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: false,
        lifecycle: "DRAFT",
      }).showLifecycleBadge,
    ).toBe(false);
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: false,
        lifecycle: "IN_REVIEW",
      }).showLifecycleBadge,
    ).toBe(false);
    expect(
      getWorkspaceHeading({
        area: "overview",
        owner: false,
        lifecycle: "INACTIVE",
      }).showLifecycleBadge,
    ).toBe(true);
  });
});

describe("site workspace heading markup", () => {
  const workspaceSource = readFileSync(
    resolve(import.meta.dirname, "SiteWorkspace.tsx"),
    "utf8",
  );
  const stylesSource = readFileSync(
    resolve(import.meta.dirname, "../styles.css"),
    "utf8",
  );

  it("renders the heading title from shared rules", () => {
    expect(workspaceSource).toContain("getWorkspaceHeading");
    expect(workspaceSource).toContain("workspace-heading");
    expect(workspaceSource).not.toContain('owner ? "Gestão do casamento"');
  });

  it("uses couple identity as the heading subtitle", () => {
    expect(workspaceSource).toContain('className="workspace-identity"');
    expect(workspaceSource).toContain("{site.displayName}");
    expect(workspaceSource).not.toContain("heading.lede");
    expect(workspaceSource).not.toMatch(
      /className="panel-heading workspace-heading"[\s\S]*className="lede"/,
    );
  });

  it("keeps the public site CTA in the heading, not the overview facts", () => {
    expect(workspaceSource).toMatch(
      /className="panel-heading workspace-heading"[\s\S]*Ir para o site/,
    );
    expect(workspaceSource).not.toMatch(
      /data-area="overview"[\s\S]*Ir para o site/,
    );
    expect(workspaceSource).toContain(
      "publicSiteHandoffUrl(site.publicUrl, panelOrigin)",
    );
  });

  it("sizes the workspace heading as app chrome", () => {
    expect(stylesSource).toMatch(/\.workspace-heading h1\s*\{/);
    expect(stylesSource).toMatch(/\.workspace-heading-row\s*\{/);
  });
});
