import { useEffect, useRef } from "react";
import { captureFocus, type FocusTarget, restoreFocus } from "./dialogFocus";
import type { RsvpDraft, RsvpStatus } from "./rsvpDraft";

export type RsvpFormMember = {
  memberId: string;
  fullName: string;
  isRepresentative: boolean;
};

export type RsvpFormProps = {
  open: boolean;
  members: RsvpFormMember[];
  draft: RsvpDraft;
  canEdit: boolean;
  readOnlyMessage?: string;
  busy: boolean;
  error?: string;
  notice?: string;
  onChange: (memberId: string, status: RsvpStatus) => void;
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

const rsvpDialogClass =
  "w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border-0 bg-[var(--template-paper,#f4f0e8)] p-[clamp(1.25rem,4vw,2.5rem)] text-template-ink [&::backdrop]:bg-[rgba(18,28,23,0.72)] max-[560px]:m-0 max-[560px]:h-dvh max-[560px]:max-h-none max-[560px]:w-screen max-[560px]:rounded-none";
const rsvpHeaderClass = "flex items-center justify-between gap-4";
const rsvpEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
const rsvpHeadingClass = "m-0 text-[clamp(1.8rem,5vw,3rem)] font-normal";
const rsvpLinkClass =
  "w-fit cursor-pointer border-0 bg-transparent px-0 py-[0.35rem] text-template-muted underline underline-offset-[0.2rem] disabled:cursor-not-allowed disabled:opacity-50";
const rsvpMessageClass =
  "m-0 max-w-[42rem] border border-template-line px-4 py-[0.8rem] text-template-ink";
const rsvpReadonlyClass =
  "border-l-[3px] border-l-[#9c713f] bg-[rgba(156,113,63,0.12)] px-4 py-3";
const rsvpMembersClass = "my-6 grid gap-3";
const rsvpMemberClass =
  "flex items-center justify-between gap-4 border-b border-template-line py-3 max-[560px]:items-stretch max-[560px]:flex-col";
const rsvpMemberDetailsClass = "grid gap-[0.2rem]";
const rsvpMemberNoteClass = "text-template-muted";
const rsvpSelectClass =
  "min-h-11 rounded-[0.4rem] border border-[rgba(37,53,43,0.28)] bg-white px-[0.7rem] py-[0.55rem] text-inherit";
const rsvpActionsClass =
  "flex items-center justify-start gap-4 flex-wrap max-[560px]:items-stretch max-[560px]:flex-col";
const rsvpButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-4 py-[0.7rem] text-[var(--template-paper,#f4f0e8)] font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const rsvpSecondaryClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-transparent px-4 py-[0.7rem] text-template-ink font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";

export function RsvpForm({
  open,
  members,
  draft,
  canEdit,
  readOnlyMessage,
  busy,
  error,
  notice,
  onChange,
  onConfirmAll,
  onSave,
  onReload,
  onClose,
}: RsvpFormProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<FocusTarget | null>(null);
  const changed = Object.values(draft).some(
    (member) => member.status !== member.persistedStatus,
  );

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = captureFocus(document.activeElement);
      node.showModal();
      const focusInitialControl = () => {
        if (node.open)
          node.querySelector<HTMLElement>("[data-rsvp-initial]")?.focus();
      };
      if (typeof window.requestAnimationFrame === "function")
        window.requestAnimationFrame(focusInitialControl);
      else focusInitialControl();
    }
    if (!open && node.open) node.close();
  }, [open]);

  const handleDialogClose = () => {
    onClose();
    restoreFocus(opener.current);
    opener.current = null;
  };

  const requestClose = () => {
    if (dialog.current?.open) dialog.current.close();
    else handleDialogClose();
  };

  return (
    <dialog
      ref={dialog}
      className={rsvpDialogClass}
      data-lenis-prevent
      aria-labelledby="entrelacos-rsvp-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={handleDialogClose}
    >
      <div className={rsvpHeaderClass}>
        <div>
          <p className={rsvpEyebrowClass}>Confirmação de presença</p>
          <h3 className={rsvpHeadingClass} id="entrelacos-rsvp-title">
            Quem estará presente?
          </h3>
        </div>
        <button
          type="button"
          className={rsvpLinkClass}
          data-rsvp-initial
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
      {error && (
        <p className={rsvpMessageClass} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={rsvpMessageClass} role="status">
          {notice}
        </p>
      )}

      <div className={rsvpMembersClass}>
        {members.map((member) => (
          <label key={member.memberId} className={rsvpMemberClass}>
            <span className={rsvpMemberDetailsClass}>
              <strong>{member.fullName}</strong>
              {member.isRepresentative && (
                <small className={rsvpMemberNoteClass}>
                  Responsável pelo convite
                </small>
              )}
            </span>
            <select
              className={rsvpSelectClass}
              disabled={!canEdit || busy}
              value={draft[member.memberId]?.status ?? "PENDING"}
              onChange={(event) =>
                onChange(member.memberId, event.target.value as RsvpStatus)
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
            className={rsvpLinkClass}
            disabled={busy}
            onClick={onReload}
          >
            Recarregar dados
          </button>
        )}
      </div>
    </dialog>
  );
}
