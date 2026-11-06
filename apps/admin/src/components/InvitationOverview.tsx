import type { SiteHomeSummary } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { CalendarClock } from "lucide-react";
import {
  countLabel,
  type InvitationSummary,
  invitationBudget,
  invitationSummaryFromTotals,
  peopleCount,
} from "./invitationView";
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
  const counts = siteTotals ? invitationSummaryFromTotals(siteTotals) : summary;
  const statuses = [
    {
      title: "Confirmados",
      count: counts.confirmed,
      types: counts.guestsByStatus.confirmed,
      color: "bg-admin-status-confirmed",
    },
    {
      title: "Sem resposta",
      count: counts.pending,
      types: counts.guestsByStatus.pending,
      color: "bg-admin-status-pending",
    },
    {
      title: "Não irão",
      count: counts.declined,
      types: counts.guestsByStatus.declined,
      color: "bg-admin-status-declined",
    },
  ];
  const budget = invitationBudget(counts.guestsByStatus);
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
            {counts.confirmed} de {counts.guests}{" "}
            {counts.guests === 1 ? "convidado" : "convidados"}{" "}
            {counts.confirmed === 1 ? "irá" : "irão"} comparecer
          </h2>
          <p className="m-0 text-xs text-admin-muted">
            {countLabel(counts.invitations, "convite", "convites")} ·{" "}
            {countLabel(counts.adults, "adulto", "adultos")} ·{" "}
            {countLabel(counts.children, "criança", "crianças")}
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
          <table className="w-full border-collapse text-[13px] tabular-nums">
            <caption className="sr-only">Convidados por situação</caption>
            <thead>
              <tr className="text-left text-xs text-admin-muted">
                <th scope="col" className="py-1 pr-2 font-normal">
                  Situação
                </th>
                <th scope="col" className="px-2 py-1 text-right font-normal">
                  Pessoas
                </th>
                <th scope="col" className="px-2 py-1 text-right font-normal">
                  Adultos
                </th>
                <th scope="col" className="py-1 pl-2 text-right font-normal">
                  Crianças
                </th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((status) => (
                <tr key={status.title} className="border-t border-admin-line">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`size-2 shrink-0 rounded-full ${status.color}`}
                        aria-hidden="true"
                      />
                      {status.title}
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-right font-semibold">
                    {status.count}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {status.types.adults}
                  </td>
                  <td className="py-1.5 pl-2 text-right">
                    {status.types.children}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div
            className="grid gap-1 rounded-xl bg-admin-canvas px-3.5 py-3 text-[13px]"
            role="group"
            aria-label="Estimativa para orçamento"
          >
            <p className="m-0">
              <strong>Confirmados hoje:</strong> {peopleCount(budget.confirmed)}
            </p>
            <p className="m-0">
              <strong>No máximo:</strong> {peopleCount(budget.maximum)}
            </p>
            <p className="m-0 text-xs text-admin-muted">
              Use o máximo para fechar orçamentos enquanto há respostas
              pendentes.
            </p>
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
