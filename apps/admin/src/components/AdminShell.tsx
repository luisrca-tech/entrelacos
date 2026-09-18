import type { MeResponse } from "@entrelacos/contracts";
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Toaster,
} from "@entrelacos/ui";
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
    <div
      className={cn(
        "grid min-h-screen grid-cols-[248px_minmax(0,1fr)] max-[760px]:block min-[761px]:max-[1060px]:grid-cols-[216px_minmax(0,1fr)]",
        siteId && "max-[760px]:pb-[calc(74px+env(safe-area-inset-bottom))]",
      )}
    >
      <aside
        className="sticky top-0 flex h-screen flex-col gap-[30px] border-r border-admin-line bg-admin-surface px-5 pt-[30px] pb-[22px] max-[760px]:hidden min-[761px]:max-[1060px]:w-[216px]"
        aria-label="Navegação principal"
      >
        <div className="grid gap-2">
          <Link
            className="font-admin-display text-[1.45rem] tracking-[-0.03em] text-admin-graphite no-underline"
            to="/"
          >
            EntreLaços
          </Link>
          <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
            Painel de casamentos
          </span>
        </div>
        {siteId && (
          <div className="grid gap-2 rounded-xl border border-admin-line bg-admin-canvas p-[15px]">
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
              Casamento atual
            </span>
            {siteName && <strong className="truncate">{siteName}</strong>}
          </div>
        )}
        {siteId ? (
          <nav className="block" aria-label="Navegação do casamento">
            <AdminNavigation area={area} items={navigation} />
          </nav>
        ) : (
          <nav className="grid gap-1" aria-label="Navegação global">
            <Link
              className="flex min-h-[42px] items-center gap-3 rounded-[9px] bg-admin-terracotta-wash px-3 py-2 text-[0.9rem] font-bold text-admin-terracotta-deep no-underline transition-[background,color] duration-150 ease-in-out"
              to="/"
              aria-current="page"
            >
              <span
                className="grid w-5 place-items-center text-[1.1rem] leading-none"
                aria-hidden="true"
              >
                ⌂
              </span>
              <span>Casamentos</span>
            </Link>
          </nav>
        )}
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="mx-auto flex min-h-[82px] w-full max-w-[1440px] items-center justify-end gap-[18px] border-b border-admin-line px-[42px] py-[18px] max-[760px]:min-h-[68px] max-[760px]:px-5 max-[760px]:py-[14px] min-[761px]:max-[1060px]:px-7">
          <Link
            className="mr-auto hidden font-admin-display text-[1.45rem] tracking-[-0.03em] text-admin-graphite no-underline max-[760px]:block"
            to="/"
          >
            EntreLaços
          </Link>
          <div className="mr-auto flex items-center gap-2 text-[0.85rem] text-admin-muted max-[760px]:hidden">
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
              {role === "OWNER" ? "Conta proprietária" : "Acesso de equipe"}
            </span>
          </div>
          <AccountMenu actor={actor} initials={initials} onLogout={onLogout} />
        </header>
        <main className="mx-auto w-full max-w-[1440px] px-[42px] pt-12 pb-6 max-[760px]:px-5 max-[760px]:pt-[34px] max-[760px]:pb-6 min-[761px]:max-[1060px]:px-7">
          {children}
        </main>
        <footer className="mx-auto mt-auto flex w-full max-w-[1440px] justify-between gap-6 border-t border-admin-line px-[42px] pt-6 pb-7 text-[0.78rem] text-admin-muted max-[760px]:hidden min-[761px]:max-[1060px]:px-7">
          <span>EntreLaços · Painel administrativo</span>
          <span>Feito para cuidar de cada detalhe.</span>
        </footer>
      </div>

      {siteId && (
        <nav
          className="fixed right-0 bottom-0 left-0 z-[8] hidden border-t border-admin-line bg-[rgb(255_253_249_/_96%)] px-2.5 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(68_49_36_/_8%)] max-[760px]:block"
          aria-label="Navegação do casamento"
        >
          <AdminNavigation area={area} items={navigation} mobile />
        </nav>
      )}
      <Toaster />
    </div>
  );
}

function AdminNavigation({
  items,
  area,
  mobile = false,
}: {
  items: ReturnType<typeof getSiteNavigation>;
  area?: SiteArea;
  mobile?: boolean;
}) {
  return (
    <div className={cn("grid gap-1", mobile && "flex justify-around gap-0.5")}>
      {items.map((item) => (
        <Link
          className={cn(
            mobile
              ? "grid min-h-[54px] flex-1 basis-0 place-items-center gap-[3px] px-[3px] py-1.5 text-center text-[0.65rem] text-admin-muted no-underline"
              : "flex min-h-[42px] items-center gap-3 rounded-[9px] px-3 py-2 text-[0.9rem] text-admin-muted no-underline transition-[background,color] duration-150 ease-in-out hover:bg-admin-terracotta-wash hover:text-admin-terracotta-deep",
            item.area === area &&
              "bg-admin-terracotta-wash font-bold text-admin-terracotta-deep",
          )}
          to={item.href}
          aria-current={item.area === area ? "page" : undefined}
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
        className="grid size-[42px] shrink-0 place-items-center rounded-full border border-[rgb(142_58_42_/_22%)] bg-admin-terracotta-wash text-[0.78rem] font-extrabold tracking-[0.04em] text-admin-terracotta-deep transition-colors hover:border-admin-terracotta hover:bg-admin-terracotta hover:text-[#fffaf6] aria-expanded:border-admin-terracotta aria-expanded:bg-admin-terracotta aria-expanded:text-[#fffaf6]"
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
