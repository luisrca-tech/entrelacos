import {
  formatInvitationPhoneInput,
  type InvitationMessageResponse,
  type InvitationRsvpResponse,
  type InvitationSessionResponse,
  invitationAccessInputSchema,
} from "@entrelacos/contracts";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  clearGuestSession,
  GuestAccessApi,
  type GuestAccessApiError,
  type GuestSessionReadResponse,
  type GuestSessionStorage,
  getGuestLeaveNotice,
  guestAccessErrorMessage,
  readGuestSession,
  writeGuestSession,
} from "./guestAccess";
import { InvitationMessageForm } from "./InvitationMessageForm";
import {
  getMessageErrorMessage,
  muralRefreshEventName,
  WeddingMessagesApi,
  type WeddingMessagesApiError,
} from "./messages";
import { RsvpForm } from "./RsvpForm";
import {
  confirmAllDraft,
  createRsvpDraft,
  pendingRsvpUpdates,
  type RsvpDraft,
  reconcileRsvpDraft,
  setDraftStatus,
} from "./rsvpDraft";

type GuestAccessProps = {
  siteId: string;
  apiOrigin: string;
  fetcher?: typeof fetch;
  storage?: GuestSessionStorage;
};

type GuestAccessPhase = "lookup" | "authenticated";

const guestAccessSectionClass =
  "grid min-w-0 gap-6 bg-template-ivory px-[clamp(2rem,5vw,4rem)] py-[clamp(2rem,5vw,4rem)] text-template-ink [@media(max-width:560px)]:px-4 [@media(max-width:560px)]:py-8 min-[961px]:justify-items-center";
const guestAccessIntroClass =
  "max-w-[38rem] min-[961px]:w-full min-[961px]:max-w-[52rem]";
const guestAccessEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
const guestAccessHeadingClass =
  "m-0 font-template-serif text-[clamp(2.5rem,6vw,5rem)] font-normal leading-[0.96] tracking-[-0.05em] min-[961px]:whitespace-nowrap min-[961px]:text-[clamp(2.75rem,4.4vw,4.25rem)]";
const guestAccessSubheadingClass =
  "m-0 font-template-serif text-[clamp(1.8rem,4vw,3rem)] font-normal tracking-[-0.05em]";
const guestAccessDescriptionClass =
  "text-template-muted leading-[1.6] min-[961px]:max-w-[38rem]";
const guestAccessMessageClass =
  "m-0 max-w-[42rem] border border-template-line px-4 py-[0.8rem] text-template-ink min-[961px]:w-full min-[961px]:max-w-[52rem]";
const guestAccessFormClass =
  "grid max-w-[34rem] gap-4 min-[961px]:w-full min-[961px]:max-w-[52rem]";
const guestAccessLabelClass = "grid gap-[0.4rem] text-[0.85rem] font-bold";
const guestAccessInputClass =
  "min-h-11 w-full rounded-none border border-[rgba(37,53,43,0.32)] bg-[#fffdf8] px-3 py-[0.65rem] text-template-ink font-[inherit]";
const guestAccessButtonClass =
  "min-h-11 cursor-pointer rounded-none border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const guestAccessSecondaryClass =
  "min-h-11 cursor-pointer rounded-none border border-template-ink bg-transparent px-4 py-[0.65rem] text-template-ink font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const guestAccessLinkClass =
  "w-fit cursor-pointer border-0 bg-transparent px-0 py-[0.35rem] text-template-muted underline underline-offset-[0.2rem] disabled:cursor-not-allowed disabled:opacity-50";
const guestAccessInvitationClass =
  "grid max-w-[42rem] gap-4 min-[961px]:w-full min-[961px]:max-w-[52rem]";

function browserSessionStorage(): GuestSessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function errorWithRetry(error: unknown): string {
  const message = guestAccessErrorMessage(error);
  const apiError = error as Partial<GuestAccessApiError>;
  if (
    apiError.status === 429 &&
    typeof apiError.retryAfterSeconds === "number" &&
    !message.includes("segundos")
  )
    return `Muitas tentativas. Aguarde ${apiError.retryAfterSeconds} segundos antes de tentar novamente.`;
  return message;
}

function sessionFromVerification(
  result: InvitationSessionResponse,
): GuestSessionReadResponse {
  const { sessionToken: _sessionToken, ...session } = result;
  return session;
}

export function GuestAccess({
  siteId,
  apiOrigin,
  fetcher,
  storage: providedStorage,
}: GuestAccessProps) {
  const storage = useMemo(
    () => providedStorage ?? browserSessionStorage(),
    [providedStorage],
  );
  const apiResult = useMemo(() => {
    try {
      return {
        api: new GuestAccessApi({ apiOrigin, siteId, fetcher }),
        error: "",
      };
    } catch (error) {
      return {
        api: null,
        error:
          error instanceof Error
            ? error.message
            : "A configuração pública deste site está inválida.",
      };
    }
  }, [apiOrigin, fetcher, siteId]);
  const messagesApiResult = useMemo(() => {
    try {
      return {
        api: new WeddingMessagesApi({ apiOrigin, siteId, fetcher }),
        error: "",
      };
    } catch (error) {
      return {
        api: null,
        error:
          error instanceof Error
            ? error.message
            : "A configuração pública deste site está inválida.",
      };
    }
  }, [apiOrigin, fetcher, siteId]);

  const [phase, setPhase] = useState<GuestAccessPhase>("lookup");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [session, setSession] = useState<GuestSessionReadResponse | null>(null);
  const [rsvp, setRsvp] = useState<InvitationRsvpResponse | null>(null);
  const [rsvpDraft, setRsvpDraft] = useState<RsvpDraft>({});
  const [rsvpOpen, setRsvpOpen] = useState(false);
  const [rsvpError, setRsvpError] = useState("");
  const [rsvpNotice, setRsvpNotice] = useState("");
  const retryRequest = useRef<{ key: string; requestId: string } | null>(null);
  const [invitationMessage, setInvitationMessage] =
    useState<InvitationMessageResponse | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageReady, setMessageReady] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [messageNotice, setMessageNotice] = useState("");
  const messageRetryRequest = useRef<{
    key: string;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    if (!apiResult.api) {
      setError(apiResult.error);
      setReady(true);
      return () => {
        active = false;
      };
    }
    if (!storage) {
      setError(
        "Este navegador não permitiu armazenar a sessão. Habilite o armazenamento e tente novamente.",
      );
      setReady(true);
      return () => {
        active = false;
      };
    }
    const token = readGuestSession(storage, siteId);
    if (!token) {
      setReady(true);
      return () => {
        active = false;
      };
    }
    void apiResult.api
      .getSession(token)
      .then(async (restored) => {
        if (!active) return;
        setSession(restored);
        setPhase("authenticated");
        const [restoredRsvp, restoredMessage] = await Promise.allSettled([
          apiResult.api?.getRsvp(token),
          messagesApiResult.api?.getInvitationMessage(token),
        ]);
        if (!active) return;
        if (restoredRsvp.status === "fulfilled" && restoredRsvp.value) {
          setRsvp(restoredRsvp.value);
          setRsvpDraft(
            createRsvpDraft(
              restoredRsvp.value.guests.map((guest) => ({
                guestId: guest.id,
                state: guest.state,
                revision: guest.revision,
              })),
            ),
          );
        } else if (restoredRsvp.status === "rejected") {
          setRsvpError(errorWithRetry(restoredRsvp.reason));
        }
        if (restoredMessage.status === "fulfilled" && restoredMessage.value) {
          setInvitationMessage(restoredMessage.value);
          setMessageDraft(restoredMessage.value.message?.text ?? "");
        } else if (restoredMessage.status === "rejected") {
          setMessageError(getMessageErrorMessage(restoredMessage.reason));
        } else if (!messagesApiResult.api) {
          setMessageError(messagesApiResult.error);
        }
        setMessageReady(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if ((cause as Partial<GuestAccessApiError>).status === 401) {
          clearGuestSession(storage, siteId);
          setSession(null);
          setRsvp(null);
          setRsvpDraft({});
          setInvitationMessage(null);
          setMessageDraft("");
          setMessageReady(false);
          setPhase("lookup");
          setNotice("");
          setError(errorWithRetry(cause));
        } else setError(errorWithRetry(cause));
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [apiResult, messagesApiResult, siteId, storage]);

  if (!ready)
    return (
      <section
        className={guestAccessSectionClass}
        data-slot="guest-access"
        aria-busy="true"
      >
        <p className={guestAccessEyebrowClass}>Confirmação de presença</p>
        <p>Carregando seu acesso…</p>
      </section>
    );

  async function accessInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiResult.api || busy) return;
    const parsed = invitationAccessInputSchema.safeParse({
      phone: phone.trim(),
      accessPin: pin,
    });
    if (!parsed.success) {
      setError("Informe um telefone válido e o PIN de 6 dígitos do convite.");
      setNotice("");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiResult.api.access(parsed.data);
      if (!storage) throw new Error("Session storage unavailable");
      writeGuestSession(storage, siteId, result.sessionToken);
      setSession(sessionFromVerification(result));
      setPhase("authenticated");
      setPin("");
      setNotice("Acesso confirmado.");
      const [verifiedRsvp, verifiedMessage] = await Promise.allSettled([
        apiResult.api.getRsvp(result.sessionToken),
        messagesApiResult.api?.getInvitationMessage(result.sessionToken),
      ]);
      if (verifiedRsvp.status === "fulfilled") {
        setRsvp(verifiedRsvp.value);
        setRsvpDraft(
          createRsvpDraft(
            verifiedRsvp.value.guests.map((guest) => ({
              guestId: guest.id,
              state: guest.state,
              revision: guest.revision,
            })),
          ),
        );
      } else {
        setRsvpError(errorWithRetry(verifiedRsvp.reason));
      }
      if (verifiedMessage.status === "fulfilled" && verifiedMessage.value) {
        setInvitationMessage(verifiedMessage.value);
        setMessageDraft(verifiedMessage.value.message?.text ?? "");
      } else if (verifiedMessage.status === "rejected") {
        setMessageError(getMessageErrorMessage(verifiedMessage.reason));
      } else if (!messagesApiResult.api) {
        setMessageError(messagesApiResult.error);
      }
      setMessageReady(true);
    } catch (cause) {
      setError(errorWithRetry(cause));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    const token = storage ? readGuestSession(storage, siteId) : null;
    let serverConfirmed = token === null;
    setBusy(true);
    setError("");
    try {
      if (token && apiResult.api) {
        await apiResult.api.leave(token);
        serverConfirmed = true;
      }
    } catch (cause) {
      setError(errorWithRetry(cause));
    } finally {
      if (storage) clearGuestSession(storage, siteId);
      setSession(null);
      setRsvp(null);
      setRsvpDraft({});
      setInvitationMessage(null);
      setMessageDraft("");
      setMessageReady(false);
      setMessageError("");
      setMessageNotice("");
      messageRetryRequest.current = null;
      setRsvpOpen(false);
      setPin("");
      setPhase("lookup");
      setNotice(getGuestLeaveNotice(serverConfirmed));
      setBusy(false);
    }
  }

  async function reloadRsvp(preserveDraft: boolean) {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (!token || !apiResult.api) return;
    setBusy(true);
    setRsvpError("");
    try {
      const current = await apiResult.api.getRsvp(token);
      setRsvp(current);
      const snapshots = current.guests.map((guest) => ({
        guestId: guest.id,
        state: guest.state,
        revision: guest.revision,
      }));
      setRsvpDraft((draft) =>
        preserveDraft
          ? reconcileRsvpDraft(draft, snapshots)
          : createRsvpDraft(snapshots),
      );
      if (!preserveDraft) retryRequest.current = null;
    } catch (cause) {
      const apiError = cause as Partial<GuestAccessApiError>;
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setRsvpOpen(false);
        setPhase("lookup");
        setNotice("");
        setRsvpNotice("");
        setRsvpError("");
        setError(errorWithRetry(cause));
      } else {
        setRsvpError(errorWithRetry(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRsvp() {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (!token || !apiResult.api || !rsvp?.canEdit || busy) return;
    const updates = pendingRsvpUpdates(rsvpDraft);
    if (updates.length === 0) return;
    const key = JSON.stringify(updates);
    const requestId =
      retryRequest.current?.key === key
        ? retryRequest.current.requestId
        : globalThis.crypto.randomUUID();
    retryRequest.current = { key, requestId };
    setBusy(true);
    setRsvpError("");
    setRsvpNotice("");
    try {
      const saved = await apiResult.api.saveRsvp(token, {
        requestId,
        guests: updates,
      });
      const byId = new Map(saved.guests.map((guest) => [guest.id, guest]));
      const guests = rsvp.guests.map((guest) => byId.get(guest.id) ?? guest);
      setRsvp({ ...rsvp, guests });
      setRsvpDraft(
        createRsvpDraft(
          guests.map((guest) => ({
            guestId: guest.id,
            state: guest.state,
            revision: guest.revision,
          })),
        ),
      );
      retryRequest.current = null;
      setRsvpNotice(
        saved.result === "NO_CHANGE"
          ? "As respostas já estavam atualizadas."
          : "Respostas salvas.",
      );
    } catch (cause) {
      const apiError = cause as Partial<GuestAccessApiError>;
      const message = errorWithRetry(cause);
      setRsvpError(message);
      if (apiError.code === "RSVP_CONFLICT") {
        await reloadRsvp(true);
        setRsvpError(message);
      }
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setRsvpOpen(false);
        retryRequest.current = null;
        setPhase("lookup");
        setNotice("");
        setRsvpNotice("");
        setRsvpError("");
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadInvitationMessage(preserveDraft: boolean) {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (!token || !messagesApiResult.api) {
      setMessageError(
        messagesApiResult.error || "A sessão do convite não está disponível.",
      );
      setMessageReady(true);
      return;
    }
    setMessageBusy(true);
    setMessageError("");
    try {
      const current = await messagesApiResult.api.getInvitationMessage(token);
      setInvitationMessage(current);
      if (!preserveDraft) setMessageDraft(current.message?.text ?? "");
      messageRetryRequest.current = null;
    } catch (cause) {
      const apiError = cause as Partial<WeddingMessagesApiError>;
      const message = getMessageErrorMessage(cause);
      setMessageError(message);
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setInvitationMessage(null);
        setMessageDraft("");
        setPhase("lookup");
        setNotice("");
        setError(message);
      }
    } finally {
      setMessageReady(true);
      setMessageBusy(false);
    }
  }

  async function saveInvitationMessage() {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (
      !token ||
      !messagesApiResult.api ||
      !invitationMessage?.canEdit ||
      messageBusy
    ) {
      return;
    }
    const input = {
      expectedRevision: invitationMessage.currentRevision,
      text: messageDraft,
    };
    const key = JSON.stringify(input);
    const requestId =
      messageRetryRequest.current?.key === key
        ? messageRetryRequest.current.requestId
        : globalThis.crypto.randomUUID();
    messageRetryRequest.current = { key, requestId };
    setMessageBusy(true);
    setMessageError("");
    setMessageNotice("");
    try {
      const saved = await messagesApiResult.api.saveInvitationMessage(token, {
        requestId,
        ...input,
      });
      setInvitationMessage({
        ...invitationMessage,
        currentRevision: saved.message.revision,
        message: saved.message,
      });
      setMessageDraft(saved.message.text);
      messageRetryRequest.current = null;
      setMessageNotice(
        saved.result === "NO_CHANGE"
          ? "A mensagem já estava atualizada."
          : "Mensagem publicada no mural.",
      );
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(muralRefreshEventName(siteId)));
      }
    } catch (cause) {
      const apiError = cause as Partial<WeddingMessagesApiError>;
      const message = getMessageErrorMessage(cause);
      setMessageError(message);
      if (
        apiError.code === "MESSAGE_CONFLICT" ||
        apiError.code === "MESSAGE_REMOVED"
      ) {
        await reloadInvitationMessage(true);
        setMessageError(message);
      }
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setInvitationMessage(null);
        setMessageDraft("");
        setPhase("lookup");
        setNotice("");
        setError(message);
      }
    } finally {
      setMessageBusy(false);
    }
  }

  return (
    <section
      className={guestAccessSectionClass}
      data-slot="guest-access"
      aria-labelledby="guest-access-title"
    >
      <div className={guestAccessIntroClass}>
        <p className={guestAccessEyebrowClass}>Confirmação de presença</p>
        <h2 className={guestAccessHeadingClass} id="guest-access-title">
          Encontre seu convite
        </h2>
        <p className={guestAccessDescriptionClass}>
          Informe o telefone de contato e o PIN compartilhado com este convite
          para acessar os convidados e confirmar a presença.
        </p>
      </div>

      {error && (
        <p className={guestAccessMessageClass} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={guestAccessMessageClass} role="status">
          {notice}
        </p>
      )}

      {phase === "lookup" && (
        <form
          className={guestAccessFormClass}
          noValidate
          onSubmit={accessInvitation}
        >
          <label className={guestAccessLabelClass}>
            Telefone de contato
            <input
              className={guestAccessInputClass}
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) =>
                setPhone(formatInvitationPhoneInput(event.target.value))
              }
              placeholder="(62) 99999-9999 ou +1 212 555 0123"
              required
            />
          </label>
          <label className={guestAccessLabelClass}>
            PIN de 6 dígitos
            <input
              className={guestAccessInputClass}
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={pin}
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, ""))
              }
              required
            />
          </label>
          <button
            className={guestAccessButtonClass}
            type="submit"
            disabled={busy}
          >
            {busy ? "Confirmando…" : "Acessar convite"}
          </button>
        </form>
      )}

      {phase === "authenticated" && session && (
        <div className={guestAccessInvitationClass}>
          <h3 className={guestAccessSubheadingClass}>
            {session.invitationName}
          </h3>
          <p className="m-0 text-template-muted">Convidados neste convite</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {session.guests.map((guest) => (
              <li
                className="flex items-baseline justify-between gap-4 border-b border-template-line py-3 [@media(max-width:560px)]:flex-col [@media(max-width:560px)]:items-start [@media(max-width:560px)]:gap-[0.15rem]"
                key={guest.id}
              >
                <span>{guest.fullName}</span>
                <small className="text-template-muted text-xs">
                  {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                </small>
              </li>
            ))}
          </ul>
          {rsvp ? (
            <button
              className={guestAccessButtonClass}
              type="button"
              onClick={() => setRsvpOpen(true)}
            >
              {rsvp.canEdit ? "Responder presença" : "Consultar respostas"}
            </button>
          ) : (
            <p role="status">
              As respostas de presença não estão disponíveis agora.
            </p>
          )}
          {!messageReady ? (
            <p role="status">Carregando a mensagem deste convite…</p>
          ) : invitationMessage ? (
            <InvitationMessageForm
              message={invitationMessage.message}
              currentRevision={invitationMessage.currentRevision}
              canEdit={invitationMessage.canEdit}
              readOnlyReason={invitationMessage.readOnlyReason}
              value={messageDraft}
              busy={messageBusy}
              error={messageError}
              notice={messageNotice}
              onChange={(value) => {
                setMessageDraft(value);
                setMessageError("");
                setMessageNotice("");
              }}
              onSave={() => void saveInvitationMessage()}
              onReload={() => void reloadInvitationMessage(false)}
            />
          ) : (
            <div className="grid gap-4 border-t border-template-line pt-6">
              <p className={guestAccessMessageClass} role="alert">
                {messageError ||
                  "A mensagem deste convite não está disponível agora."}
              </p>
              <button
                type="button"
                className={guestAccessLinkClass}
                disabled={messageBusy}
                onClick={() => void reloadInvitationMessage(false)}
              >
                Recarregar mensagem
              </button>
            </div>
          )}
          <button
            type="button"
            className={guestAccessSecondaryClass}
            disabled={busy}
            onClick={() => void leave()}
          >
            {busy ? "Saindo…" : "Sair"}
          </button>
        </div>
      )}
      {rsvp && (
        <RsvpForm
          open={rsvpOpen}
          guests={rsvp.guests.map((guest) => ({
            guestId: guest.id,
            fullName: guest.fullName,
            guestType: guest.guestType,
          }))}
          draft={rsvpDraft}
          canEdit={rsvp.canEdit}
          readOnlyMessage={
            rsvp.readOnlyReason === "DEADLINE_PASSED"
              ? "O prazo de confirmação terminou. Você ainda pode consultar as respostas."
              : undefined
          }
          busy={busy}
          error={rsvpError}
          notice={rsvpNotice}
          onChange={(guestId, state) => {
            setRsvpDraft((draft) => setDraftStatus(draft, guestId, state));
            setRsvpError("");
            setRsvpNotice("");
          }}
          onConfirmAll={() => {
            setRsvpDraft(confirmAllDraft);
            setRsvpError("");
            setRsvpNotice("");
          }}
          onSave={() => void saveRsvp()}
          onReload={() => void reloadRsvp(false)}
          onClose={() => setRsvpOpen(false)}
        />
      )}
    </section>
  );
}
