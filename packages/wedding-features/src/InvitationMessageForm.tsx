import {
  type InvitationMessageRecord,
  type InvitationMessageResponse,
  messageTextSchema,
} from "@entrelacos/contracts";
import type { FormEvent } from "react";
import { countMessageCodePoints } from "./messages";

export type InvitationMessageFormProps = {
  message: InvitationMessageRecord | null;
  currentRevision: number;
  canEdit: boolean;
  readOnlyReason: InvitationMessageResponse["readOnlyReason"];
  value: string;
  busy: boolean;
  error?: string;
  notice?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onReload?: () => void;
};

const invitationMessageFormClass =
  "grid gap-4 border-t border-template-line pt-6";
const invitationMessageEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
const invitationMessageHeadingClass =
  "m-0 font-template-serif text-[clamp(1.8rem,4vw,3rem)] font-normal tracking-[-0.05em]";
const invitationMessageClass =
  "m-0 max-w-[42rem] border border-template-line px-4 py-[0.8rem] text-template-ink";
const invitationMessageReadonlyClass =
  "m-0 border-l-[3px] border-l-[#9c713f] bg-[rgba(156,113,63,0.1)] px-4 py-3 leading-[1.5]";
const invitationMessageLabelClass =
  "grid gap-[0.45rem] text-[0.85rem] font-bold";
const invitationMessageTextareaClass =
  "min-h-32 w-full resize-y rounded-none border border-[rgba(37,53,43,0.32)] bg-[#fffdf8] px-3 py-3 text-template-ink font-[inherit] leading-[1.55]";
const invitationMessageMetaClass =
  "flex items-center justify-between gap-4 text-template-muted text-xs";
const invitationMessageActionsClass =
  "flex items-center justify-between gap-4 [@media(max-width:560px)]:items-stretch [@media(max-width:560px)]:flex-col";
const invitationMessageButtonClass =
  "min-h-11 cursor-pointer rounded-none border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const invitationMessageLinkClass =
  "w-fit cursor-pointer border-0 bg-transparent px-0 py-[0.35rem] text-template-muted underline underline-offset-[0.2rem] disabled:cursor-not-allowed disabled:opacity-50";

function readOnlyMessage(
  reason: InvitationMessageResponse["readOnlyReason"],
): string {
  if (reason === "MESSAGE_BLOCKED") {
    return "A administração bloqueou novas mensagens para este convite. A mensagem publicada continua visível.";
  }
  return "O mural está desativado. Sua mensagem publicada está preservada, mas não pode ser alterada agora.";
}

export function InvitationMessageForm({
  message,
  currentRevision,
  canEdit,
  readOnlyReason,
  value,
  busy,
  error,
  notice,
  onChange,
  onSave,
  onReload,
}: InvitationMessageFormProps) {
  const count = countMessageCodePoints(value);
  const valid = messageTextSchema.safeParse(value).success;
  const invalidNonblank = value.trim().length > 0 && !valid;
  const unchanged = message?.text === value;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canEdit && valid && !unchanged && !busy) onSave();
  }

  return (
    <form className={invitationMessageFormClass} onSubmit={submit}>
      <div>
        <p className={invitationMessageEyebrowClass}>Mural dos convidados</p>
        <h3 className={invitationMessageHeadingClass}>
          {message ? "Sua mensagem" : "Deixe uma mensagem"}
        </h3>
      </div>
      {readOnlyReason && (
        <p className={invitationMessageReadonlyClass} role="status">
          {readOnlyMessage(readOnlyReason)}
        </p>
      )}
      {error && (
        <p className={invitationMessageClass} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={invitationMessageClass} role="status">
          {notice}
        </p>
      )}
      <label className={invitationMessageLabelClass}>
        Mensagem em nome do convite
        <textarea
          className={invitationMessageTextareaClass}
          rows={5}
          value={value}
          disabled={!canEdit || busy}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Escreva seus votos de felicidade para os noivos"
          aria-describedby="entrelacos-message-help"
        />
      </label>
      <div className={invitationMessageMetaClass} id="entrelacos-message-help">
        <span>Texto simples, sem anexos.</span>
        <span
          className="data-[invalid=true]:font-bold data-[invalid=true]:text-[#8e2e24]"
          data-invalid={count > 1_000 ? "true" : undefined}
        >
          {count} / 1000
        </span>
      </div>
      {invalidNonblank && (
        <p className={invitationMessageClass} role="alert">
          Use somente texto simples, sem sinais de maior ou menor, e limite a
          mensagem a 1000 caracteres.
        </p>
      )}
      <div className={invitationMessageActionsClass}>
        <button
          className={invitationMessageButtonClass}
          type="submit"
          disabled={!canEdit || busy || !valid || unchanged}
        >
          {busy
            ? "Salvando…"
            : currentRevision === 0
              ? "Publicar mensagem"
              : "Salvar mensagem"}
        </button>
        {error && onReload && (
          <button
            type="button"
            className={invitationMessageLinkClass}
            disabled={busy}
            onClick={onReload}
          >
            Recarregar mensagem
          </button>
        )}
      </div>
    </form>
  );
}
