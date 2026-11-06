import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { displayHeading } from "../lib/adminStyles";
import { type ReadyReceivingPage, receivingTabs } from "./receivingNavigation";
import {
  type ReceivingStepId,
  type ReceivingStepStatus,
  type ReceivingTrackStep,
  receivingStepStatusLabel,
} from "./receivingTrack";

export const receivingCard =
  "min-w-0 rounded-2xl border border-admin-line bg-admin-surface";
export const receivingLink =
  "font-semibold text-admin-terracotta-deep underline underline-offset-4 hover:text-admin-terracotta-ink";
export const receivingEyebrow =
  "m-0 text-[0.8rem] font-bold uppercase tracking-[0.06em] text-admin-terracotta-deep";
export const receivingStepTitle = `m-0 text-[clamp(1.75rem,3vw,2.25rem)] text-admin-ink ${displayHeading}`;
export const receivingBody = "m-0 text-[0.95rem] leading-[1.6] text-admin-body";
export const receivingPrimaryAction =
  "inline-flex min-h-12 w-fit items-center justify-center gap-2 rounded-[10px] bg-admin-terracotta px-6 text-[0.95rem] font-bold text-white no-underline transition-colors hover:bg-admin-terracotta-deep motion-reduce:transition-none disabled:cursor-not-allowed disabled:bg-admin-beige-deep disabled:text-admin-muted [@media(max-width:760px)]:w-full";
export const receivingSecondaryAction =
  "inline-flex min-h-12 w-fit items-center justify-center gap-2 rounded-[10px] border border-admin-line-strong bg-admin-surface px-6 text-[0.95rem] font-semibold text-admin-graphite no-underline transition-colors hover:bg-admin-canvas motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60";
export const receivingField =
  "min-h-[46px] w-full min-w-0 rounded-[10px] border border-admin-line-strong bg-admin-surface px-3.5 text-[0.95rem] text-admin-ink placeholder:text-admin-muted focus:border-admin-terracotta focus:outline-[3px] focus:outline-offset-2 focus:outline-[rgb(168_77_57_/_20%)] disabled:cursor-not-allowed disabled:opacity-60";

const badgeTone: Record<ReceivingStepStatus, string> = {
  done: "bg-admin-success-wash text-admin-success-ink",
  current: "bg-admin-terracotta-wash text-admin-terracotta-ink",
  review: "bg-admin-pending-wash text-admin-pending-ink",
  attention: "bg-admin-danger-wash text-admin-danger-ink",
  available: "bg-admin-beige text-admin-body",
  locked: "bg-admin-beige text-admin-muted",
};

export function StatusBadge({
  status,
  children,
}: {
  status: ReceivingStepStatus;
  children?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-1 text-xs leading-none font-bold ${badgeTone[status]}`}
    >
      {children ?? receivingStepStatusLabel[status]}
    </span>
  );
}

export function StepIndicator({
  number,
  status,
}: {
  number: number;
  status: ReceivingStepStatus;
}) {
  const tone =
    status === "done"
      ? "bg-admin-status-confirmed text-white"
      : status === "current"
        ? "bg-admin-terracotta text-white"
        : status === "review"
          ? "border-2 border-admin-status-pending bg-admin-pending-wash text-admin-pending-ink"
          : status === "attention"
            ? "border-2 border-admin-status-declined bg-admin-danger-wash text-admin-danger-ink"
            : status === "available"
              ? "border-2 border-admin-terracotta bg-admin-surface text-admin-terracotta-deep"
              : "border-2 border-admin-line-strong bg-admin-surface text-admin-muted";
  return (
    <span
      aria-hidden="true"
      className={`flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${tone}`}
    >
      {status === "done" ? <Check className="size-[18px]" /> : number}
    </span>
  );
}

export function ProgressBar({ completed }: { completed: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Etapas concluídas"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={completed}
      className="h-2 w-full overflow-hidden rounded-full bg-admin-beige"
    >
      <div
        className="h-full rounded-full bg-admin-terracotta"
        style={{ width: `${(completed / 5) * 100}%` }}
      />
    </div>
  );
}

function pillLabel(step: ReceivingTrackStep, compact: boolean) {
  if (step.status === "review") return `${step.number} Em análise`;
  if (step.status === "done" && compact) return `${step.number}`;
  return `${step.number} ${step.short}`;
}

export function StepPills({
  siteId,
  steps,
  current,
}: {
  siteId: string;
  steps: ReceivingTrackStep[];
  current: ReceivingStepId;
}) {
  const currentNumber = steps.find(({ id }) => id === current)?.number ?? 1;
  const compact = currentNumber >= 4;
  return (
    <nav aria-label="Etapas dos recebimentos" className="min-w-0">
      <ol className="m-0 flex list-none flex-wrap justify-end gap-1 p-0 [@media(max-width:760px)]:justify-start">
        {steps.map((step) => {
          const active = step.id === current;
          const tone = active
            ? "bg-admin-terracotta text-white"
            : step.status === "done"
              ? "bg-admin-success-wash text-admin-success-ink"
              : step.status === "review"
                ? "bg-admin-pending-wash text-admin-pending-ink"
                : step.status === "attention"
                  ? "bg-admin-danger-wash text-admin-danger-ink"
                  : step.status === "locked"
                    ? "bg-admin-beige text-admin-muted"
                    : "bg-admin-terracotta-wash text-admin-terracotta-deep";
          const content = (
            <>
              {pillLabel(step, compact && !active)}
              {step.status === "done" && (
                <Check aria-hidden="true" className="size-3.5" />
              )}
              <span className="sr-only">
                {" "}
                ({receivingStepStatusLabel[step.status]})
              </span>
            </>
          );
          const className = `inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.8rem] font-semibold no-underline ${tone}`;
          return (
            <li key={step.id}>
              {step.status === "locked" && !active ? (
                <span className={className}>{content}</span>
              ) : (
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{ siteId, page: step.id }}
                  aria-current={active ? "step" : undefined}
                  className={className}
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function StepFrame({
  siteId,
  steps,
  current,
  children,
  aside,
}: {
  siteId: string;
  steps: ReceivingTrackStep[];
  current: ReceivingStepId;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Link
          to="/sites/$siteId/receiving"
          params={{ siteId }}
          className="inline-flex min-h-8 items-center gap-1 text-[0.95rem] font-semibold text-admin-terracotta-deep no-underline hover:underline"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          Recebimentos
        </Link>
        <StepPills siteId={siteId} steps={steps} current={current} />
      </div>
      {aside ? (
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid min-w-0 gap-5">{children}</div>
          <aside className="grid min-w-0 gap-5">{aside}</aside>
        </div>
      ) : (
        <div className="grid min-w-0 gap-6">{children}</div>
      )}
    </div>
  );
}

export function StepHeading({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="grid gap-3">
      <p className={receivingEyebrow}>Etapa {number} de 5</p>
      <h1 className={receivingStepTitle}>{title}</h1>
      {children}
    </header>
  );
}

export function AsideCard({
  title,
  tone = "surface",
  icon,
  children,
}: {
  title: string;
  tone?: "surface" | "accent";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`grid min-w-0 gap-3 rounded-2xl p-[22px] ${tone === "accent" ? "bg-admin-terracotta-wash text-admin-terracotta-ink" : "border border-admin-line bg-admin-surface"}`}
    >
      <h2
        className={`m-0 flex items-center gap-2 text-base font-bold ${tone === "accent" ? "text-admin-terracotta-ink" : "text-admin-ink"}`}
      >
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function FaqList({
  title = "Dúvidas desta etapa",
  items,
  footer,
}: {
  title?: string;
  items: { question: string; answer: ReactNode }[];
  footer?: ReactNode;
}) {
  return (
    <section
      id="duvidas"
      className="grid min-w-0 scroll-mt-6 gap-1 rounded-2xl border border-admin-line bg-admin-surface p-[22px]"
    >
      <h2 className="m-0 mb-1.5 text-base font-bold text-admin-ink">{title}</h2>
      {items.map((item) => (
        <details key={item.question} className="group py-1.5">
          <summary className="flex min-h-8 cursor-pointer list-none items-start gap-2 text-sm font-semibold text-admin-ink [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="w-3 shrink-0 text-admin-muted group-open:hidden"
            >
              +
            </span>
            <span
              aria-hidden="true"
              className="hidden w-3 shrink-0 text-admin-muted group-open:inline"
            >
              –
            </span>
            {item.question}
          </summary>
          <div className="mt-1 grid gap-2 pl-5 text-sm leading-[1.55] text-admin-body">
            {item.answer}
          </div>
        </details>
      ))}
      {footer}
    </section>
  );
}

export function ExternalLink({
  href,
  children,
  className = receivingLink,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <span className="sr-only"> (abre em outra aba)</span>
    </a>
  );
}

// Ready state (readiness = READY): tabs, page header and shared card styles.
export const readyCard =
  "min-w-0 rounded-[18px] border border-admin-line bg-admin-surface";
export const readyCardTitle = "m-0 text-[17px] font-bold text-admin-ink";
export const readyLabel = "m-0 text-sm font-bold text-admin-muted";
export const readyLinkButton =
  "inline-flex min-h-11 items-center gap-1.5 bg-transparent p-0 text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4 hover:text-admin-terracotta-ink disabled:cursor-not-allowed disabled:opacity-60";
export const readyQuietButton =
  "inline-flex min-h-11 items-center gap-1.5 bg-transparent p-0 text-[13px] text-admin-muted hover:text-admin-graphite disabled:cursor-not-allowed disabled:opacity-60";

const readySubtitles: Record<ReadyReceivingPage, string> = {
  overview:
    "Acompanhe os presentes recebidos e o dinheiro disponível para saque.",
  payments: "Cada presente pago pelos convidados, com o que fica para vocês.",
  withdrawals: "Saque o saldo disponível para a sua conta bancária.",
  settings: "Conta para saque, taxas e quem recebe os presentes.",
};

export function ReadyReceivingHeader({
  siteId,
  page,
}: {
  siteId: string;
  page: ReadyReceivingPage;
}) {
  return (
    <header className="grid min-w-0 gap-4">
      <div className="grid gap-1.5">
        <h1 className={receivingStepTitle}>Recebimentos</h1>
        <p className="m-0 text-[15px] leading-[1.5] text-admin-muted">
          {readySubtitles[page]}
        </p>
      </div>
      <nav
        aria-label="Páginas de recebimentos"
        className="flex w-fit max-w-full min-w-0 gap-1 rounded-xl border border-admin-line bg-admin-surface p-1 [@media(max-width:560px)]:grid [@media(max-width:560px)]:w-full [@media(max-width:560px)]:grid-cols-2"
      >
        {receivingTabs(true).map((item) => (
          <Link
            key={item.id}
            activeOptions={{ exact: true }}
            to={
              item.id === "overview"
                ? "/sites/$siteId/receiving"
                : "/sites/$siteId/receiving/$page"
            }
            params={{ siteId, page: item.id }}
            aria-current={page === item.id ? "page" : undefined}
            className={`inline-flex min-h-[38px] shrink-0 items-center justify-center whitespace-nowrap rounded-[9px] px-4 text-sm font-semibold no-underline transition-colors motion-reduce:transition-none [@media(max-width:760px)]:px-3 ${page === item.id ? "bg-admin-graphite text-white" : "text-admin-muted hover:bg-admin-canvas hover:text-admin-graphite"}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export type ToneName = "success" | "pending" | "danger" | "neutral";
const toneClass: Record<ToneName, string> = {
  success: "bg-admin-success-wash text-admin-success-ink",
  pending: "bg-admin-pending-wash text-admin-pending-ink",
  danger: "bg-admin-danger-wash text-admin-danger-ink",
  neutral: "bg-admin-beige text-admin-body",
};

export function ToneBadge({
  tone,
  children,
}: {
  tone: ToneName;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="status-badge"
      className={`inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-1 text-xs leading-none font-bold whitespace-nowrap ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      className="m-0 flex items-start gap-2.5 rounded-xl border border-admin-line bg-admin-surface px-4 py-3 text-sm leading-[1.5] text-admin-body"
    >
      <Lock
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-admin-muted"
      />
      <span>{children}</span>
    </p>
  );
}
