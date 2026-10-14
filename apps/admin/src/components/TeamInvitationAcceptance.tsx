import {
  type MeResponse,
  meResponseSchema,
  siteTeamInviteInputSchema,
} from "@entrelacos/contracts";
import { Button, Input, PasswordInput } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { ApiError, apiRequest } from "../lib/apiClient";
import { AuthLayout } from "./AuthLayout";
import { hasValidAccessToken, readAccessTokenFromHash } from "./accessToken";
import { type PanelSessionSnapshot, panelActorOwner } from "./panelActor";
import { acceptTeamInvitation, type TeamAcceptance } from "./teamAcceptance";

export type TeamAcceptancePorts = {
  owner?: typeof panelActorOwner;
  request?: (
    path: string,
    options?: { method?: string; body?: unknown },
  ) => Promise<unknown>;
  now?: () => number;
  isCurrent?: () => boolean;
  onInvalidate?: (isCurrent?: () => boolean) => void;
};
export type TeamAcceptanceState = {
  ready: boolean;
  sessionUnavailable: boolean;
  actor: MeResponse | null;
  mode: "existing" | "new" | null;
  pending: boolean;
  error: string;
  completed: { siteId: string; signedIn: boolean } | null;
  validToken: boolean;
};
const emptyAcceptanceState: TeamAcceptanceState = {
  ready: false,
  sessionUnavailable: false,
  actor: null,
  mode: null,
  pending: false,
  error: "",
  completed: null,
  validToken: false,
};
const defaultAcceptancePorts: TeamAcceptancePorts = {};

export function createTeamAcceptanceController(
  initialToken: string,
  onChange: (state: TeamAcceptanceState) => void,
  ports: TeamAcceptancePorts = {},
) {
  const owner = ports.owner ?? panelActorOwner;
  const request = ports.request ?? apiRequest;
  let token = hasValidAccessToken(initialToken) ? initialToken : "";
  let active = true;
  let busy = false;
  let revision = 0;
  let clock = -1;
  let reading = false;
  let entryLoading = false;
  let entrySettled = false;
  let snapshot: PanelSessionSnapshot | null = null;
  let nativeActor: MeResponse | null = null;
  let eventWindow: "init" | "finish" | "membership" | null = null;
  let events = 0;
  let notifications = 0;
  let state: TeamAcceptanceState = {
    ...emptyAcceptanceState,
    validToken: Boolean(token),
  };
  function instance() {
    try {
      return (
        active &&
        ports.isCurrent?.() !== false &&
        (ports.owner ?? panelActorOwner) === owner &&
        active
      );
    } catch {
      return false;
    }
  }
  function time() {
    const value = (ports.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0 || value < clock)
      throw new Error("Invalid session clock");
    clock = value;
    return value;
  }
  function current(attempt = revision) {
    try {
      if (
        !instance() ||
        attempt !== revision ||
        !snapshot ||
        owner.getSnapshot() !== snapshot
      )
        return false;
      const now = time();
      const observed = owner.getSnapshot();
      const liveInstance = instance();
      return (
        (!nativeActor || Date.parse(nativeActor.session.expiresAt) > now) &&
        active &&
        liveInstance &&
        attempt === revision &&
        observed === snapshot
      );
    } catch {
      return false;
    }
  }
  function notify() {
    try {
      onChange(state);
    } catch {
      active = false;
      revision++;
      busy = false;
      token = "";
      state = {
        ...emptyAcceptanceState,
        ready: true,
        sessionUnavailable: true,
      };
    }
  }
  function invalidate() {
    if (!active) return;
    const mounted = instance();
    active = false;
    revision++;
    busy = false;
    token = "";
    nativeActor = null;
    state = {
      ...emptyAcceptanceState,
      ready: true,
      sessionUnavailable: true,
      error: "Seu acesso mudou. Abra novamente o link do convite.",
    };
    if (mounted) {
      try {
        const closingRevision = revision;
        const closingNotification = notifications;
        const stillOwned = () => {
          const live =
            ports.isCurrent?.() !== false &&
            (ports.owner ?? panelActorOwner) === owner;
          return (
            live &&
            revision === closingRevision &&
            notifications === closingNotification
          );
        };
        const cleanup = ports.onInvalidate;
        if (stillOwned()) cleanup?.(stillOwned);
      } catch {}
      notify();
    }
  }
  const unsubscribe = owner.subscribe(() => {
    notifications++;
    if (!active) return;
    const next = owner.getSnapshot();
    if (reading) {
      if (!entryLoading && next.status === "loading") {
        entryLoading = true;
        return;
      }
      if (
        entryLoading &&
        !entrySettled &&
        ["verified", "unauthenticated", "denied", "unavailable"].includes(
          next.status,
        )
      ) {
        entrySettled = true;
        return;
      }
      invalidate();
      return;
    }
    if (
      eventWindow &&
      events === 0 &&
      instance() &&
      next.status === "unverified" &&
      next.actor === null &&
      next.sessionEpoch === null
    ) {
      events++;
      snapshot = next;
      return;
    }
    invalidate();
  });
  function publish(next: TeamAcceptanceState, attempt = revision) {
    if (!current(attempt)) return false;
    state = next;
    notify();
    return current(attempt);
  }
  function assertCurrent(attempt: number) {
    if (!current(attempt)) throw new Error("Invitation ownership changed");
  }
  async function transport(
    attempt: number,
    path: string,
    options?: { method?: string; body?: unknown },
  ) {
    assertCurrent(attempt);
    const result = await request(path, options);
    assertCurrent(attempt);
    return result;
  }
  function parseActor(value: unknown) {
    const actor = meResponseSchema.parse(value);
    if (
      Date.parse(actor.session.expiresAt) <= time() ||
      actor.memberships?.some((access) => access.userId !== actor.user.id)
    )
      throw new Error("Invalid administrative identity");
    return actor;
  }
  function sameIdentity(left: MeResponse, right: MeResponse) {
    return (
      JSON.stringify(left.user) === JSON.stringify(right.user) &&
      JSON.stringify(left.session) === JSON.stringify(right.session)
    );
  }
  async function freshActor(attempt: number, expected?: MeResponse) {
    const fresh = parseActor(await transport(attempt, "/v1/me"));
    assertCurrent(attempt);
    if (expected && !sameIdentity(fresh, expected)) {
      invalidate();
      throw new Error("Native identity changed");
    }
    return fresh;
  }
  async function anonymous(attempt: number) {
    try {
      await transport(attempt, "/v1/me");
    } catch (cause) {
      assertCurrent(attempt);
      if (cause instanceof ApiError && cause.status === 401) return;
      throw cause;
    }
    invalidate();
    throw new Error("Anonymous identity changed");
  }
  async function readEntry(attempt: number, refresh: boolean) {
    reading = true;
    entryLoading = owner.getSnapshot().status === "loading";
    entrySettled = false;
    try {
      const load = owner.load;
      if (!instance() || attempt !== revision) return;
      const result = await load.call(owner, refresh);
      if (!instance() || attempt !== revision) return;
      reading = false;
      const next = owner.getSnapshot();
      if (
        next.status !== "verified" ||
        next.actor !== result ||
        next.sessionEpoch === null
      )
        throw new Error("Entry ownership changed");
      parseActor(result);
      nativeActor = result;
      if (!instance() || owner.getSnapshot() !== next || attempt !== revision)
        return;
      snapshot = next;
      publish(
        {
          ...state,
          actor: nativeActor,
          ready: true,
          sessionUnavailable: false,
          error: "",
        },
        attempt,
      );
    } catch (cause) {
      if (!instance() || attempt !== revision) return;
      reading = false;
      const next = owner.getSnapshot();
      snapshot = next;
      nativeActor = null;
      const isAnonymous =
        cause instanceof ApiError &&
        cause.status === 401 &&
        next.status === "unauthenticated";
      publish(
        {
          ...state,
          actor: null,
          ready: true,
          sessionUnavailable: !isAnonymous,
          error: isAnonymous
            ? ""
            : "Não foi possível verificar sua sessão. Tente novamente antes de continuar.",
        },
        attempt,
      );
    } finally {
      reading = false;
    }
  }
  async function start() {
    if (!instance() || busy) return;
    if (!token) {
      state = { ...emptyAcceptanceState, ready: true };
      notify();
      return;
    }
    busy = true;
    const attempt = ++revision;
    state = {
      ...state,
      ready: false,
      pending: true,
      sessionUnavailable: false,
      error: "",
      actor: null,
      completed: null,
    };
    notify();
    if (!instance() || attempt !== revision) return;
    await readEntry(attempt, true);
    if (current(attempt)) {
      busy = false;
      publish({ ...state, pending: false }, attempt);
    }
  }
  function reserve() {
    if (
      busy ||
      !token ||
      !state.ready ||
      state.sessionUnavailable ||
      !current()
    )
      return null;
    busy = true;
    const attempt = ++revision;
    return publish({ ...state, pending: true, error: "" }, attempt)
      ? attempt
      : null;
  }
  function nativeSuccess(result: unknown) {
    if (
      !result ||
      typeof result !== "object" ||
      Object.keys(result).length !== 1 ||
      !("ok" in result) ||
      result.ok !== true
    )
      throw new Error("Invalid authentication response");
  }
  async function authenticate<T>(attempt: number, operation: () => Promise<T>) {
    assertCurrent(attempt);
    const run = owner.runAuthentication;
    assertCurrent(attempt);
    eventWindow = "init";
    events = 0;
    try {
      return await run(async () => {
        eventWindow = null;
        if (events !== 1) throw new Error("Unattributed authentication start");
        assertCurrent(attempt);
        try {
          return await operation();
        } finally {
          if (current(attempt)) {
            eventWindow = "finish";
            events = 0;
          }
        }
      });
    } finally {
      const valid = current(attempt) && finishedAuthentication();
      eventWindow = null;
      if (!valid) invalidate();
    }
  }
  function finish(attempt: number) {
    if (!current(attempt)) return;
    busy = false;
    publish({ ...state, pending: false }, attempt);
  }
  function finishedAuthentication() {
    return eventWindow === "finish" && events === 1;
  }
  function dropToken(attempt: number) {
    if (!current(attempt)) return false;
    token = "";
    state = { ...state, validToken: false };
    try {
      const cleanup = ports.onInvalidate;
      if (!current(attempt)) return false;
      cleanup?.(() => current(attempt));
    } catch {
      invalidate();
      return false;
    }
    return current(attempt);
  }
  async function accept(input: TeamAcceptance) {
    if (
      input.mode === "signedIn"
        ? !state.actor
        : state.actor !== null || state.mode !== input.mode
    )
      return;
    const attempt = reserve();
    if (attempt === null) return;
    const original = nativeActor;
    try {
      let binding = original;
      if (input.mode === "signedIn") {
        if (!binding) return;
        const fresh = await freshActor(attempt, binding);
        if (JSON.stringify(fresh) !== JSON.stringify(original)) {
          invalidate();
          return;
        }
      } else {
        await anonymous(attempt);
      }
      assertCurrent(attempt);
      const capability = token;
      const guarded = async (
        path: string,
        options: { method: string; body: unknown },
      ) => {
        if (path === "/v1/auth/sign-in/email") {
          const result = await transport(attempt, path, options);
          nativeSuccess(result);
          assertCurrent(attempt);
          const fresh = await freshActor(attempt);
          if (
            input.mode !== "existing" ||
            fresh.user.email.trim().toLowerCase() !==
              siteTeamInviteInputSchema.shape.email.parse(input.email)
          ) {
            invalidate();
            throw new Error("Unexpected signed-in account");
          }
          binding = fresh;
          nativeActor = fresh;
          assertCurrent(attempt);
          return result;
        }
        return transport(attempt, path, options);
      };
      const operation = async () => {
        const result = await acceptTeamInvitation(capability, input, guarded);
        assertCurrent(attempt);
        if (input.mode === "new") await anonymous(attempt);
        else {
          if (!binding) throw new Error("Missing native identity");
          await freshActor(attempt, binding);
        }
        assertCurrent(attempt);
        return result;
      };
      const result =
        input.mode === "existing"
          ? await authenticate(attempt, operation)
          : await operation();
      assertCurrent(attempt);
      if (input.mode === "signedIn") {
        const reset = owner.invalidate;
        assertCurrent(attempt);
        eventWindow = "membership";
        events = 0;
        reset.call(owner);
        const valid = current(attempt) && events === 1;
        eventWindow = null;
        if (!valid) {
          invalidate();
          return;
        }
      }
      if (!dropToken(attempt)) return;
      publish(
        {
          ...state,
          validToken: false,
          completed: { ...result, signedIn: input.mode !== "new" },
        },
        attempt,
      );
    } catch (cause) {
      if (!current(attempt)) return;
      if (input.mode === "signedIn") {
        const report = owner.reportFailure;
        if (!current(attempt)) return;
        report.call(owner, cause, snapshot?.sessionEpoch ?? null);
        if (!current(attempt)) return;
      }
      const message =
        cause instanceof ApiError &&
        cause.code === "TEAM_INVITATION_ACCOUNT_REQUIRED"
          ? "Entre na conta do e-mail convidado para aceitar. Sua senha será preservada."
          : cause instanceof ApiError &&
              cause.code === "TEAM_INVITATION_INVALID"
            ? "Este convite está inválido, expirado ou já foi utilizado. Peça um novo link ao casal."
            : cause instanceof ApiError && cause.code === "TEAM_MEMBER_CONFLICT"
              ? "Este convite conflita com um acesso de administrador. Peça ajuda ao casal."
              : "Não foi possível aceitar o convite. Tente novamente.";
      publish(
        {
          ...state,
          error: message,
          sessionUnavailable:
            input.mode === "existing" && snapshot?.status !== "unauthenticated",
        },
        attempt,
      );
    } finally {
      finish(attempt);
    }
  }
  async function signOut() {
    if (!state.actor || !nativeActor) return;
    const original = nativeActor;
    const attempt = reserve();
    if (attempt === null) return;
    try {
      const fresh = await freshActor(attempt, original);
      if (JSON.stringify(fresh) !== JSON.stringify(original)) {
        invalidate();
        return;
      }
      await authenticate(attempt, async () => {
        nativeSuccess(
          await transport(attempt, "/v1/auth/sign-out", {
            method: "POST",
            body: {},
          }),
        );
        assertCurrent(attempt);
        await anonymous(attempt);
        nativeActor = null;
        assertCurrent(attempt);
      });
      assertCurrent(attempt);
      await readEntry(attempt, true);
      if (!current(attempt)) return;
      publish(
        {
          ...state,
          mode:
            state.actor === null && !state.sessionUnavailable
              ? "existing"
              : null,
        },
        attempt,
      );
    } catch {
      if (current(attempt))
        publish(
          {
            ...state,
            sessionUnavailable: true,
            error:
              "Não foi possível sair. Verifique sua sessão antes de continuar.",
          },
          attempt,
        );
    } finally {
      finish(attempt);
    }
  }
  return {
    getState: () => state,
    start,
    accept,
    signOut,
    setMode(mode: "existing" | "new") {
      if (busy) {
        if (mode !== state.mode) invalidate();
        return;
      }
      if (state.actor || !current() || state.sessionUnavailable || !token)
        return;
      revision++;
      publish({ ...state, mode, error: "" });
    },
    dispose() {
      active = false;
      revision++;
      busy = false;
      token = "";
      nativeActor = null;
      state = { ...emptyAcceptanceState };
      unsubscribe();
    },
  };
}

export function TeamInvitationAcceptance({
  ports = defaultAcceptancePorts,
}: {
  ports?: TeamAcceptancePorts;
}) {
  const owner = ports.owner ?? panelActorOwner;
  const token = useRef({ captured: false, value: "" });
  const password = useRef<HTMLInputElement | null>(null);
  const attachPassword = useCallback((input: HTMLInputElement | null) => {
    if (password.current && password.current !== input)
      password.current.value = "";
    password.current = input;
  }, []);
  const holder = useRef<ReturnType<
    typeof createTeamAcceptanceController
  > | null>(null);
  const livePorts = useRef(ports);
  const liveOwner = useRef(owner);
  liveOwner.current = owner;
  const binding = useRef<{
    ports: TeamAcceptancePorts;
    owner: typeof panelActorOwner;
  } | null>(null);
  if (binding.current && binding.current.owner !== owner)
    token.current.value = "";
  livePorts.current = ports;
  const [state, setState] = useState<TeamAcceptanceState>(emptyAcceptanceState);
  useEffect(() => {
    if (!token.current.captured) {
      token.current = {
        captured: true,
        value: readAccessTokenFromHash(window.location.hash),
      };
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    const controller = createTeamAcceptanceController(
      token.current.value,
      (next) => {
        if (
          holder.current === controller &&
          livePorts.current === ports &&
          liveOwner.current === owner
        ) {
          if (!next.validToken) {
            token.current.value = "";
            if (password.current) password.current.value = "";
          }
          setState(next);
        }
      },
      {
        ...ports,
        isCurrent: () =>
          holder.current === controller &&
          livePorts.current === ports &&
          liveOwner.current === owner &&
          ports.isCurrent?.() !== false,
        onInvalidate: (isCurrent) => {
          const cleanup = ports.onInvalidate;
          if (
            holder.current !== controller ||
            livePorts.current !== ports ||
            liveOwner.current !== owner ||
            isCurrent?.() === false
          )
            return;
          token.current.value = "";
          if (password.current) password.current.value = "";
          if (isCurrent?.() !== false) cleanup?.(isCurrent);
        },
      },
    );
    holder.current = controller;
    binding.current = { ports, owner };
    setState(controller.getState());
    void controller.start();
    return () => {
      if (holder.current === controller) holder.current = null;
      if (password.current) password.current.value = "";
      controller.dispose();
    };
  }, [ports, owner]);
  const {
    ready,
    sessionUnavailable,
    actor,
    mode,
    pending,
    error,
    completed,
    validToken,
  } =
    binding.current?.ports === ports &&
    binding.current.owner === owner &&
    holder.current
      ? state
      : emptyAcceptanceState;
  const controller = holder.current;
  function setMode(next: "existing" | "new") {
    if (
      holder.current !== controller ||
      binding.current?.ports !== ports ||
      binding.current.owner !== owner
    )
      return;
    if (password.current) password.current.value = "";
    controller?.setMode(next);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      holder.current !== controller ||
      binding.current?.ports !== ports ||
      binding.current.owner !== owner
    )
      return;
    if (!mode) return;
    const form = new FormData(event.currentTarget);
    const submittedPassword = String(form.get("password") ?? "");
    if (password.current) password.current.value = "";
    void controller?.accept(
      mode === "new"
        ? { mode: "new", password: submittedPassword }
        : {
            mode: "existing",
            email: String(form.get("email") ?? ""),
            password: submittedPassword,
          },
    );
  }

  return (
    <AuthLayout>
      <div className="grid min-w-0 gap-5">
        <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-muted">
          Equipe do casamento
        </p>
        <h1 className={`${displayHeading} m-0 text-3xl`}>
          {completed ? "Convite aceito" : "Aceitar convite de assessor"}
        </h1>
        {completed ? (
          <>
            <p className="m-0 text-admin-muted">
              Seu acesso de assessor foi associado a este casamento.{" "}
              {completed.signedIn
                ? "Você pode abrir o painel."
                : "Entre com o e-mail que recebeu o convite e a senha que acabou de criar."}
            </p>
            {completed.signedIn ? (
              <Link
                className="text-admin-terracotta-deep underline"
                to="/sites/$siteId/invitations"
                params={{ siteId: completed.siteId }}
              >
                Abrir casamento
              </Link>
            ) : (
              <Link
                className="text-admin-terracotta-deep underline"
                to="/login"
                search={{
                  email: "",
                  next: `/sites/${encodeURIComponent(completed.siteId)}/invitations`,
                }}
              >
                Ir para o login
              </Link>
            )}
          </>
        ) : !ready ? (
          <p role="status">Verificando seu acesso…</p>
        ) : !validToken ? (
          <p role="alert" className={adminStyles.alert}>
            Link inválido. Peça um novo convite ao casal.
          </p>
        ) : (
          <>
            <p className="m-0 leading-relaxed text-admin-muted">
              O convite dá acesso aos convites, às mensagens e aos presentes
              deste casamento. O financeiro e os recebimentos ficam reservados
              ao casal.
            </p>
            {error && (
              <p role="alert" className={adminStyles.alert}>
                {error}
              </p>
            )}
            {sessionUnavailable ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void controller?.start()}
              >
                Tentar novamente
              </Button>
            ) : actor ? (
              <>
                <p className="m-0 break-words text-admin-muted">
                  Você está conectado como {actor.user.email}. Confirme somente
                  se este é o e-mail convidado.
                </p>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => void controller?.accept({ mode: "signedIn" })}
                >
                  {pending ? "Aceitando…" : "Aceitar convite"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void controller?.signOut()}
                >
                  Usar outra conta
                </Button>
              </>
            ) : (
              <>
                <fieldset
                  className="m-0 flex flex-wrap gap-3 border-0 p-0"
                  aria-label="Forma de acesso"
                >
                  <Button
                    type="button"
                    variant={mode === "existing" ? "default" : "outline"}
                    disabled={pending}
                    onClick={() => {
                      setMode("existing");
                    }}
                  >
                    Já tenho acesso
                  </Button>
                  <Button
                    type="button"
                    variant={mode === "new" ? "default" : "outline"}
                    disabled={pending}
                    onClick={() => {
                      setMode("new");
                    }}
                  >
                    Primeiro acesso
                  </Button>
                </fieldset>
                {mode && (
                  <form
                    key={mode}
                    className={adminStyles.authForm}
                    onSubmit={submit}
                  >
                    {mode === "existing" && (
                      <label htmlFor="team-login-email" className="grid gap-2">
                        E-mail convidado
                        <Input
                          id="team-login-email"
                          name="email"
                          type="email"
                          required
                          maxLength={254}
                          autoComplete="email"
                          disabled={pending}
                        />
                      </label>
                    )}
                    <div className="grid gap-2">
                      <label htmlFor="team-accept-password">
                        {mode === "new"
                          ? "Crie sua senha (6 a 10 caracteres)"
                          : "Sua senha atual"}
                      </label>
                      <PasswordInput
                        ref={attachPassword}
                        id="team-accept-password"
                        name="password"
                        required
                        minLength={mode === "new" ? 6 : 1}
                        maxLength={mode === "new" ? 10 : 200}
                        autoComplete={
                          mode === "new" ? "new-password" : "current-password"
                        }
                        disabled={pending}
                      />
                    </div>
                    <p className="m-0 text-sm text-admin-muted">
                      {mode === "new"
                        ? "Se você já possui uma conta, escolha Já tenho acesso. O convite não redefine senhas existentes."
                        : "Você entrará na conta existente; sua senha e seus outros casamentos serão preservados."}
                    </p>
                    <Button type="submit" disabled={pending}>
                      {pending ? "Aceitando…" : "Aceitar convite"}
                    </Button>
                  </form>
                )}
              </>
            )}
          </>
        )}
      </div>
    </AuthLayout>
  );
}
