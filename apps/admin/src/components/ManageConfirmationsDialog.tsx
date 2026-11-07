import type {
  AdminRsvpWriteInput,
  RsvpHistoryResponse,
  RsvpState,
  SiteRsvpResponse,
} from "@entrelacos/contracts";
import { Button, Dialog, DialogDescription, DialogTitle } from "@entrelacos/ui";
import { useEffect, useState } from "react";
import { AdminDialogContent } from "./AdminDialog";
import { pendingAdminRsvpUpdates } from "./confirmationDraft";
import { InvitationStatus } from "./InvitationStatus";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: SiteRsvpResponse | null;
  history: RsvpHistoryResponse | null;
  loading: boolean;
  busy: boolean;
  inactive: boolean;
  onSave: (updates: AdminRsvpWriteInput["guests"]) => void;
  onLoadMoreHistory: () => void;
};

const states: { value: RsvpState; label: string }[] = [
  { value: "PENDING", label: "Sem resposta" },
  { value: "CONFIRMED", label: "Irá comparecer" },
  { value: "DECLINED", label: "Não comparecerá" },
];

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

export function ManageConfirmationsDialog({
  open,
  onOpenChange,
  view,
  history,
  loading,
  busy,
  inactive,
  onSave,
  onLoadMoreHistory,
}: Props) {
  const [tab, setTab] = useState<"current" | "history">("current");
  const [draft, setDraft] = useState<Record<string, RsvpState>>({});

  useEffect(() => {
    if (view) setDraft({});
  }, [view]);
  useEffect(() => {
    if (!open) setTab("current");
  }, [open]);

  const pending = view ? pendingAdminRsvpUpdates(view, draft) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AdminDialogContent showCloseButton className="max-w-[900px]">
        <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
          Gerenciar confirmações
        </DialogTitle>
        <DialogDescription className="leading-relaxed text-admin-muted">
          A resposta é individual para cada convidado. Alterações feitas aqui
          entram no histórico.
        </DialogDescription>
        <div
          role="tablist"
          aria-label="Visões das confirmações"
          className="mt-5 flex gap-2 border-b border-admin-line"
        >
          <button
            type="button"
            role="tab"
            id="confirmations-current-tab"
            aria-selected={tab === "current"}
            aria-controls="confirmations-current-panel"
            onClick={() => setTab("current")}
            className="min-h-11 border-b-2 border-transparent px-3 text-sm font-semibold text-admin-muted aria-selected:border-admin-terracotta aria-selected:text-admin-terracotta-deep"
          >
            Confirmações atuais
          </button>
          <button
            type="button"
            role="tab"
            id="confirmations-history-tab"
            aria-selected={tab === "history"}
            aria-controls="confirmations-history-panel"
            onClick={() => setTab("history")}
            className="min-h-11 border-b-2 border-transparent px-3 text-sm font-semibold text-admin-muted aria-selected:border-admin-terracotta aria-selected:text-admin-terracotta-deep"
          >
            Histórico
          </button>
        </div>
        {tab === "current" ? (
          <div
            role="tabpanel"
            id="confirmations-current-panel"
            aria-labelledby="confirmations-current-tab"
            className="mt-5 grid gap-4"
          >
            {loading || !view ? (
              <p role="status" className="text-admin-muted">
                Carregando confirmações…
              </p>
            ) : view.invitations.length === 0 ? (
              <p className="text-admin-muted">
                Ainda não há convidados para confirmar.
              </p>
            ) : (
              view.invitations.map((invitation) => (
                <section
                  key={invitation.id}
                  className="rounded-xl border border-admin-line bg-admin-canvas p-4"
                >
                  <h3 className="m-0 mb-3 font-admin-display text-[1.25rem] text-admin-graphite">
                    {invitation.name}
                  </h3>
                  <div className="grid gap-3">
                    {invitation.guests.map((guest) => (
                      <div
                        key={guest.id}
                        className="flex flex-wrap items-center justify-between gap-3 border-t border-admin-line pt-3 first:border-t-0 first:pt-0"
                      >
                        <div className="grid gap-1">
                          <strong className="text-sm text-admin-ink">
                            {guest.fullName}
                          </strong>
                          <span className="text-xs text-admin-muted">
                            {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                          </span>
                          <InvitationStatus
                            state={draft[guest.id] ?? guest.state}
                          />
                        </div>
                        <label className="grid gap-1 text-xs text-admin-muted">
                          Resposta
                          <select
                            value={draft[guest.id] ?? guest.state}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                [guest.id]: event.target.value as RsvpState,
                              }))
                            }
                            disabled={inactive || busy}
                            className="min-h-10 rounded-lg border border-admin-line bg-admin-surface px-3 text-sm text-admin-ink"
                          >
                            {states.map((state) => (
                              <option key={state.value} value={state.value}>
                                {state.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
            {/* Bleeds over the dialog padding so scrolled cards never show beneath it. */}
            <div
              data-confirmations-footer
              className="sticky -bottom-[30px] -mx-[30px] -mb-[30px] flex flex-wrap justify-end gap-3 border-t border-admin-line bg-admin-surface px-[30px] pt-4 pb-[30px] [@media(max-width:760px)]:-bottom-6 [@media(max-width:760px)]:-mx-[18px] [@media(max-width:760px)]:-mb-6 [@media(max-width:760px)]:px-[18px] [@media(max-width:760px)]:pb-6"
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={() => onSave(pending)}
                disabled={inactive || busy || pending.length === 0}
              >
                {busy
                  ? "Salvando…"
                  : `Salvar alterações${pending.length > 0 ? ` (${pending.length})` : ""}`}
              </Button>
            </div>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="confirmations-history-panel"
            aria-labelledby="confirmations-history-tab"
            className="mt-5 grid gap-2"
          >
            {!history ? (
              <p role="status" className="text-admin-muted">
                Carregando histórico…
              </p>
            ) : history.entries.length === 0 ? (
              <p className="text-admin-muted">
                Ainda não há alterações de confirmação.
              </p>
            ) : (
              history.entries.map((entry) => (
                <article
                  key={entry.id}
                  className="grid gap-2 border-b border-admin-line py-3 last:border-b-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-admin-ink">
                      {entry.guestDisplayName} · {entry.invitationName}
                    </strong>
                    <time
                      className="text-xs text-admin-muted"
                      dateTime={entry.occurredAt}
                    >
                      {dateFormatter.format(new Date(entry.occurredAt))}
                    </time>
                  </div>
                  <InvitationStatus state={entry.afterState} />
                  <span className="text-xs text-admin-muted">
                    Alterado por{" "}
                    {entry.actorType === "ADMIN" ? "administração" : "convite"}
                  </span>
                </article>
              ))
            )}
            {history?.nextCursor && (
              <Button
                type="button"
                variant="outline"
                onClick={onLoadMoreHistory}
                disabled={loading}
                className="justify-self-center"
              >
                Carregar mais
              </Button>
            )}
          </div>
        )}
      </AdminDialogContent>
    </Dialog>
  );
}
