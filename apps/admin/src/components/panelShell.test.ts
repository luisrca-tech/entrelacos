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
const routeSource = readFileSync(
  resolve(import.meta.dirname, "../routes/sites.$siteId.tsx"),
  "utf8",
);
const invitationRouteSource = readFileSync(
  resolve(import.meta.dirname, "../routes/sites.$siteId.invitations.tsx"),
  "utf8",
);
const rootSource = readFileSync(
  resolve(import.meta.dirname, "../routes/__root.tsx"),
  "utf8",
);
const invitationsSource = readFileSync(
  resolve(import.meta.dirname, "InvitationsSection.tsx"),
  "utf8",
);

describe("admin shell safety regressions", () => {
  it("mounts one toaster on the admin root", () => {
    expect(rootSource).toContain("<Toaster />");
    expect(shellSource).not.toContain("<Toaster");
  });

  it("toasts invitation results instead of a page banner", () => {
    expect(invitationsSource).toContain(
      'id ? "Convite atualizado." : "Convite adicionado."',
    );
    expect(invitationsSource).toContain("toast[tone](success)");
    expect(invitationsSource).toContain('"warning"');
    expect(invitationsSource).not.toContain("setNotice");
    expect(invitationsSource).not.toContain("adminStyles.notice");
  });

  it("guards load-more against concurrent requests and pending create", () => {
    expect(panelSource).toContain("loadingMoreRef.current");
    expect(panelSource).toContain("disabled={pending || loadingMore}");
  });

  it("redirects only the compatibility parent path", () => {
    expect(routeSource).toContain("location.pathname");
    expect(routeSource).toContain("if (pathname === parentPath)");
  });

  it("uses invitations as the only invitation and RSVP workspace route", () => {
    expect(routeSource).toContain('to: "/sites/$siteId/invitations"');
    expect(invitationRouteSource).toContain('area="invitations"');
    expect(workspaceSource).toContain("<InvitationsSection");
    expect(workspaceSource).not.toContain("<GuestGroupsSection");
    expect(workspaceSource).not.toContain("<RsvpSection");
  });

  it("keeps the create-site dialog from growing a horizontal scrollbar", () => {
    expect(panelSource).toContain("overflow-x-hidden overflow-y-auto");
    expect(panelSource).toContain("min-w-0");
  });

  it("shows the wedding name in the shell instead of the site id", () => {
    expect(shellSource).toContain("siteName");
    expect(shellSource).not.toContain(
      '{siteId && <span className="topbar-site">/ {siteId}</span>}',
    );
    expect(shellSource).not.toContain("<strong>{siteId}</strong>");
    expect(shellSource).toContain(
      'siteName && <strong className="truncate">{siteName}</strong>',
    );
    expect(panelSource).toContain("siteName={siteName}");
    expect(workspaceSource).toContain("onSiteName");
  });

  it("uses router links for global and responsive site navigation", () => {
    expect(shellSource).toContain(
      'import { Link } from "@tanstack/react-router";',
    );
    expect(shellSource).toContain("bg-admin-terracotta-wash");
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
    expect(panelSource).toContain('to="/sites/$siteId/invitations"');
    expect(panelSource).toContain("params={{ siteId: site.id }}");
    expect(panelSource).not.toContain("href=");
    expect(workspaceSource).toContain(
      'import { Link } from "@tanstack/react-router";',
    );
    expect(workspaceSource).toContain("text-[0.88rem] text-admin-muted");
    expect(workspaceSource).not.toContain(
      '<a className="workspace-back" href="/">',
    );
  });
});
