import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-admin-canvas p-6 max-[760px]:p-3">
      <div className="grid min-h-[min(680px,calc(100vh-48px))] w-full max-w-[1000px] grid-cols-[minmax(220px,0.78fr)_minmax(360px,1.22fr)] overflow-hidden rounded-[18px] border border-admin-line bg-admin-surface shadow-admin max-[760px]:block max-[760px]:min-h-[calc(100vh-24px)]">
        <aside
          className="flex flex-col bg-admin-graphite p-[34px] text-[#f8eee5] max-[760px]:min-h-[180px] max-[760px]:p-6"
          aria-label="EntreLaços"
        >
          <Link
            className="font-admin-display text-[1.45rem] tracking-[-0.03em] text-[#fffaf6] no-underline"
            to="/"
          >
            EntreLaços
          </Link>
          <div className="my-auto grid gap-6 max-[760px]:mt-[30px] max-[760px]:mb-0 max-[760px]:block">
            <span
              className="grid size-[54px] place-items-center rounded-full border border-[rgb(255_250_246_/_40%)] font-admin-display text-2xl max-[760px]:hidden"
              aria-hidden="true"
            >
              E
            </span>
            <p className="m-0 max-w-[11ch] font-admin-display text-[clamp(2.2rem,4vw,3.8rem)] leading-[1.05] max-[760px]:mt-3.5 max-[760px]:max-w-[24ch] max-[760px]:text-[1.65rem]">
              O seu dia, guardado com carinho.
            </p>
          </div>
          <span className="text-[0.78rem] text-[#c9b9ad] max-[760px]:hidden">
            Painel administrativo
          </span>
        </aside>
        <section className="grid items-center p-12 max-[760px]:px-[22px] max-[760px]:py-9">
          {children}
        </section>
      </div>
    </main>
  );
}
