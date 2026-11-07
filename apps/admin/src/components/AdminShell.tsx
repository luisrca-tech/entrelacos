import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Gift,
  House,
  Mail,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { AdminButton } from "./AdminButton";
import {
  type AdminRole,
  getInitials,
  getMobileNavigation,
  getSiteNavigation,
  type SiteArea,
} from "./adminNavigation";
import {
  setNavigationExpanded,
  useNavigationExpanded,
} from "./navigationPreference";

type AdminShellProps = {
  actor: MeResponse;
  siteId?: string;
  siteAccess?: SiteAccess;
  siteName?: string;
  area?: SiteArea;
  onLogout: () => void;
  children?: ReactNode;
};

export function AdminShell({
  actor,
  siteId,
  siteAccess,
  siteName,
  area,
  onLogout,
  children,
}: AdminShellProps) {
  const role = (siteAccess?.membershipRole ?? actor.user.role) as AdminRole;
  const navigation = siteId ? getSiteNavigation(role, siteId) : [];
  const navigationArea = area === "receiving-guide" ? "receiving" : area;
  const initials = getInitials(actor.user.name);
  const expanded = useNavigationExpanded();
  // A stored "collapsed" preference replaces the expanded server markup right
  // after hydration; skip transitions until then so the sidebar does not
  // visibly animate closed on a full page load.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className={cn(
        "grid min-h-screen transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none [@media(max-width:760px)]:block",
        !settled && "transition-none **:transition-none",
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
          "sticky top-0 flex h-screen w-full min-w-0 flex-col overflow-x-hidden border-r border-admin-border bg-admin-surface pt-[30px] pb-[22px] transition-[padding] duration-200 ease-out motion-reduce:transition-none [@media(max-width:760px)]:hidden",
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
            aria-label="Entrelaços — início"
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
              src="/brand/entrelacos-mark.svg"
              alt=""
              aria-hidden="true"
              className={cn(
                "size-7 object-contain transition-opacity duration-200 ease-out motion-reduce:transition-none",
                "col-start-1 row-start-1",
                expanded ? "pointer-events-none opacity-0" : "opacity-100",
              )}
            />
          </Link>
          <AdminButton
            type="button"
            tone="ghost"
            size="icon-sm"
            className="size-8 shrink-0 justify-self-center text-admin-text-secondary hover:bg-admin-accent-subtle hover:text-admin-accent-hover"
            aria-expanded={expanded}
            aria-controls="admin-primary-nav"
            aria-label={expanded ? "Recolher navegação" : "Expandir navegação"}
            onClick={() => setNavigationExpanded(!expanded)}
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
          </AdminButton>
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
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-text-secondary">
              Painel de casamentos
            </span>
            {siteId && (
              <div className="mt-[30px] grid gap-2 rounded-xl border border-admin-border bg-admin-canvas p-[15px]">
                <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-text-secondary">
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
              area={navigationArea}
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
        <header className="mx-auto flex w-full max-w-[1700px] items-center justify-end gap-[18px] border-b border-admin-border px-[42px] py-2.5 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:py-2 [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          <Link
            className="mr-auto hidden items-center gap-2 font-admin-display text-[1.45rem] tracking-[-0.03em] text-admin-text no-underline [@media(max-width:760px)]:flex"
            to="/"
          >
            <img
              src="/brand/entrelacos-mark.svg"
              width="32"
              height="30"
              alt=""
              aria-hidden="true"
            />
            Entrelaços
          </Link>
          <div className="mr-auto flex items-center gap-2 text-[0.85rem] text-admin-text-secondary [@media(max-width:760px)]:hidden">
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-text-secondary">
              {role === "OWNER" ? "Conta proprietária" : "Acesso de equipe"}
            </span>
          </div>
          <AccountMenu
            actor={actor}
            role={role}
            initials={initials}
            onLogout={onLogout}
          />
        </header>
        <main className="mx-auto w-full max-w-[1700px] px-[42px] pt-6 pb-6 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:pt-5 [@media(max-width:760px)]:pb-6 [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          {children}
        </main>
        <footer className="mx-auto mt-auto flex w-full max-w-[1700px] justify-between gap-6 border-t border-admin-border px-[42px] pt-6 pb-7 text-[0.78rem] text-admin-text-secondary [@media(max-width:760px)]:hidden [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
          <span className="flex items-center gap-2">
            <img
              src="/brand/entrelacos-mark.svg"
              width="24"
              height="22"
              alt=""
              aria-hidden="true"
            />
            Entrelaços · Painel administrativo
          </span>
          <span>Feito para cuidar de cada detalhe.</span>
        </footer>
      </div>

      {siteId && (
        <nav
          className="fixed right-0 bottom-0 left-0 z-[8] hidden border-t border-admin-border bg-admin-surface/96 px-2.5 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] shadow-admin-dock [@media(max-width:760px)]:block"
          aria-label="Navegação do casamento no celular"
        >
          <MobileNavigation area={navigationArea} items={navigation} />
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
          activeOptions={{ exact: item.area !== "receiving" }}
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
          <NavigationLabel collapsed={collapsed && !mobile} mobile={mobile}>
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
      ? "grid min-h-[54px] flex-1 basis-0 place-items-center gap-[3px] px-[3px] py-1.5 text-center text-[0.65rem] text-admin-text-secondary no-underline"
      : "grid min-h-[42px] items-center overflow-hidden rounded-[9px] py-2 text-[0.9rem] text-admin-text-secondary no-underline transition-[grid-template-columns,gap,padding,background,color] duration-200 ease-out motion-reduce:transition-none hover:bg-admin-accent-subtle hover:text-admin-accent-hover",
    !mobile &&
      (collapsed
        ? "grid-cols-[1fr_0fr] justify-items-center gap-0 px-0"
        : "grid-cols-[auto_minmax(0,1fr)] gap-3 px-3"),
    active && "bg-admin-accent-subtle font-bold text-admin-accent-hover",
  );
}

function NavigationLabel({
  children,
  collapsed,
  mobile = false,
}: {
  children: string;
  collapsed: boolean;
  mobile?: boolean;
}) {
  return (
    <span
      className={cn(
        "overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-out motion-reduce:transition-none",
        mobile &&
          "min-w-0 max-w-full whitespace-normal break-words leading-tight",
        collapsed ? "max-w-0 opacity-0" : "max-w-40 opacity-100",
      )}
    >
      {children}
    </span>
  );
}

function navigationIcon(area: SiteArea) {
  const icons = {
    home: House,
    invitations: Mail,
    messages: MessageCircle,
    gifts: Gift,
    receiving: Wallet,
    "receiving-guide": BookOpen,
    team: Users,
    settings: Settings2,
  };
  const Icon = icons[area];
  return <Icon aria-hidden="true" className="size-[18px]" />;
}

function MobileNavigation({
  items,
  area,
}: {
  items: ReturnType<typeof getSiteNavigation>;
  area?: SiteArea;
}) {
  const [open, setOpen] = useState(false);
  const { primary, more } = getMobileNavigation(items);
  const selected = more.some((item) => item.area === area);
  return (
    <div className="flex items-stretch gap-0.5">
      <div className="min-w-0 flex-1">
        <AdminNavigation items={primary} area={area} mobile />
      </div>
      {more.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label="Mais páginas"
            aria-current={selected ? "page" : undefined}
            render={<button type="button" />}
            className={cn(
              navigationLinkClass(selected, false, true),
              "max-w-[20%] min-w-[54px]",
            )}
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
            <span>Mais</span>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            className="z-20 w-[min(260px,calc(100vw-24px))] rounded-xl border border-admin-border bg-admin-surface p-2 shadow-admin"
          >
            <nav
              aria-label="Outras páginas do casamento"
              className="grid gap-1"
            >
              {more.map((item) => (
                <Link
                  key={item.area}
                  to={item.href}
                  activeOptions={{ exact: true }}
                  aria-current={item.area === area ? "page" : undefined}
                  className={navigationLinkClass(
                    item.area === area,
                    false,
                    false,
                  )}
                  onClick={() => setOpen(false)}
                >
                  {navigationIcon(item.area)}
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function AccountMenu({
  actor,
  role,
  initials,
  onLogout,
}: {
  actor: MeResponse;
  role: AdminRole;
  initials: string;
  onLogout: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Abrir menu de ${actor.user.name}`}
        className="grid size-[42px] shrink-0 place-items-center rounded-full border border-admin-accent-hover/22 bg-admin-accent-subtle text-[0.78rem] font-extrabold tracking-[0.04em] text-admin-accent-hover transition-colors motion-reduce:transition-none hover:border-admin-accent hover:bg-admin-accent hover:text-admin-on-accent aria-expanded:border-admin-accent aria-expanded:bg-admin-accent aria-expanded:text-admin-on-accent"
        render={<button type="button" />}
      >
        {initials}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-10 w-[min(320px,calc(100vw-32px))] rounded-[14px] border border-admin-border bg-admin-surface p-[18px] shadow-admin"
      >
        <div className="flex items-center gap-3">
          <span
            className="grid size-12 shrink-0 place-items-center rounded-full border border-admin-accent-hover/22 bg-admin-accent-subtle text-[0.78rem] font-extrabold tracking-[0.04em] text-admin-accent-hover"
            aria-hidden="true"
          >
            {initials}
          </span>
          <div className="grid min-w-0 gap-[3px]">
            <strong className="truncate">{actor.user.name}</strong>
            <span className="truncate text-[0.82rem] text-admin-text-secondary">
              {actor.user.email}
            </span>
          </div>
        </div>
        <div className="my-4 border-t border-admin-border pt-3.5 text-[0.78rem] text-admin-text-secondary">
          {role === "OWNER"
            ? "Proprietário"
            : role === "SITE_ASSISTANT"
              ? "Assessor do casamento"
              : "Administrador do casamento"}
        </div>
        <button
          className="min-h-[38px] w-full rounded-lg border border-admin-border bg-transparent px-3 py-2 text-left text-admin-accent-hover hover:bg-admin-accent-subtle"
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
    <main className="grid min-h-screen place-items-center bg-admin-canvas p-6 text-admin-text-secondary">
      {children}
    </main>
  );
}
