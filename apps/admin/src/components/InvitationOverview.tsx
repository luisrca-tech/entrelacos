import type { SiteHomeSummary } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { CalendarClock } from "lucide-react";
import type { InvitationSummary } from "./invitationView";
import { PageHeaderActions } from "./PageHeaderActions";

type Props = {
  summary: InvitationSummary;
  /** Wedding-wide counts; when present they replace the loaded-page summary. */
  siteTotals?: SiteHomeSummary["invitations"] | null;
  inactive: boolean;
  onAdd: () => void;
  onManageConfirmations: () => void;
  onExport: () => void;
  onConfigureDeadline: () => void;
  deadline?: string | null;
  /** Time left to answer, e.g. "Faltam 3 dias para encerrar as respostas". */
  deadlineCountdown?: string | null;
  partial?: boolean;
};

export function InvitationOverview({
  summary,
  inactive,
  onAdd,
  onManageConfirmations,
  onExport,
  onConfigureDeadline,
  deadline,
  deadlineCountdown,
  partial,
  siteTotals,
}: Props) {
  const counts = siteTotals
    ? {
        invitations: siteTotals.total,
        guests: siteTotals.confirmed + siteTotals.pending + siteTotals.declined,
        adults: siteTotals.adults,
        children: siteTotals.children,
        confirmed: siteTotals.confirmed,
        pending: siteTotals.pending,
        declined: siteTotals.declined,
      }
    : summary;
  const statuses = [
    {
      title: "Confirmados",
      count: counts.confirmed,
      color: "bg-admin-status-confirmed",
    },
    {
      title: "Sem resposta",
      count: counts.pending,
      color: "bg-admin-status-pending",
    },
    {
      title: "Não irão",
      count: counts.declined,
      color: "bg-admin-status-declined",
    },
  ];
  return (
    <div className="grid gap-3.5">
      <PageHeaderActions>
        <Button type="button" variant="outline" onClick={onExport}>
          Exportar
        </Button>
        <Button
          type="button"
          onClick={onAdd}
          disabled={inactive}
          className="bg-admin-terracotta text-white hover:bg-admin-terracotta-deep"
        >
          Novo convite
        </Button>
      </PageHeaderActions>
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
        <section
          className="grid gap-2.5 rounded-2xl border border-admin-line bg-admin-surface p-5"
          aria-label="Resumo dos convites"
        >
          <p className="m-0 text-xs text-admin-muted">
            {!siteTotals && partial
              ? "Respostas dos convites carregados nesta lista"
              : "Respostas dos convidados"}
          </p>
          <h2 className="m-0 font-admin-display text-2xl font-normal">
            {counts.confirmed} de {counts.guests} convidados irão comparecer
          </h2>
          <p className="m-0 text-xs text-admin-muted">
            {counts.invitations}{" "}
            {counts.invitations === 1 ? "convite" : "convites"} ·{" "}
            {counts.adults} {counts.adults === 1 ? "adulto" : "adultos"} ·{" "}
            {counts.children} {counts.children === 1 ? "criança" : "crianças"}
          </p>
          {counts.guests > 0 && (
            <div className="flex h-3 gap-1" aria-hidden="true">
              {statuses
                .filter((status) => status.count > 0)
                .map((status) => (
                  <span
                    key={status.title}
                    style={{ flexGrow: status.count }}
                    className={`rounded-full ${status.color}`}
                  />
                ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {statuses.map((status) => (
              <span
                key={status.title}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  className={`size-2 rounded-full ${status.color}`}
                  aria-hidden="true"
                />
                {status.title} <strong>{status.count}</strong>
              </span>
            ))}
          </div>
          <Button
            type="button"
            variant="link"
            onClick={onManageConfirmations}
            className="h-auto w-fit p-0 text-admin-terracotta-deep"
          >
            Gerenciar confirmações
          </Button>
        </section>
        <section className="grid content-start gap-2 rounded-2xl border border-admin-line bg-admin-surface p-5">
          <h2 className="m-0 flex items-center gap-2 text-xs font-normal text-admin-muted">
            <CalendarClock aria-hidden="true" className="size-4" />
            Prazo de confirmação
          </h2>
          <div className="grid gap-0.5">
            <p className="m-0 font-admin-display text-xl">
              {deadline ?? "Sem prazo definido"}
            </p>
            {deadline && deadlineCountdown && (
              <p className="m-0 text-[13px] text-admin-pending-ink">
                {deadlineCountdown}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="link"
            onClick={onConfigureDeadline}
            disabled={inactive}
            className="h-auto w-fit p-0 text-admin-terracotta-deep"
          >
            Alterar prazo
          </Button>
        </section>
      </div>
    </div>
  );
}
