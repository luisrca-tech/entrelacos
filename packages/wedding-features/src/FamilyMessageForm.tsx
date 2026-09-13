import {
  type FamilyMessageRecord,
  type FamilyMessageResponse,
  messageTextSchema,
} from "@entrelacos/contracts";
import type { FormEvent } from "react";
import { countMessageCodePoints } from "./messages";

export type FamilyMessageFormProps = {
  message: FamilyMessageRecord | null;
  currentRevision: number;
  canEdit: boolean;
  readOnlyReason: FamilyMessageResponse["readOnlyReason"];
  value: string;
  busy: boolean;
  error?: string;
  notice?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onReload?: () => void;
};

function readOnlyMessage(
  reason: FamilyMessageResponse["readOnlyReason"],
): string {
  if (reason === "MESSAGE_BLOCKED") {
    return "A administração bloqueou novas mensagens para este convite. A mensagem publicada continua visível.";
  }
  return "O mural está desativado. Sua mensagem publicada está preservada, mas não pode ser alterada agora.";
}

export function FamilyMessageForm({
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
}: FamilyMessageFormProps) {
  const count = countMessageCodePoints(value);
  const valid = messageTextSchema.safeParse(value).success;
  const invalidNonblank = value.trim().length > 0 && !valid;
  const unchanged = message?.text === value;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canEdit && valid && !unchanged && !busy) onSave();
  }

  return (
    <form className="entrelacos-family-message" onSubmit={submit}>
      <div>
        <p className="entrelacos-guest-access__eyebrow">Mural dos convidados</p>
        <h3>{message ? "Sua mensagem" : "Deixe uma mensagem"}</h3>
      </div>
      {readOnlyReason && (
        <p className="entrelacos-family-message__readonly" role="status">
          {readOnlyMessage(readOnlyReason)}
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
      <label>
        Mensagem em nome do convite
        <textarea
          rows={5}
          value={value}
          disabled={!canEdit || busy}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Escreva seus votos de felicidade para os noivos"
          aria-describedby="entrelacos-message-help"
        />
      </label>
      <div
        className="entrelacos-family-message__meta"
        id="entrelacos-message-help"
      >
        <span>Texto simples, sem anexos.</span>
        <span data-invalid={count > 1_000 ? "true" : undefined}>
          {count} / 1000
        </span>
      </div>
      {invalidNonblank && (
        <p className="entrelacos-guest-access__message" role="alert">
          Use somente texto simples, sem sinais de maior ou menor, e limite a
          mensagem a 1000 caracteres.
        </p>
      )}
      <div className="entrelacos-family-message__actions">
        <button
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
            className="entrelacos-guest-access__link"
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
