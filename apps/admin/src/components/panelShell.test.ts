import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(import.meta.dirname, "Panel.tsx"),
  "utf8",
);
const shellSource = readFileSync(
  resolve(import.meta.dirname, "AdminShell.tsx"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve(import.meta.dirname, "SiteWorkspace.tsx"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(import.meta.dirname, "../routes/sites.$siteId.tsx"),
  "utf8",
);

describe("admin shell safety regressions", () => {
  it("guards load-more against concurrent requests and pending create", () => {
    expect(panelSource).toContain("loadingMoreRef.current");
    expect(panelSource).toContain("disabled={pending || loadingMore}");
  });

  it("redirects only the compatibility parent path", () => {
    expect(routeSource).toContain("location.pathname");
    expect(routeSource).toContain("if (pathname === parentPath)");
  });

  it("keeps the create-site dialog from growing a horizontal scrollbar", () => {
    expect(stylesSource).toMatch(
      /\.create-site-dialog\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
    expect(stylesSource).toMatch(
      /\.form-grid\s*>\s*\*\s*\{[^}]*min-width:\s*0;/s,
    );
  });

  it("shows the wedding name in the shell instead of the site id", () => {
    expect(shellSource).toContain("siteName");
    expect(shellSource).not.toContain(
      '{siteId && <span className="topbar-site">/ {siteId}</span>}',
    );
    expect(shellSource).not.toContain("<strong>{siteId}</strong>");
    expect(shellSource).toContain("{siteName && <strong>{siteName}</strong>}");
    expect(panelSource).toContain("siteName={siteName}");
    expect(workspaceSource).toContain("onSiteName");
  });

  it("uses router links for global and responsive site navigation", () => {
    expect(shellSource).toContain(
      'import { Link } from "@tanstack/react-router";',
    );
    expect(shellSource).toContain('className="admin-nav-link is-active"');
    expect(shellSource).toContain('to="/"');
    expect(shellSource).toContain("to={item.href}");
    expect(shellSource).toContain(
      'aria-current={item.area === area ? "page" : undefined}',
    );
    expect(shellSource).not.toContain("href={item.href}");
  });

  it("keeps internal panel links inside the router", () => {
    expect(panelSource).toContain(
      'import { Link } from "@tanstack/react-router";',
    );
    expect(panelSource).toContain('to="/sites/$siteId/overview"');
    expect(panelSource).toContain("params={{ siteId: site.id }}");
    expect(panelSource).not.toContain("href=");
    expect(workspaceSource).toContain(
      'import { Link } from "@tanstack/react-router";',
    );
    expect(workspaceSource).toContain(
      '<Link className="workspace-back" to="/">',
    );
    expect(workspaceSource).not.toContain(
      '<a className="workspace-back" href="/">',
    );
  });
});
