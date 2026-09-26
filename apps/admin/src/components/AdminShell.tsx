import type { MeResponse } from "@entrelacos/contracts";
import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type ReactNode, useState } from "react";
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
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      className={cn(
        "grid min-h-screen transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none [@media(max-width:760px)]:block",
        expanded
          ? "grid-cols-[248px_minmax(0,1fr)] [@media(min-width:761px)_and_(max-width:1060px)]:grid-cols-[216px_minmax(0,1fr)]"
          : "grid-cols-[76px_minmax(0,1fr)]",
        siteId &&
          "[@media(max-width:760px)]:pb-[calc(74px+env(safe-area-inset-bottom))]",
      )}
    >
      <aside
        id="admin-primary-nav"
        className={cn(
          "sticky top-0 flex h-screen w-full min-w-0 flex-col overflow-x-hidden border-r border-admin-line bg-admin-surface pt-[30px] pb-[22px] transition-[padding] duration-200 ease-out motion-reduce:transition-none [@media(max-width:760px)]:hidden",
          expanded ? "px-5" : "px-2",
        )}
        aria-label="Navegação principal"
      >
        <div
          className={cn(
            "grid items-center transition-[grid-template-columns,gap] duration-200 ease-out motion-reduce:transition-none",
            expanded
              ? "grid-cols-[minmax(0,1fr)_auto] gap-2"
              : "grid-cols-1 justify-items-center gap-2",
          )}
        >
          <Link
            className={cn(
              "relative grid min-w-0 place-items-center overflow-hidden no-underline",
              expanded ? "justify-items-start" : "justify-items-center",
            )}
            to="/"
            aria-label="EntreLaços — início"
          >
            <img
              src="/brand/entrelacos-logo.svg"
              alt=""
              aria-hidden="true"
              className={cn(
                "h-9 w-full object-contain object-left transition-opacity duration-200 ease-out motion-reduce:transition-none",
                "col-start-1 row-start-1",
                expanded ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            />
            <img
              src="/brand/entrelacos-favicon.svg"
              alt=""
              aria-hidden="true"
              className={cn(
                "size-7 object-contain transition-opacity duration-200 ease-out motion-reduce:transition-none",
                "col-start-1 row-start-1",
                expanded ? "pointer-events-none opacity-0" : "opacity-100",
              )}
            />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0 justify-self-center text-admin-muted hover:bg-admin-terracotta-wash hover:text-admin-terracotta-deep"
            aria-expanded={expanded}
            aria-controls="admin-primary-nav"
            aria-label={expanded ? "Recolher navegação" : "Expandir navegação"}
            onClick={() => setExpanded((open) => !open)}
          >
            <span className="relative grid size-4 place-items-center">
              <PanelLeftClose
                aria-hidden="true"
                className={cn(
                  "col-start-1 row-start-1 size-4 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "opacity-100" : "opacity-0",
                )}
              />
              <PanelLeftOpen
                aria-hidden="true"
                className={cn(
                  "col-start-1 row-start-1 size-4 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "opacity-0" : "opacity-100",
                )}
              />
            </span>
          </Button>
        </div>
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
            expanded
              ? "mt-2 grid-rows-[1fr] opacity-100"
              : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
              Painel de casamentos
            </span>
            {siteId && (
              <div className="mt-[30px] grid gap-2 rounded-xl border border-admin-line bg-admin-canvas p-[15px]">
                <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
                  Casamento atual
                </span>
                {siteName && <strong className="truncate">{siteName}</strong>}
              </div>
            )}
          </div>
        </div>
        {siteId ? (
          <nav
            className={cn(
              "block transition-[margin-top] duration-200 ease-out motion-reduce:transition-none",
              expanded ? "mt-[30px]" : "mt-6",
            )}
            aria-label="Navegação do casamento"
          >
            <AdminNavigation
              area={area}
              collapsed={!expanded}
              items={navigation}
            />
          </nav>
        ) : (
          <nav
            className={cn(
              "grid gap-1 transition-[margin-top] duration-200 ease-out motion-reduce:transition-none",
              expanded ? "mt-[30px]" : "mt-6",
            )}
            aria-label="Navegação global"
          >
            <Link
              className={navigationLinkClass(true, !expanded, false)}
              to="/"
              aria-current="page"
              title={expanded ? undefined : "Casamentos"}
            >
              <span
                className="grid w-5 place-items-center text-[1.1rem] leading-none"
                aria-hidden="true"
              >
                ⌂
              </span>
              <NavigationLabel collapsed={!expanded}>
                Casamentos
              </NavigationLabel>
            </Link>
          </nav>
        )}
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="mx-auto flex w-full max-w-[1700px] items-center justify-end gap-[18px] border-b border-admin-line px-[42px] py-2.5 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:py-2 [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          <Link
            className="mr-auto hidden font-admin-display text-[1.45rem] tracking-[-0.03em] text-admin-graphite no-underline [@media(max-width:760px)]:block"
            to="/"
          >
            EntreLaços
          </Link>
          <div className="mr-auto flex items-center gap-2 text-[0.85rem] text-admin-muted [@media(max-width:760px)]:hidden">
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
              {role === "OWNER" ? "Conta proprietária" : "Acesso de equipe"}
            </span>
          </div>
          <AccountMenu actor={actor} initials={initials} onLogout={onLogout} />
        </header>
        <main className="mx-auto w-full max-w-[1700px] px-[42px] pt-6 pb-6 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:pt-5 [@media(max-width:760px)]:pb-6 [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          {children}
        </main>
        <footer className="mx-auto mt-auto flex w-full max-w-[1700px] justify-between gap-6 border-t border-admin-line px-[42px] pt-6 pb-7 text-[0.78rem] text-admin-muted [@media(max-width:760px)]:hidden [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          <span>EntreLaços · Painel administrativo</span>
          <span>Feito para cuidar de cada detalhe.</span>
        </footer>
      </div>

      {siteId && (
        <nav
          className="fixed right-0 bottom-0 left-0 z-[8] hidden border-t border-admin-line bg-[rgb(255_253_249_/_96%)] px-2.5 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(68_49_36_/_8%)] [@media(max-width:760px)]:block"
          aria-label="Navegação do casamento"
        >
          <AdminNavigation area={area} items={navigation} mobile />
        </nav>
      )}
    </div>
  );
}

function AdminNavigation({
  items,
  area,
  collapsed = false,
  mobile = false,
}: {
  items: ReturnType<typeof getSiteNavigation>;
  area?: SiteArea;
  collapsed?: boolean;
  mobile?: boolean;
}) {
  return (
    <div className={cn("grid gap-1", mobile && "flex justify-around gap-0.5")}>
      {items.map((item) => (
        <Link
          className={navigationLinkClass(item.area === area, collapsed, mobile)}
          to={item.href}
          aria-current={item.area === area ? "page" : undefined}
          title={collapsed && !mobile ? item.label : undefined}
          key={item.area}
        >
          <span
            className={cn(
              "grid w-5 place-items-center text-[1.1rem] leading-none",
              mobile && "text-base",
            )}
            aria-hidden="true"
          >
            {navigationIcon(item.area)}
          </span>
          <NavigationLabel collapsed={collapsed && !mobile}>
            {item.label}
          </NavigationLabel>
        </Link>
      ))}
    </div>
  );
}

function navigationLinkClass(
  active: boolean,
  collapsed: boolean,
  mobile: boolean,
) {
  return cn(
    mobile
      ? "grid min-h-[54px] flex-1 basis-0 place-items-center gap-[3px] px-[3px] py-1.5 text-center text-[0.65rem] text-admin-muted no-underline"
      : "grid min-h-[42px] items-center overflow-hidden rounded-[9px] py-2 text-[0.9rem] text-admin-muted no-underline transition-[grid-template-columns,gap,padding,background,color] duration-200 ease-out motion-reduce:transition-none hover:bg-admin-terracotta-wash hover:text-admin-terracotta-deep",
    !mobile &&
      (collapsed
        ? "grid-cols-[1fr_0fr] justify-items-center gap-0 px-0"
        : "grid-cols-[auto_minmax(0,1fr)] gap-3 px-3"),
    active && "bg-admin-terracotta-wash font-bold text-admin-terracotta-deep",
  );
}

function NavigationLabel({
  children,
  collapsed,
}: {
  children: string;
  collapsed: boolean;
}) {
  return (
    <span
      className={cn(
        "overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "max-w-0 opacity-0" : "max-w-40 opacity-100",
      )}
    >
      {children}
    </span>
  );
}

function navigationIcon(area: SiteArea) {
  switch (area) {
    case "invitations":
      return "○";
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
        className="grid size-[42px] shrink-0 place-items-center rounded-full border border-[rgb(142_58_42_/_22%)] bg-admin-terracotta-wash text-[0.78rem] font-extrabold tracking-[0.04em] text-admin-terracotta-deep transition-colors motion-reduce:transition-none hover:border-admin-terracotta hover:bg-admin-terracotta hover:text-[#fffaf6] aria-expanded:border-admin-terracotta aria-expanded:bg-admin-terracotta aria-expanded:text-[#fffaf6]"
        render={<button type="button" />}
      >
        {initials}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-10 w-[min(320px,calc(100vw-32px))] rounded-[14px] border border-admin-line bg-admin-surface p-[18px] shadow-admin"
      >
        <div className="flex items-center gap-3">
          <span
            className="grid size-12 shrink-0 place-items-center rounded-full border border-[rgb(142_58_42_/_22%)] bg-admin-terracotta-wash text-[0.78rem] font-extrabold tracking-[0.04em] text-admin-terracotta-deep"
            aria-hidden="true"
          >
            {initials}
          </span>
          <div className="grid min-w-0 gap-[3px]">
            <strong className="truncate">{actor.user.name}</strong>
            <span className="truncate text-[0.82rem] text-admin-muted">
              {actor.user.email}
            </span>
          </div>
        </div>
        <div className="my-4 border-t border-admin-line pt-3.5 text-[0.78rem] text-admin-muted">
          {actor.user.role === "OWNER"
            ? "Proprietário"
            : "Administrador do casamento"}
        </div>
        <button
          className="min-h-[38px] w-full rounded-lg border border-admin-line bg-transparent px-3 py-2 text-left text-admin-terracotta-deep hover:bg-admin-terracotta-wash"
          type="button"
          onClick={onLogout}
        >
          Sair
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function ShellLoading({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-admin-canvas p-6 text-admin-muted">
      {children}
    </main>
  );
}
