import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

const benefits = [
  "Convites e confirmações",
  "Lista de presentes",
  "Recebimentos por Pix e cartão",
];

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-admin-surface text-admin-ink md:grid md:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] md:py-4 md:pr-4">
      <section className="grid min-w-0 content-start gap-10 px-4 pt-5 pb-6 md:content-between md:gap-8 md:px-[clamp(24px,5vw,64px)] md:py-6">
        <Link
          className="flex w-fit items-center gap-2.5 font-admin-display text-[22px] leading-none md:text-[25px] no-underline"
          to="/"
        >
          <img src="/brand/entrelacos-mark.svg" width="39" height="36" alt="" />
          Entrelaços
        </Link>
        <div className="w-full max-w-[400px]">{children}</div>
        <p className="m-0 hidden text-xs text-admin-muted md:block">
          Seu painel do casamento
        </p>
      </section>
      <aside
        className="hidden min-w-0 flex-col justify-between gap-12 rounded-[20px] bg-admin-beige p-[clamp(24px,4.375vw,56px)] md:flex"
        aria-label="Sobre o painel"
      >
        <img src="/brand/entrelacos-mark.svg" width="104" height="96" alt="" />
        <div className="grid gap-4">
          <p className="m-0 max-w-[470px] font-admin-display text-[clamp(32px,4.06vw,52px)] leading-[1.06] tracking-tight">
            Seu casamento, mais simples de organizar.
          </p>
          <p className="m-0 max-w-[400px] leading-relaxed text-admin-body">
            Convites, presentes e recebimentos em um só painel, no ritmo de
            vocês.
          </p>
        </div>
        <ul className="m-0 grid list-none gap-3 p-0 text-[15px] text-admin-graphite">
          {benefits.map((benefit) => (
            <li key={benefit} className="flex items-center gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-admin-surface text-admin-terracotta-deep">
                <Check aria-hidden="true" className="size-4" />
              </span>
              {benefit}
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}
