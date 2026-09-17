import type { MeResponse } from "@entrelacos/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  type AdminRole,
  getInitials,
  getSiteNavigation,
  type SiteArea,
} from "./adminNavigation";

type AdminShellProps = {
  actor: MeResponse;
  siteId?: string;
  siteName?: string;
  area?: SiteArea;
  onLogout: () => void;
  children: ReactNode;
};

export function AdminShell({
  actor,
  siteId,
  siteName,
  area,
  onLogout,
  children,
}: AdminShellProps) {
  const role = actor.user.role as AdminRole;
  const navigation = siteId ? getSiteNavigation(role, siteId) : [];
  const initials = getInitials(actor.user.name);

  return (
    <div className={`admin-app-shell${siteId ? " has-site-navigation" : ""}`}>
      <aside className="admin-sidebar" aria-label="Navegação principal">
        <div className="sidebar-top">
          <Link className="brand" to="/">
            EntreLaços
          </Link>
          <span className="sidebar-kicker">Painel de casamentos</span>
        </div>
        {siteId && (
          <div className="sidebar-site">
            <span className="sidebar-kicker">Casamento atual</span>
            {siteName && <strong>{siteName}</strong>}
          </div>
        )}
        {siteId ? (
          <nav
            className="admin-navigation-landmark"
            aria-label="Navegação do casamento"
          >
            <AdminNavigation area={area} items={navigation} />
          </nav>
        ) : (
          <nav className="admin-navigation" aria-label="Navegação global">
            <Link
              className="admin-nav-link is-active"
              to="/"
              aria-current="page"
            >
              <span className="admin-nav-icon" aria-hidden="true">
                ⌂
              </span>
              <span>Casamentos</span>
            </Link>
          </nav>
        )}
      </aside>

      <div className="admin-main-column">
        <header className="admin-topbar">
          <Link className="mobile-brand brand" to="/">
            EntreLaços
          </Link>
          <div className="topbar-context">
            <span className="topbar-kicker">
              {role === "OWNER" ? "Conta proprietária" : "Acesso de equipe"}
            </span>
          </div>
          <AccountMenu actor={actor} initials={initials} onLogout={onLogout} />
        </header>
        <main className="admin-content">{children}</main>
        <footer className="page-footer">
          <span>EntreLaços · Painel administrativo</span>
          <span>Feito para cuidar de cada detalhe.</span>
        </footer>
      </div>

      {siteId && (
        <nav className="mobile-navigation" aria-label="Navegação do casamento">
          <AdminNavigation area={area} items={navigation} />
        </nav>
      )}
    </div>
  );
}

function AdminNavigation({
  items,
  area,
}: {
  items: ReturnType<typeof getSiteNavigation>;
  area?: SiteArea;
}) {
  return (
    <div className="admin-navigation">
      {items.map((item) => (
        <Link
          className={`admin-nav-link${item.area === area ? " is-active" : ""}`}
          to={item.href}
          aria-current={item.area === area ? "page" : undefined}
          key={item.area}
        >
          <span className="admin-nav-icon" aria-hidden="true">
            {navigationIcon(item.area)}
          </span>
          <span>{item.label}</span>
        </Link>
      ))}
    </div>
  );
}

function navigationIcon(area: SiteArea) {
  switch (area) {
    case "overview":
      return "⌂";
    case "guests":
      return "○";
    case "rsvp":
      return "✓";
    case "messages":
      return "□";
    case "settings":
      return "⚙";
  }
}

function AccountMenu({
  actor,
  initials,
  onLogout,
}: {
  actor: MeResponse;
  initials: string;
  onLogout: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Abrir menu de ${actor.user.name}`}
        className="account-trigger"
        render={<button type="button" />}
      >
        {initials}
      </PopoverTrigger>
      <PopoverContent align="end" className="account-popover">
        <div className="account-popover-heading">
          <span
            className="account-avatar account-avatar-large"
            aria-hidden="true"
          >
            {initials}
          </span>
          <div>
            <strong>{actor.user.name}</strong>
            <span>{actor.user.email}</span>
          </div>
        </div>
        <div className="account-role">
          {actor.user.role === "OWNER"
            ? "Proprietário"
            : "Administrador do casamento"}
        </div>
        <button className="account-logout" type="button" onClick={onLogout}>
          Sair
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function ShellLoading({ children }: { children: ReactNode }) {
  return <main className="panel-loading-shell">{children}</main>;
}
