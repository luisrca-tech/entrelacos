import { useEffect, useRef } from "react";
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
  const changed = Object.values(draft).some(
    (member) => member.status !== member.persistedStatus,
  );

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="entrelacos-rsvp"
      aria-labelledby="entrelacos-rsvp-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="entrelacos-rsvp__header">
        <div>
          <p className="entrelacos-guest-access__eyebrow">
            Confirmação de presença
          </p>
          <h3 id="entrelacos-rsvp-title">Quem estará presente?</h3>
        </div>
        <button
          type="button"
          className="entrelacos-guest-access__link"
          onClick={onClose}
        >
          Fechar
        </button>
      </div>

      {!canEdit && (
        <p className="entrelacos-rsvp__readonly" role="status">
          {readOnlyMessage ??
            "As respostas podem ser consultadas, mas não alteradas agora."}
        </p>
      )}
      {error && (
        <p className="entrelacos-guest-access__message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="entrelacos-guest-access__message" role="status">
          {notice}
        </p>
      )}

      <div className="entrelacos-rsvp__members">
        {members.map((member) => (
          <label key={member.memberId} className="entrelacos-rsvp__member">
            <span>
              <strong>{member.fullName}</strong>
              {member.isRepresentative && (
                <small>Responsável pelo convite</small>
              )}
            </span>
            <select
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

      <div className="entrelacos-rsvp__actions">
        {canEdit && (
          <button
            type="button"
            className="entrelacos-guest-access__secondary"
            disabled={busy}
            onClick={onConfirmAll}
          >
            Confirmar todos
          </button>
        )}
        <button
          type="button"
          disabled={!canEdit || busy || !changed}
          onClick={onSave}
        >
          {busy ? "Salvando…" : "Salvar respostas"}
        </button>
        {error && (
          <button
            type="button"
            className="entrelacos-guest-access__link"
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
