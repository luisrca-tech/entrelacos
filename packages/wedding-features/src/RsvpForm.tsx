import type { RsvpDraft, RsvpStatus } from "./rsvpDraft";
import {
  SiteDialog,
  siteDialogCloseClass,
  siteDialogEyebrowClass,
  siteDialogHeaderClass,
  siteDialogHeadingClass,
} from "./SiteDialog";

export type RsvpFormGuest = {
  guestId: string;
  fullName: string;
  guestType: "ADULT" | "CHILD";
};

export type RsvpFormProps = {
  open: boolean;
  guests: RsvpFormGuest[];
  draft: RsvpDraft;
  canEdit: boolean;
  readOnlyMessage?: string;
  busy: boolean;
  error?: string;
  onChange: (guestId: string, state: RsvpStatus) => void;
  onConfirmAll: () => void;
  onSave: () => void;
  onReload: () => void;
  onClose: () => void;
};

const labels: Record<RsvpStatus, string> = {
  PENDING: "Pendente",
  CONFIRMED: "Confirmado",
  DECLINED: "Não comparecerá",
};

const rsvpReadonlyClass =
  "border-l-[3px] border-l-[#9c713f] bg-[rgba(156,113,63,0.12)] px-4 py-3";
const rsvpMembersClass = "my-6 grid gap-3";
const rsvpMemberClass =
  "flex items-center justify-between gap-4 border-b border-template-line py-3 [@media(max-width:560px)]:items-stretch [@media(max-width:560px)]:flex-col";
const rsvpMemberDetailsClass = "grid gap-[0.2rem]";
const rsvpMemberNoteClass = "text-template-muted";
const rsvpSelectClass =
  "min-h-11 w-full rounded-xl border border-[rgba(37,53,43,0.25)] bg-[#fffdf8] px-4 py-3 text-base text-template-ink font-[inherit] transition-[border-color,box-shadow] duration-200 focus:border-template-olive focus:outline-2 focus:outline-offset-2 focus:outline-template-olive motion-reduce:transition-none w-auto [@media(max-width:560px)]:w-full";
const rsvpActionsClass =
  "flex items-center justify-start gap-4 flex-wrap [@media(max-width:560px)]:items-stretch [@media(max-width:560px)]:flex-col";
const rsvpButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-3 text-template-ivory font-[inherit] text-sm font-medium transition-[background-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:bg-template-olive hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";
const rsvpSecondaryClass =
  "min-h-11 cursor-pointer rounded-full border border-template-line bg-transparent px-5 py-3 text-template-ink font-[inherit] text-sm font-medium transition-[background-color,color,border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-template-ink hover:bg-template-ink hover:text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";

export function RsvpForm({
  open,
  guests,
  draft,
  canEdit,
  readOnlyMessage,
  busy,
  error,
  onChange,
  onConfirmAll,
  onSave,
  onReload,
  onClose,
}: RsvpFormProps) {
  const changed = Object.values(draft).some(
    (guest) => guest.state !== guest.persistedState,
  );

  return (
    <SiteDialog
      open={open}
      labelledBy="entrelacos-rsvp-title"
      onClose={onClose}
    >
      {(requestClose) => (
        <>
          <div className={siteDialogHeaderClass}>
            <div>
              <p className={siteDialogEyebrowClass}>Confirmação de presença</p>
              <h3 className={siteDialogHeadingClass} id="entrelacos-rsvp-title">
                Quem estará presente?
              </h3>
            </div>
            <button
              type="button"
              className={siteDialogCloseClass}
              data-dialog-initial
              onClick={requestClose}
            >
              Fechar
            </button>
          </div>

          {!canEdit && (
            <p className={rsvpReadonlyClass} role="status">
              {readOnlyMessage ??
                "As respostas podem ser consultadas, mas não alteradas agora."}
            </p>
          )}

          <div className={rsvpMembersClass}>
            {guests.map((guest) => (
              <label key={guest.guestId} className={rsvpMemberClass}>
                <span className={rsvpMemberDetailsClass}>
                  <strong>{guest.fullName}</strong>
                  <small className={rsvpMemberNoteClass}>
                    {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                  </small>
                </span>
                <select
                  className={rsvpSelectClass}
                  disabled={!canEdit || busy}
                  value={draft[guest.guestId]?.state ?? "PENDING"}
                  onChange={(event) =>
                    onChange(guest.guestId, event.target.value as RsvpStatus)
                  }
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className={rsvpActionsClass}>
            {canEdit && (
              <button
                type="button"
                className={rsvpSecondaryClass}
                disabled={busy}
                onClick={onConfirmAll}
              >
                Confirmar todos
              </button>
            )}
            <button
              type="button"
              className={rsvpButtonClass}
              disabled={!canEdit || busy || !changed}
              onClick={onSave}
            >
              {busy ? "Salvando…" : "Salvar respostas"}
            </button>
            {error && (
              <button
                type="button"
                className={siteDialogCloseClass}
                disabled={busy}
                onClick={onReload}
              >
                Recarregar dados
              </button>
            )}
          </div>
        </>
      )}
    </SiteDialog>
  );
}
