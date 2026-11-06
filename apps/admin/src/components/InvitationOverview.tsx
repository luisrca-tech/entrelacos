import { Button } from "@entrelacos/ui";
import { CalendarClock } from "lucide-react";
import type { InvitationSummary } from "./invitationView";

type Props = {
  summary: InvitationSummary;
  inactive: boolean;
  onAdd: () => void;
  onManageConfirmations: () => void;
  onExport: () => void;
  onConfigureDeadline: () => void;
  deadline?: string | null;
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
  partial,
}: Props) {
  const statuses = [
    {
      title: "Confirmados",
      count: summary.confirmed,
      color: "bg-admin-status-confirmed",
    },
    {
      title: "Sem resposta",
      count: summary.pending,
      color: "bg-admin-status-pending",
    },
    {
      title: "Não irão",
      count: summary.declined,
      color: "bg-admin-status-declined",
    },
  ];
  return (
    <div className="grid gap-3.5">
      <div className="flex flex-wrap justify-end gap-2.5">
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
      </div>
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
        <section
          className="grid gap-2.5 rounded-2xl border border-admin-line bg-admin-surface p-5"
          aria-label="Resumo dos convites"
        >
          <p className="m-0 text-xs text-admin-muted">
            {partial
              ? "Respostas dos convites exibidos"
              : "Respostas dos convidados"}
          </p>
          <h2 className="m-0 font-admin-display text-2xl font-normal">
            {summary.confirmed} de {summary.guests} convidados irão comparecer
          </h2>
          <p className="m-0 text-xs text-admin-muted">
            {summary.invitations}{" "}
            {summary.invitations === 1 ? "convite" : "convites"} ·{" "}
            {summary.adults} {summary.adults === 1 ? "adulto" : "adultos"} ·{" "}
            {summary.children} {summary.children === 1 ? "criança" : "crianças"}
          </p>
          {summary.guests > 0 && (
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
          <p className="m-0 font-admin-display text-xl">
            {deadline ?? "Sem prazo definido"}
          </p>
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
