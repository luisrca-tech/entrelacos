import {
  createPublicSiteMessageRequestSchema,
  messageTextSchema,
} from "@entrelacos/contracts";
import type { FormEvent } from "react";
import { countMessageCodePoints } from "./messages";

export type PublicMessageFormProps = {
  authorName: string;
  message: string;
  busy: boolean;
  error?: string;
  onAuthorNameChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
};

const publicMessageFormClass = "grid gap-4";
const publicMessageAlertClass =
  "m-0 max-w-[42rem] border border-template-line px-4 py-[0.8rem] text-template-ink";
const publicMessageLabelClass = "grid gap-[0.45rem] text-[0.85rem] font-bold";
const publicMessageInputClass =
  "min-h-11 w-full rounded-none border border-[rgba(37,53,43,0.32)] bg-[#fffdf8] px-3 py-2 text-template-ink font-[inherit]";
const publicMessageTextareaClass =
  "min-h-32 w-full resize-y rounded-none border border-[rgba(37,53,43,0.32)] bg-[#fffdf8] px-3 py-3 text-template-ink font-[inherit] leading-[1.55]";
const publicMessageMetaClass =
  "flex items-center justify-between gap-4 text-template-muted text-xs";
const publicMessageButtonClass =
  "min-h-11 cursor-pointer rounded-none border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const publicMessageAuthorNameSchema = createPublicSiteMessageRequestSchema.pick(
  { authorName: true },
);

export function PublicMessageForm({
  authorName,
  message,
  busy,
  error,
  onAuthorNameChange,
  onMessageChange,
  onSubmit,
}: PublicMessageFormProps) {
  const authorNameIsValid = publicMessageAuthorNameSchema.safeParse({
    authorName,
  }).success;
  const count = countMessageCodePoints(message);
  const messageIsValid = messageTextSchema.safeParse(message).success;
  const canSubmit = authorNameIsValid && messageIsValid && !busy;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <form className={publicMessageFormClass} onSubmit={submit}>
      <label
        className={publicMessageLabelClass}
        htmlFor="public-message-author"
      >
        Seu nome
        <input
          id="public-message-author"
          name="authorName"
          type="text"
          autoComplete="name"
          required
          className={publicMessageInputClass}
          value={authorName}
          disabled={busy}
          onChange={(event) => onAuthorNameChange(event.target.value)}
          aria-describedby="public-message-author-help"
        />
      </label>
      {authorName.length > 0 && !authorNameIsValid && (
        <p className={publicMessageAlertClass} role="alert">
          Informe um nome em texto simples com até 160 caracteres, sem sinais de
          maior ou menor ou caracteres de controle.
        </p>
      )}
      <label className={publicMessageLabelClass} htmlFor="public-message-text">
        Mensagem
        <textarea
          id="public-message-text"
          name="text"
          rows={5}
          required
          className={publicMessageTextareaClass}
          value={message}
          disabled={busy}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="Escreva seus votos de felicidade para os noivos"
          aria-describedby="public-message-help"
        />
      </label>
      <div className={publicMessageMetaClass} id="public-message-help">
        <span>Texto simples, sem anexos.</span>
        <span
          className="data-[invalid=true]:font-bold data-[invalid=true]:text-[#8e2e24]"
          data-invalid={count > 1_000 ? "true" : undefined}
        >
          {count} / 1000
        </span>
      </div>
      {message.length > 0 && !messageIsValid && (
        <p className={publicMessageAlertClass} role="alert">
          Use somente texto simples, sem sinais de maior ou menor, e limite a
          mensagem a 1000 caracteres.
        </p>
      )}
      {error && (
        <p className={publicMessageAlertClass} role="alert">
          {error}
        </p>
      )}
      <button
        className={publicMessageButtonClass}
        type="submit"
        disabled={!canSubmit}
      >
        {busy ? "Publicando…" : "Publicar mensagem"}
      </button>
      <span className="sr-only" id="public-message-author-help">
        Obrigatório, até 160 caracteres em texto simples.
      </span>
    </form>
  );
}
