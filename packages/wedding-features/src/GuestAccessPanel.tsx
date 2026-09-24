import {
  formatInvitationPhoneInput,
  type InvitationRsvpResponse,
  type InvitationSessionResponse,
  invitationAccessInputSchema,
} from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui/toaster";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  browserGuestSessionStorage,
  clearGuestSession,
  GuestAccessApi,
  type GuestAccessApiError,
  type GuestSessionReadResponse,
  type GuestSessionStorage,
  guestAccessErrorMessage,
  guestSessionEventName,
  publishGuestSessionChange,
  readGuestSession,
  writeGuestSession,
} from "./guestAccess";
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
const guestAccessAuthenticatedSectionClass =
  "grid min-w-0 grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] items-start gap-[clamp(2.5rem,6vw,7rem)] bg-template-ivory text-template-ink [@media(max-width:960px)]:block";
const guestAccessIntroClass =
  "max-w-[38rem] min-[961px]:w-full min-[961px]:max-w-[52rem]";
const guestAccessAuthenticatedIntroClass =
  "min-w-0 [@media(max-width:960px)]:mb-12";
const guestAccessEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
const guestAccessHeadingClass =
  "m-0 font-template-serif text-[clamp(2.5rem,6vw,5rem)] font-normal leading-[0.96] tracking-[-0.05em] min-[961px]:whitespace-nowrap min-[961px]:text-[clamp(2.75rem,4.4vw,4.25rem)]";
const guestAccessAuthenticatedHeadingClass =
  "m-0 max-w-[12ch] font-template-serif text-[clamp(2.5rem,6vw,5rem)] font-normal leading-[0.96] tracking-[-0.065em]";
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
const guestAccessInvitationClass = "grid min-w-0 gap-4 self-start";

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
    () => providedStorage ?? browserGuestSessionStorage(),
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
  const [phase, setPhase] = useState<GuestAccessPhase>("lookup");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [session, setSession] = useState<GuestSessionReadResponse | null>(null);
  const [rsvp, setRsvp] = useState<InvitationRsvpResponse | null>(null);
  const [rsvpDraft, setRsvpDraft] = useState<RsvpDraft>({});
  const [rsvpOpen, setRsvpOpen] = useState(false);
  const [rsvpError, setRsvpError] = useState("");
  const retryRequest = useRef<{ key: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

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
        const [restoredRsvp] = await Promise.allSettled([
          apiResult.api?.getRsvp(token),
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
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if ((cause as Partial<GuestAccessApiError>).status === 401) {
          clearGuestSession(storage, siteId);
          publishGuestSessionChange(siteId);
          setSession(null);
          setRsvp(null);
          setRsvpDraft({});
          setPhase("lookup");
          toast.error(errorWithRetry(cause));
        } else toast.error(errorWithRetry(cause));
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [apiResult, siteId, storage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSessionChange = () => {
      const token = storage ? readGuestSession(storage, siteId) : null;
      if (token) return;
      setSession(null);
      setRsvp(null);
      setRsvpDraft({});
      setRsvpOpen(false);
      setRsvpError("");
      setPhase("lookup");
    };
    window.addEventListener(guestSessionEventName(siteId), onSessionChange);
    return () => {
      window.removeEventListener(
        guestSessionEventName(siteId),
        onSessionChange,
      );
    };
  }, [siteId, storage]);

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
      toast.error(
        "Informe um telefone válido e o PIN de 6 dígitos do convite.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await apiResult.api.access(parsed.data);
      if (!storage) throw new Error("Session storage unavailable");
      writeGuestSession(storage, siteId, result.sessionToken);
      publishGuestSessionChange(siteId);
      setSession(sessionFromVerification(result));
      setPhase("authenticated");
      setPin("");
      toast.success("Acesso confirmado.");
      const [verifiedRsvp] = await Promise.allSettled([
        apiResult.api.getRsvp(result.sessionToken),
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
        const message = errorWithRetry(verifiedRsvp.reason);
        setRsvpError(message);
        toast.error(message);
      }
    } catch (cause) {
      toast.error(errorWithRetry(cause));
    } finally {
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
      const message = errorWithRetry(cause);
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        publishGuestSessionChange(siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setRsvpOpen(false);
        setPhase("lookup");
        setRsvpError("");
        toast.error(message);
      } else {
        setRsvpError(message);
        if (!preserveDraft) toast.error(message);
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
      toast.success(
        saved.result === "NO_CHANGE"
          ? "As respostas já estavam atualizadas."
          : "Respostas salvas.",
      );
    } catch (cause) {
      const apiError = cause as Partial<GuestAccessApiError>;
      const message = errorWithRetry(cause);
      if (apiError.code === "RSVP_CONFLICT") {
        await reloadRsvp(true);
      }
      if (apiError.status === 401) {
        if (storage) clearGuestSession(storage, siteId);
        publishGuestSessionChange(siteId);
        setSession(null);
        setRsvp(null);
        setRsvpDraft({});
        setRsvpOpen(false);
        retryRequest.current = null;
        setPhase("lookup");
        setRsvpError("");
      } else {
        setRsvpError(message);
      }
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const showingInvitation = phase === "authenticated" && session;

  return (
    <section
      className={
        showingInvitation
          ? guestAccessAuthenticatedSectionClass
          : guestAccessSectionClass
      }
      data-slot="guest-access"
      aria-labelledby="guest-access-title"
    >
      {showingInvitation && error && (
        <p className={`${guestAccessMessageClass} col-span-2`} role="alert">
          {error}
        </p>
      )}
      <div
        className={
          showingInvitation
            ? guestAccessAuthenticatedIntroClass
            : guestAccessIntroClass
        }
      >
        <p className={guestAccessEyebrowClass}>Confirmação de presença</p>
        <h2
          className={
            showingInvitation
              ? guestAccessAuthenticatedHeadingClass
              : guestAccessHeadingClass
          }
          id="guest-access-title"
        >
          Encontre seu convite
        </h2>
        <p
          className={
            showingInvitation
              ? `${guestAccessDescriptionClass} mt-7 max-w-[30rem]`
              : guestAccessDescriptionClass
          }
        >
          Informe o telefone de contato e o PIN compartilhado com este convite
          para acessar os convidados e confirmar a presença.
        </p>
      </div>

      {!showingInvitation && error && (
        <p className={guestAccessMessageClass} role="alert">
          {error}
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
          onChange={(guestId, state) => {
            setRsvpDraft((draft) => setDraftStatus(draft, guestId, state));
            setRsvpError("");
          }}
          onConfirmAll={() => {
            setRsvpDraft(confirmAllDraft);
            setRsvpError("");
          }}
          onSave={() => void saveRsvp()}
          onReload={() => void reloadRsvp(false)}
          onClose={() => setRsvpOpen(false)}
        />
      )}
    </section>
  );
}
