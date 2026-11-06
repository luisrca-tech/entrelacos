import { Link } from "@tanstack/react-router";
import { ArrowRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function HomeAreaCard({
  icon: Icon,
  title,
  description,
  href,
  action = "Abrir",
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  action?: string;
  children?: ReactNode;
}) {
  return (
    <article className="grid min-w-0 content-start gap-3.5 rounded-xl border border-admin-line bg-admin-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-admin-beige text-admin-terracotta-deep">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h3 className="m-0 font-sans! text-base! font-semibold! text-admin-ink">
          {title}
        </h3>
      </div>
      <p className="m-0 text-sm leading-relaxed text-admin-body">
        {description}
      </p>
      {children}
      <Link
        to={href}
        className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-admin-terracotta-deep hover:underline"
        aria-label={`${action} ${title}`}
      >
        {action}
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </article>
  );
}
