import type { SiteHomeSummary } from "@entrelacos/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
} from "@entrelacos/ui";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { AdminDialogContent } from "./AdminDialog";
import {
  type InvitationExportSelection,
  invitationExportFormat,
} from "./invitationExport";
import { countLabel, type InvitationFilters } from "./invitationView";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (selection: InvitationExportSelection) => Promise<boolean>;
  busy: boolean;
  filters?: InvitationFilters;
  totals?: SiteHomeSummary["invitations"];
};

const exportOptions = [
  {
    model: "groups",
    title: "Organizar respostas",
    description: "Planilha por família para acompanhar quem falta responder.",
  },
  {
    model: "planning",
    title: "Compartilhar com a assessoria",
    description: "Resumo das confirmações e lista de convidados por família.",
  },
  {
    model: "reception",
    title: "Preparar a recepção",
    description: "Lista alfabética de confirmados para marcar chegadas.",
  },
] as const;

const statusLabels = {
  CONFIRMED: "Confirmados",
  PENDING: "Sem resposta",
  PARTIAL: "Em parte",
  DECLINED: "Não irão",
} as const;

export function InvitationExportDialog({
  open,
  onOpenChange,
  onExport,
  busy,
  filters,
  totals,
}: Props) {
  const radioName = useId();
  const [model, setModel] =
    useState<(typeof exportOptions)[number]["model"]>("groups");
  const [useFilters, setUseFilters] = useState(true);
  const [detailed, setDetailed] = useState(false);
  const [includePhone, setIncludePhone] = useState(false);
  const [includeEmail, setIncludeEmail] = useState(false);
  const format = invitationExportFormat(model).toUpperCase();
  const selection = model !== "reception" && useFilters ? filters : undefined;
  const totalGuests =
    totals && totals.confirmed + totals.pending + totals.declined;
  const scope =
    model === "reception"
      ? "Somente convidados confirmados"
      : selection
        ? "Busca e filtros atuais"
        : "Todos os convites";
  const scopeDetails =
    model === "reception"
      ? totals && countLabel(totals.confirmed, "confirmado", "confirmados")
      : selection
        ? [
            selection.search.trim() && `Busca por “${selection.search.trim()}”`,
            selection.status !== "ALL" && statusLabels[selection.status],
            selection.guestType !== "ALL" &&
              (selection.guestType === "ADULT"
                ? "Convites com adultos"
                : "Convites com crianças"),
          ]
            .filter(Boolean)
            .join(" · ")
        : totals &&
          totalGuests !== undefined &&
          `${countLabel(totalGuests, "convidado", "convidados")} em ${countLabel(totals.total, "convite", "convites")}`;

  function close() {
    setModel("groups");
    setUseFilters(true);
    setDetailed(false);
    setIncludePhone(false);
    setIncludeEmail(false);
    onOpenChange(false);
  }

  async function download() {
    const success = await onExport({
      model: model === "groups" && detailed ? "guests" : model,
      filters: selection,
      includePhone: model === "groups" && includePhone,
      includeEmail: model === "groups" && includeEmail,
    });
    if (success) close();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <AdminDialogContent scrollable={false} className="max-w-[540px]">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-6 sm:px-7 [&_[data-slot=dialog-title]]:pr-10">
          <DialogTitle className="font-admin-display text-[27px] text-admin-graphite">
            Exportar convidados
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-relaxed text-admin-muted">
            Escolha o arquivo que você precisa.
          </DialogDescription>
          <fieldset disabled={busy} className="mt-5 grid min-w-0 gap-2">
            <legend className="sr-only">Finalidade da exportação</legend>
            {exportOptions.map((option) => (
              <label
                key={option.model}
                className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-xl border border-admin-line bg-admin-surface px-3 py-3 has-checked:border-admin-terracotta has-checked:bg-admin-terracotta-wash/50"
              >
                <input
                  type="radio"
                  name={radioName}
                  checked={model === option.model}
                  onChange={() => setModel(option.model)}
                  aria-describedby={`${radioName}-${option.model}`}
                  className="mt-0.5 size-4 accent-admin-terracotta"
                />
                <span className="text-sm font-semibold text-admin-graphite">
                  {option.title}
                </span>
                <Badge
                  variant="outline"
                  className="rounded-md bg-admin-surface"
                >
                  {invitationExportFormat(option.model).toUpperCase()}
                </Badge>
                <span
                  id={`${radioName}-${option.model}`}
                  className="col-start-2 col-span-2 text-xs leading-relaxed text-admin-muted"
                >
                  {option.description}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 rounded-xl border border-admin-line bg-admin-canvas px-3 py-2.5">
            <p className="m-0 text-sm font-semibold text-admin-graphite">
              {scope}
            </p>
            {scopeDetails && (
              <p className="m-0 break-words text-xs leading-relaxed text-admin-muted">
                {scopeDetails}
              </p>
            )}
            {filters && model !== "reception" && (
              <label className="mt-2 flex min-h-8 cursor-pointer items-center gap-2 text-sm text-admin-graphite">
                <input
                  type="checkbox"
                  checked={useFilters}
                  disabled={busy}
                  onChange={(event) => setUseFilters(event.target.checked)}
                  className="size-4 accent-admin-terracotta"
                />
                Usar busca e filtros atuais
              </label>
            )}
          </div>
          {model === "groups" && (
            <details className="mt-3 text-sm text-admin-graphite">
              <summary className="cursor-pointer py-1 font-medium">
                Opções da planilha
              </summary>
              <fieldset disabled={busy} className="mt-1 grid">
                <legend className="sr-only">
                  Detalhes e contatos da planilha
                </legend>
                {[
                  {
                    label: "Uma linha por convidado",
                    value: detailed,
                    change: setDetailed,
                  },
                  {
                    label: "Incluir telefone do convite",
                    value: includePhone,
                    change: setIncludePhone,
                  },
                  {
                    label: "Incluir e-mail do convite",
                    value: includeEmail,
                    change: setIncludeEmail,
                  },
                ].map(({ label, value, change }) => (
                  <label
                    key={label}
                    className="flex min-h-9 cursor-pointer items-center gap-2"
                  >
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(event) => change(event.target.checked)}
                      className="size-4 accent-admin-terracotta"
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </details>
          )}
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-admin-line bg-admin-surface px-5 py-4 sm:flex sm:justify-end sm:px-7">
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void download()}
            disabled={busy}
            aria-busy={busy}
          >
            <Download aria-hidden="true" className="size-4" />
            {busy ? "Gerando…" : `Baixar ${format}`}
          </Button>
        </div>
      </AdminDialogContent>
    </Dialog>
  );
}
