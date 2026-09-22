import { Button } from "@entrelacos/ui";
import {
  Baby,
  CalendarClock,
  ClipboardCheck,
  FileDown,
  Mail,
  Plus,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { InvitationSummary } from "./invitationView";

type Props = {
  summary: InvitationSummary;
  inactive: boolean;
  onAdd: () => void;
  onManageConfirmations: () => void;
  onExport: () => void;
  onConfigureDeadline: () => void;
};

export function InvitationOverview({
  summary,
  inactive,
  onAdd,
  onManageConfirmations,
  onExport,
  onConfigureDeadline,
}: Props) {
  const metrics = [
    { label: "Convites", value: summary.invitations, icon: Mail },
    { label: "Convidados", value: summary.guests, icon: UsersRound },
    { label: "Adultos", value: summary.adults, icon: UserRound },
    { label: "Crianças", value: summary.children, icon: Baby },
  ];
  return (
    <aside
      className="min-w-0 rounded-2xl border border-admin-line bg-admin-surface p-5"
      aria-label="Resumo dos convites"
    >
      <div className="mb-5 border-b border-admin-line pb-5">
        <h2 className="m-0 font-admin-display text-[1.35rem] text-admin-graphite">
          Relatório de convidados
        </h2>
        <p className="mb-0 text-sm text-admin-muted">
          {summary.confirmed}{" "}
          {summary.confirmed === 1 ? "convidado irá" : "convidados irão"}{" "}
          comparecer
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2.5">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="rounded-xl border border-admin-line bg-admin-canvas p-3"
          >
            <Icon
              aria-hidden="true"
              className="mb-3 size-[18px] text-admin-graphite"
            />
            <dt className="text-xs text-admin-muted">{label}</dt>
            <dd className="m-0 text-xl font-semibold tabular-nums text-admin-ink">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 grid grid-cols-3 gap-2 border-b border-admin-line pb-5 text-center text-xs">
        <div>
          <strong className="block text-lg text-admin-status-pending">
            {summary.pending}
          </strong>
          <span className="text-admin-muted">Sem resposta</span>
        </div>
        <div>
          <strong className="block text-lg text-admin-status-confirmed">
            {summary.confirmed}
          </strong>
          <span className="text-admin-muted">Confirmados</span>
        </div>
        <div>
          <strong className="block text-lg text-admin-status-declined">
            {summary.declined}
          </strong>
          <span className="text-admin-muted">Não irão</span>
        </div>
      </div>
      <div className="mt-5 grid gap-2.5">
        <Button
          type="button"
          onClick={onAdd}
          disabled={inactive}
          className="min-h-11 w-full justify-start gap-2"
        >
          <Plus aria-hidden="true" className="size-4" />
          Adicionar convite
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onManageConfirmations}
          className="min-h-11 w-full justify-start gap-2 border-admin-line"
        >
          <ClipboardCheck aria-hidden="true" className="size-4" />
          Gerenciar confirmações
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onExport}
          className="min-h-11 w-full justify-start gap-2 border-admin-line"
        >
          <FileDown aria-hidden="true" className="size-4" />
          Exportar CSV ou PDF
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onConfigureDeadline}
          disabled={inactive}
          className="min-h-11 w-full justify-start gap-2 text-admin-muted"
        >
          <CalendarClock aria-hidden="true" className="size-4" />
          Prazo de confirmação
        </Button>
      </div>
    </aside>
  );
}
