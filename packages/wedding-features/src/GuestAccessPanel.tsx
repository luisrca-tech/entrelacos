import {
  type FamilyRsvpResponse,
  type FamilySessionResponse,
  guestLookupInputSchema,
} from "@entrelacos/contracts";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  clearGuestSession,
  GuestAccessApi,
  type GuestAccessApiError,
  type GuestChallengeStartResult,
  type GuestSessionReadResponse,
  type GuestSessionStorage,
  getGuestDeliveryMessage,
  getGuestLeaveNotice,
  getResendCountdownSeconds,
  guestAccessErrorMessage,
  isValidVerificationCode,
  readGuestSession,
  shouldDiscardGuestChallenge,
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
  demoMode?: boolean;
  fetcher?: typeof fetch;
  storage?: GuestSessionStorage;
  now?: () => number;
};

type GuestAccessPhase = "lookup" | "code" | "authenticated";

function browserSessionStorage(): GuestSessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function responseStatusMessage(result: GuestChallengeStartResult): string {
  if (result.sendStatus === "FAILED_FINAL")
    return "Não foi possível enviar o código. Confira os dados e tente novamente.";
  if (result.sendStatus === "UNKNOWN")
    return "O envio está sendo confirmado. Se o código chegar, informe-o abaixo.";
  return "";
}

function challengeExpired(challenge: GuestChallengeStartResult, nowMs: number) {
  return Date.parse(challenge.expiresAt) <= nowMs;
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
  result: FamilySessionResponse,
): GuestSessionReadResponse {
  const { sessionToken: _sessionToken, ...session } = result;
  return session;
}

export function GuestAccess({
  siteId,
  apiOrigin,
  demoMode = false,
  fetcher,
  storage: providedStorage,
  now = Date.now,
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

  const [phase, setPhase] = useState<GuestAccessPhase>("lookup");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [demoGrant, setDemoGrant] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<GuestChallengeStartResult | null>(
    null,
  );
  const [session, setSession] = useState<GuestSessionReadResponse | null>(null);
  const [rsvp, setRsvp] = useState<FamilyRsvpResponse | null>(null);
  const [rsvpDraft, setRsvpDraft] = useState<RsvpDraft>({});
  const [rsvpOpen, setRsvpOpen] = useState(false);
  const [rsvpError, setRsvpError] = useState("");
  const [rsvpNotice, setRsvpNotice] = useState("");
  const retryRequest = useRef<{ key: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nowMs, setNowMs] = useState(() => now());

  useEffect(() => {
    let active = true;
    setNowMs(now());
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
        const restoredRsvp = await apiResult.api?.getRsvp(token);
        if (!active || !restoredRsvp) return;
        setRsvp(restoredRsvp);
        setRsvpDraft(
          createRsvpDraft(
            restoredRsvp.members.map((member) => ({
              memberId: member.id,
              status: member.state,
              revision: member.revision,
            })),
          ),
        );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if ((cause as Partial<GuestAccessApiError>).status === 401) {
          clearGuestSession(storage, siteId);
          setSession(null);
          setRsvp(null);
          setRsvpDraft({});
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
  }, [apiResult, now, siteId, storage]);

  useEffect(() => {
    if (phase !== "code" || !challenge) return;
    const interval = window.setInterval(() => setNowMs(now()), 1000);
    return () => window.clearInterval(interval);
  }, [challenge, now, phase]);

  if (!ready)
    return (
      <section className="entrelacos-guest-access" aria-busy="true">
        <p className="entrelacos-guest-access__eyebrow">
          Confirmação de presença
        </p>
        <p>Carregando seu acesso…</p>
      </section>
    );

  async function startLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiResult.api || busy) return;
    const parsed = guestLookupInputSchema.safeParse({
      fullName: fullName.trim(),
      phone: phone.trim(),
    });
    if (!parsed.success) {
      setError("Informe o nome completo e um celular brasileiro válido.");
      setNotice("");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiResult.api.start(
        parsed.data,
        demoMode ? demoGrant.trim() || undefined : undefined,
      );
      if (shouldDiscardGuestChallenge(result.sendStatus)) {
        setError(responseStatusMessage(result));
        setChallenge(null);
        return;
      }
      setChallenge(result);
      setCode("");
      setPhase("code");
      setNotice(responseStatusMessage(result));
    } catch (cause) {
      setError(errorWithRetry(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (!apiResult.api || !challenge || busy) return;
    if (getResendCountdownSeconds(challenge.resendAvailableAt, nowMs) > 0)
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiResult.api.resend(
        challenge.challengeId,
        demoMode ? demoGrant.trim() || undefined : undefined,
      );
      if (shouldDiscardGuestChallenge(result.sendStatus)) {
        setError(responseStatusMessage(result));
        setChallenge(null);
        setCode("");
        setPhase("lookup");
        return;
      }
      setChallenge(result);
      setNotice(responseStatusMessage(result));
    } catch (cause) {
      setError(errorWithRetry(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiResult.api || !challenge || busy) return;
    if (!isValidVerificationCode(code)) {
      setError(
        challenge.deliveryMode === "MANUAL_PIN"
          ? "Informe o PIN de 6 dígitos compartilhado com você."
          : "Informe o código de 6 dígitos recebido.",
      );
      return;
    }
    if (challengeExpired(challenge, nowMs)) {
      setError("Este acesso expirou. Confirme seus dados novamente.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiResult.api.verify({
        challengeId: challenge.challengeId,
        code,
      });
      if (!storage) throw new Error("Session storage unavailable");
      writeGuestSession(storage, siteId, result.sessionToken);
      setSession(sessionFromVerification(result));
      setChallenge(null);
      setPhase("authenticated");
      setNotice("Acesso confirmado.");
      const verifiedRsvp = await apiResult.api.getRsvp(result.sessionToken);
      setRsvp(verifiedRsvp);
      setRsvpDraft(
        createRsvpDraft(
          verifiedRsvp.members.map((member) => ({
            memberId: member.id,
            status: member.state,
            revision: member.revision,
          })),
        ),
      );
    } catch (cause) {
      const apiError = cause as Partial<GuestAccessApiError>;
      setError(
        challenge.deliveryMode === "MANUAL_PIN" &&
          apiError.code === "INVALID_CODE"
          ? "O PIN não confere. Confira o valor compartilhado e tente novamente."
          : errorWithRetry(cause),
      );
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
      setRsvpOpen(false);
      setChallenge(null);
      setCode("");
      setPhase("lookup");
      setNotice(getGuestLeaveNotice(serverConfirmed));
      setBusy(false);
    }
  }

  const resendSeconds = challenge
    ? getResendCountdownSeconds(challenge.resendAvailableAt, nowMs)
    : 0;

  async function reloadRsvp(preserveDraft: boolean) {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (!token || !apiResult.api) return;
    setBusy(true);
    setRsvpError("");
    try {
      const current = await apiResult.api.getRsvp(token);
      setRsvp(current);
      const snapshots = current.members.map((member) => ({
        memberId: member.id,
        status: member.state,
        revision: member.revision,
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
    const updates = pendingRsvpUpdates(rsvpDraft).map((member) => ({
      memberId: member.memberId,
      state: member.status,
      expectedRevision: member.expectedRevision,
    }));
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
        members: updates,
      });
      const byId = new Map(saved.members.map((member) => [member.id, member]));
      const members = rsvp.members.map(
        (member) => byId.get(member.id) ?? member,
      );
      setRsvp({ ...rsvp, members });
      setRsvpDraft(
        createRsvpDraft(
          members.map((member) => ({
            memberId: member.id,
            status: member.state,
            revision: member.revision,
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

  return (
    <section
      className="entrelacos-guest-access"
      aria-labelledby="guest-access-title"
    >
      <div className="entrelacos-guest-access__intro">
        <p className="entrelacos-guest-access__eyebrow">
          Confirmação de presença
        </p>
        <h2 id="guest-access-title">Encontre seu convite</h2>
        <p>
          Informe seu nome completo e o celular usado no convite para acessar os
          detalhes da sua família.
        </p>
      </div>

      <aside className="entrelacos-guest-access__foreign-note">
        <strong>Convidados com número estrangeiro</strong>
        <p>
          Números estrangeiros precisam de atendimento administrativo. Esse
          convite não oferece SMS nem outra alternativa de autenticação.
        </p>
      </aside>

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

      {phase === "lookup" && (
        <form className="entrelacos-guest-access__form" onSubmit={startLookup}>
          <label>
            Nome completo
            <input
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Como está no convite"
              required
            />
          </label>
          <label>
            Celular brasileiro
            <input
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(62) 99999-9999"
              required
            />
          </label>
          {demoMode && (
            <label>
              Autorização temporária da demonstração
              <input
                autoComplete="off"
                spellCheck={false}
                value={demoGrant}
                onChange={(event) => setDemoGrant(event.target.value)}
                placeholder="Cole a autorização emitida pelo OWNER"
              />
              <small>
                Opcional para SMS real. Obrigatória para revelar o código da
                simulação, expira em 5 minutos e fica somente nesta página.
              </small>
            </label>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Verificando…" : "Continuar"}
          </button>
        </form>
      )}

      {phase === "code" && challenge && (
        <form className="entrelacos-guest-access__form" onSubmit={verifyCode}>
          <p>
            {getGuestDeliveryMessage(
              challenge.deliveryMode,
              challenge.sendStatus,
            )}
          </p>
          {challenge.deliveryMode === "SIMULATED" &&
            challenge.simulationCode && (
              <p className="entrelacos-guest-access__simulation" role="status">
                Código da simulação: <strong>{challenge.simulationCode}</strong>
              </p>
            )}
          <label>
            {challenge.deliveryMode === "MANUAL_PIN"
              ? "PIN de 6 dígitos"
              : "Código de 6 dígitos"}
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, ""))
              }
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy
              ? "Confirmando…"
              : challenge.deliveryMode === "MANUAL_PIN"
                ? "Confirmar PIN"
                : "Confirmar código"}
          </button>
          {challenge.deliveryMode !== "MANUAL_PIN" && (
            <button
              type="button"
              className="entrelacos-guest-access__secondary"
              disabled={busy || resendSeconds > 0}
              onClick={() => void resendCode()}
            >
              {resendSeconds > 0
                ? `Reenviar código em ${resendSeconds}s`
                : "Reenviar código"}
            </button>
          )}
          <button
            type="button"
            className="entrelacos-guest-access__link"
            disabled={busy}
            onClick={() => {
              setChallenge(null);
              setCode("");
              setPhase("lookup");
              setError("");
              setNotice("");
            }}
          >
            Usar outros dados
          </button>
        </form>
      )}

      {phase === "authenticated" && session && (
        <div className="entrelacos-guest-access__family">
          <h3>Convidados deste convite</h3>
          <ul>
            {session.members.map((member) => (
              <li key={member.id}>
                <span>{member.fullName}</span>
                {member.isRepresentative && (
                  <small>Responsável pelo convite</small>
                )}
              </li>
            ))}
          </ul>
          {rsvp ? (
            <button type="button" onClick={() => setRsvpOpen(true)}>
              {rsvp.canEdit ? "Responder presença" : "Consultar respostas"}
            </button>
          ) : (
            <p role="status">
              As respostas de presença não estão disponíveis agora.
            </p>
          )}
          <button
            type="button"
            className="entrelacos-guest-access__secondary"
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
          members={rsvp.members.map((member) => ({
            memberId: member.id,
            fullName: member.fullName,
            isRepresentative: member.isRepresentative,
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
          onChange={(memberId, status) => {
            setRsvpDraft((draft) => setDraftStatus(draft, memberId, status));
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
