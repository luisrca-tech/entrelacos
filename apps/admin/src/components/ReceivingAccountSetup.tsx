import {
  meResponseSchema,
  type ReceivingReadiness,
  type ReceivingSetupContext,
  type ReceivingSetupReconcileResult,
  receivingReadinessResponseSchema,
  receivingSetupAccountSchema,
  receivingSetupReconcileResultSchema,
  receivingSetupResponseSchema,
  receivingSetupResultSchema,
} from "@entrelacos/contracts";
import { showSandboxNotice, toast } from "@entrelacos/ui";
import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  type FinancialReauthenticationGuard,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";
import { panelActorOwner } from "./panelActor";
import type {
  ReceivingSetupPorts,
  ReceivingSetupScope,
} from "./ReceivingSetup";
import {
  ActivationStep,
  DetailsStep,
  FeesStep,
  HolderStep,
  ReceivingOverviewTrack,
  type ReceivingStepSection,
  type ReceivingStepsContext,
} from "./ReceivingSteps";
import {
  type LabeledProviderRejection,
  readProviderRejection,
} from "./receivingProviderRejection";
import { normalizeSetupAccount } from "./receivingSetupForm";
import { deriveReceivingTrack } from "./receivingTrack";

function supportsIncomingVerification(
  mode: string | null | undefined,
): boolean {
  return (
    showSandboxNotice(mode) ||
    (typeof __APP_ENV__ !== "undefined" &&
      __APP_ENV__ === "production" &&
      mode === "live")
  );
}

// Pagar.me approval is what lets the API confirm the incoming account.
function providerApproved(setup: ReceivingSetupContext): boolean {
  return (
    setup.accountState === "CREATED" &&
    setup.providerStatus?.accountState === "APPROVED"
  );
}

export type ReceivingAccountSetupState = {
  status: "loading" | "ready" | "submitting" | "denied" | "unavailable";
  setup: ReceivingSetupContext | null;
  message: string | null;
  /** Pagar.me's refusal of the last submit, kept until the next one. */
  rejection?: LabeledProviderRejection | null;
  /** What "Verificar situação" found, shown until the next action. */
  verification?: ReceivingSetupVerification | null;
};
/**
 * "released": Pagar.me never received the registration, so the form is
 * open again; "unknown": still uncertain, to verify again later.
 */
export type ReceivingSetupVerification = {
  outcome: "released" | "unknown";
  text: string;
};
export type ReceivingSetupReconcileOutcome =
  | "released"
  | "stored"
  | "unknown"
  | "failed"
  | "skipped";
const releasedCopy =
  "A Pagar.me não recebeu seu cadastro. Mantivemos o que estava salvo: confira o nome e preencha de novo os campos marcados antes de enviar.";
const retryLaterCopy =
  "Ainda não conseguimos confirmar com a Pagar.me se o cadastro chegou. Tente de novo em alguns minutos.";
function uncertainCopy(
  result: Extract<ReceivingSetupReconcileResult, { outcome: "UNKNOWN" }>,
) {
  return result.reason === "WINDOW_NOT_ELAPSED" ||
    result.reason === "DISPATCH_IN_PROGRESS"
    ? "O envio anterior ainda é recente para a Pagar.me confirmar. Tente de novo em alguns minutos."
    : retryLaterCopy;
}
/** What became of a submit; the form keeps its data only when "rejected". */
export type ReceivingSetupSubmitOutcome =
  | "stored"
  | "unknown"
  | "rejected"
  | "failed"
  | "skipped";
export function createReceivingAccountSetupController(
  scope: ReceivingSetupScope,
  publish: (state: ReceivingAccountSetupState) => void,
  ports: ReceivingSetupPorts = {},
) {
  const owner = ports.owner ?? panelActorOwner;
  const request = ports.request ?? apiRequest;
  const now = ports.now ?? Date.now;
  const captured = owner.getSnapshot();
  const actor = captured.actor;
  const ownerView = actor?.user.role === "OWNER";
  const scopeKey = financialReauthenticationScopeKey({
    ...scope,
    action: "CONFIGURE_RECEIVING",
  });
  let disposed = false,
    invalidated = false,
    revision = 0;
  let incomingInFlight = false;
  let state: ReceivingAccountSetupState = {
    status: "loading",
    setup: null,
    message: null,
  };
  const listeners = new Set<() => void>();
  const current = () => {
    const time = now();
    return (
      !disposed &&
      !invalidated &&
      captured.status === "verified" &&
      actor !== null &&
      scope.sessionEpoch !== null &&
      captured.sessionEpoch === scope.sessionEpoch &&
      owner.getSnapshot() === captured &&
      Number.isSafeInteger(time) &&
      Date.parse(actor.session.expiresAt) > time &&
      (ownerView ||
        (scope.access?.siteId === scope.siteId &&
          scope.access.userId === actor.user.id &&
          !!scopeKey &&
          financialReauthenticationScopeKey({
            ...scope,
            action: "CONFIGURE_RECEIVING",
            access:
              actor.memberships?.find((item) => item.siteId === scope.siteId) ??
              null,
          }) === scopeKey))
    );
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const update = (next: ReceivingAccountSetupState) => {
    state = next;
    if (!disposed) publish(structuredClone(state));
  };
  const invalidate = () => {
    if (disposed) return;
    invalidated = true;
    revision++;
    update({ status: "denied", setup: null, message: null });
    notify();
  };
  const fail = (cause: unknown) => {
    if (!current()) return;
    owner.reportFailure(cause, scope.sessionEpoch);
    if (current())
      update({
        status: "unavailable",
        setup: null,
        message: "Não foi possível verificar a configuração. Tente novamente.",
      });
    notify();
  };
  async function load() {
    const response = receivingSetupResponseSchema.parse(
      await request(
        `/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/setup`,
      ),
    ).setup;
    if (
      response.siteId !== scope.siteId ||
      response.isHolder !== (response.holder?.userId === actor?.user.id)
    )
      throw new Error("Receiving holder context mismatch");
    return response;
  }
  async function refresh(
    automatic = true,
  ): Promise<ReceivingReadiness | undefined> {
    if (!current()) {
      invalidate();
      return;
    }
    const active = ++revision;
    update({ status: "loading", setup: null, message: null });
    notify();
    try {
      const setup = await load();
      if (current() && revision === active) {
        update({ status: "ready", setup, message: null });
        if (
          automatic &&
          setup.isHolder &&
          !ownerView &&
          setup.consentRecorded &&
          providerApproved(setup)
        )
          return await verifyIncoming();
      }
    } catch (cause) {
      if (revision === active) fail(cause);
    }
  }
  function createGuard(accountStates: readonly string[]) {
    const guard: FinancialReauthenticationGuard = {
      isCurrent: () =>
        current() &&
        actor?.user.role === "SITE_ADMIN" &&
        !!scopeKey &&
        state.setup?.isHolder === true &&
        state.status === "ready" &&
        state.setup !== null &&
        accountStates.includes(state.setup.accountState),
      async validate() {
        if (!guard.isCurrent() || owner.isSuspended?.()) return false;
        const active = revision,
          original = state.setup;
        try {
          const fresh = meResponseSchema.parse(await request("/v1/me"));
          if (!current() || revision !== active || owner.isSuspended?.())
            return false;
          if (
            JSON.stringify(fresh) !==
            JSON.stringify(meResponseSchema.parse(actor))
          ) {
            invalidate();
            return false;
          }
          const setup = await load();
          if (!current() || revision !== active || owner.isSuspended?.())
            return false;
          if (
            setup.holder?.userId !== original?.holder?.userId ||
            setup.policyVersion !== original?.policyVersion ||
            setup.disclosure.version !== original?.disclosure.version
          ) {
            update({
              status: "ready",
              setup,
              message:
                "A configuração mudou. Verifique os dados antes de continuar.",
            });
            notify();
            return false;
          }
          update({ ...state, setup });
          if (!guard.isCurrent()) notify();
          return guard.isCurrent();
        } catch (cause) {
          fail(cause);
          return false;
        }
      },
      subscribeInvalidation(listener) {
        listeners.add(listener);
        if (!guard.isCurrent()) listener();
        return () => {
          listeners.delete(listener);
        };
      },
    };
    return guard;
  }
  const guard = createGuard(["NOT_CREATED", "PENDING"]);
  const incomingGuard = createGuard(["CREATED"]);
  const reconcileGuard = createGuard(["UNKNOWN"]);
  async function verifyIncoming(): Promise<ReceivingReadiness | undefined> {
    if (
      incomingInFlight ||
      !supportsIncomingVerification(state.setup?.mode) ||
      !state.setup?.consentRecorded ||
      owner.isSuspended?.() ||
      !incomingGuard.isCurrent()
    )
      return;
    incomingInFlight = true;
    let active = revision;
    try {
      if (!(await incomingGuard.validate())) return;
      const setup = state.setup;
      if (
        !setup?.consentRecorded ||
        !supportsIncomingVerification(setup.mode) ||
        !incomingGuard.isCurrent() ||
        owner.isSuspended?.()
      )
        return;
      active = ++revision;
      update({ ...state, status: "submitting", message: null });
      notify();
      const { readiness } = receivingReadinessResponseSchema.parse(
        await request(
          `/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/incoming-verification`,
          {
            method: "POST",
            body: { confirmIncomingAccount: true },
          },
        ),
      );
      if (!current() || active !== revision) return;
      if (readiness.siteId !== scope.siteId || readiness.mode !== setup.mode)
        throw new Error("Unexpected incoming receiving readiness");
      await refresh(false);
      if (!current() || state.status !== "ready") return;
      update({
        ...state,
        message:
          "Cadastro consultado na Pagar.me. Confira a situação atual dos recebimentos.",
      });
      return readiness;
    } catch (cause) {
      if (
        revision === active &&
        current() &&
        cause instanceof ApiError &&
        cause.status === 503 &&
        state.setup
      ) {
        update({
          ...state,
          status: "ready",
          message:
            "Não foi possível atualizar a verificação na Pagar.me agora. Sua configuração está salva. Use Verificar situação para acompanhar.",
        });
      } else if (revision === active) fail(cause);
    } finally {
      incomingInFlight = false;
    }
  }
  const unsubscribe = owner.subscribe(() => {
    if (!current()) invalidate();
  });
  return {
    guard,
    incomingGuard,
    reconcileGuard,
    refresh,
    getState: () => structuredClone(state),
    verifyIncoming,
    async submit(
      account: unknown,
      confirmed: boolean,
    ): Promise<ReceivingSetupSubmitOutcome> {
      if (!confirmed || owner.isSuspended?.() || !(await guard.validate()))
        return "skipped";
      const parsed = receivingSetupAccountSchema.safeParse(account);
      if (!parsed.success) {
        update({
          ...state,
          message: "Confira os dados cadastrais antes de enviar.",
        });
        return "skipped";
      }
      const setup = state.setup;
      if (!setup || !guard.isCurrent() || owner.isSuspended?.()) {
        update({
          ...state,
          message: "Verifique o titular e a sessão antes de enviar o cadastro.",
        });
        return "skipped";
      }
      const active = ++revision;
      update({
        ...state,
        status: "submitting",
        message: null,
        rejection: null,
        verification: null,
      });
      notify();
      try {
        const result = receivingSetupResultSchema.parse(
          await request(
            `/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/setup`,
            {
              method: "POST",
              body: {
                account: parsed.data,
                policyVersion: setup.policyVersion,
                consentVersion: setup.disclosure.version,
                confirmHolder: true,
                consentToProvider: true,
              },
            },
          ),
        );
        if (!current() || active !== revision) return "skipped";
        await refresh();
        if (current())
          update({
            ...state,
            message:
              result.state === "STORED"
                ? "Cadastro enviado à Pagar.me. Acompanhe as verificações abaixo."
                : "O resultado ainda está incerto. Envie o cadastro de novo em alguns minutos: antes de criar outro, consultamos a Pagar.me.",
          });
        return result.state === "STORED" ? "stored" : "unknown";
      } catch (cause) {
        const rejection =
          cause instanceof ApiError &&
          cause.status === 422 &&
          cause.code === "RECEIVING_PROVIDER_REJECTED"
            ? (readProviderRejection(cause.problem) ?? {
                message: null,
                fields: [],
                formFields: [],
              })
            : null;
        if (rejection && current() && revision === active) {
          // Reload without unmounting the form, which keeps what was typed.
          let next = state.setup;
          try {
            next = await load();
          } catch {
            /* The refusal is known; the previous context still allows a resend. */
          }
          if (!current() || revision !== active) return "skipped";
          update({
            status: "ready",
            setup: next,
            message:
              "A Pagar.me recusou o cadastro. Corrija os dados indicados e envie novamente.",
            rejection,
          });
          return "rejected";
        }
        // A failed send keeps the form open with what was typed; the next
        // send is consulted on Pagar.me before anything is created again.
        if (
          cause instanceof ApiError &&
          cause.status !== 401 &&
          cause.status !== 403 &&
          current() &&
          revision === active &&
          state.setup
        ) {
          update({
            ...state,
            status: "ready",
            message:
              "Não foi possível enviar o cadastro agora. Seus dados continuam no formulário; tente de novo em alguns minutos.",
          });
          return "failed";
        }
        if (revision === active) fail(cause);
        return "failed";
      }
    },
    /**
     * "Verificar situação" for an uncertain dispatch: the API only reads
     * Pagar.me. A release reopens the form; nothing is ever resubmitted here.
     */
    async reconcile(): Promise<ReceivingSetupReconcileOutcome> {
      if (owner.isSuspended?.() || !(await reconcileGuard.validate()))
        return "skipped";
      const before = state;
      const active = ++revision;
      update({
        ...state,
        status: "submitting",
        message: null,
        rejection: null,
        verification: null,
      });
      notify();
      try {
        const result = receivingSetupReconcileResultSchema.parse(
          await request(
            `/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/setup/reconcile`,
            { method: "POST", body: { confirmReconcile: true } },
          ),
        );
        if (!current() || active !== revision) return "skipped";
        await refresh();
        if (!current() || state.status !== "ready") return "failed";
        if (result.outcome === "STORED") {
          update({
            ...state,
            message:
              "Cadastro consultado na Pagar.me. Agora confirme sua identidade.",
          });
          return "stored";
        }
        if (result.outcome === "RELEASED") {
          const reopened = ["NOT_CREATED", "PENDING"].includes(
            state.setup?.accountState ?? "",
          );
          update({
            ...state,
            message: releasedCopy,
            verification: reopened
              ? { outcome: "released", text: releasedCopy }
              : null,
          });
          return "released";
        }
        const text = uncertainCopy(result);
        update({
          ...state,
          message: text,
          verification: { outcome: "unknown", text },
        });
        return "unknown";
      } catch (cause) {
        // Only a lost session or permission leaves the panel; anything else
        // keeps the uncertain state to verify again later.
        if (
          !(cause instanceof ApiError && [401, 403].includes(cause.status)) &&
          current() &&
          revision === active &&
          before.setup
        ) {
          update({
            ...before,
            status: "ready",
            message: retryLaterCopy,
            verification: { outcome: "unknown", text: retryLaterCopy },
          });
          return "unknown";
        }
        if (revision === active) fail(cause);
        return "failed";
      }
    },
    async designate(holderUserId: string) {
      if (
        !ownerView ||
        !current() ||
        owner.isSuspended?.() ||
        state.setup?.holder ||
        !holderUserId.trim()
      )
        return;
      const active = ++revision;
      update({ ...state, status: "submitting", message: null });
      try {
        await request(
          `/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/holder`,
          { method: "POST", body: { holderUserId: holderUserId.trim() } },
        );
        if (current() && active === revision) await refresh();
      } catch (cause) {
        if (revision === active) fail(cause);
      }
    },
    dispose() {
      if (disposed) return;
      notify();
      disposed = true;
      revision++;
      unsubscribe();
      listeners.clear();
      state = { status: "denied", setup: null, message: null };
    },
  };
}
export function ReceivingAccountSetup(
  props: ReceivingSetupScope & {
    ports?: ReceivingSetupPorts;
    platformOwner?: boolean;
    onReadinessChange?: () => void;
    section?: ReceivingStepSection;
    readiness?: ReceivingReadiness | null;
    pricingEnabled?: boolean;
  },
) {
  const { siteId, access, sessionEpoch, ports } = props;
  const [state, setState] = useState<ReceivingAccountSetupState>({
    status: "loading",
    setup: null,
    message: null,
  });
  const controller = useRef<ReturnType<
    typeof createReceivingAccountSetupController
  > | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const readinessChanged = useRef(props.onReadinessChange);
  const automaticAttempts = useRef(new Set<string>());
  useLayoutEffect(() => {
    readinessChanged.current = props.onReadinessChange;
  }, [props.onReadinessChange]);
  useLayoutEffect(() => {
    const current = createReceivingAccountSetupController(
      { siteId, access, sessionEpoch },
      setState,
      ports,
    );
    controller.current = current;
    void current.refresh(false);
    return () => {
      form.current?.reset();
      current.dispose();
      controller.current = null;
    };
  }, [siteId, access, sessionEpoch, ports]);
  useEffect(() => {
    const setup = state.setup;
    const readiness = receivingReadinessResponseSchema.safeParse({
      readiness: props.readiness,
    });
    if (
      !readiness.success ||
      readiness.data.readiness.siteId !== siteId ||
      readiness.data.readiness.state === "READY" ||
      state.status !== "ready" ||
      !setup ||
      readiness.data.readiness.mode !== setup.mode ||
      !setup.isHolder ||
      !setup.consentRecorded ||
      !providerApproved(setup)
    )
      return;
    const key = JSON.stringify([
      siteId,
      sessionEpoch,
      setup.holder?.userId,
      setup.mode,
    ]);
    const current = controller.current;
    if (!current || automaticAttempts.current.has(key)) return;
    automaticAttempts.current.add(key);
    void current.verifyIncoming().then(() => {
      if (
        controller.current === current &&
        current.getState().status === "ready"
      )
        readinessChanged.current?.();
    });
  }, [props.readiness, state.setup, state.status, siteId, sessionEpoch]);
  useEffect(() => {
    if (!state.message) return;
    if (state.status === "unavailable") toast.error(state.message);
    else if (
      state.message.startsWith("Cadastro enviado") ||
      state.message.startsWith("Cadastro consultado")
    )
      toast.success(state.message);
    else toast.warning(state.message);
  }, [state.message, state.status]);
  return (
    <ReceivingAccountSetupView
      scope={props}
      section={props.section}
      readiness={props.readiness}
      pricingEnabled={props.pricingEnabled}
      platformOwner={props.platformOwner}
      state={state}
      guard={controller.current?.guard}
      incomingGuard={controller.current?.incomingGuard}
      reconcileGuard={controller.current?.reconcileGuard}
      ports={ports}
      form={form}
      onRetry={() => {
        const current = controller.current;
        void current?.refresh(props.readiness?.state !== "READY").then(() => {
          if (
            controller.current === current &&
            current.getState().status === "ready"
          )
            props.onReadinessChange?.();
        });
      }}
      onVerifyIncoming={() => {
        const current = controller.current;
        void current?.verifyIncoming().then(() => {
          if (
            controller.current === current &&
            current.getState().status === "ready"
          )
            props.onReadinessChange?.();
        });
      }}
      onDesignate={(id) => {
        void controller.current?.designate(id);
      }}
      onReconcile={() => {
        void controller.current?.reconcile();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const target = event.currentTarget;
        const data = new FormData(target);
        const account = normalizeSetupAccount(Object.fromEntries(data));
        const confirmed = data.get("consent") === "on";
        // The typed data is cleared only once the registration is stored.
        void controller.current?.submit(account, confirmed).then((outcome) => {
          if (outcome === "stored") target.reset();
        });
      }}
    />
  );
}
export function ReceivingAccountSetupView({
  scope,
  platformOwner = false,
  state,
  guard,
  incomingGuard,
  reconcileGuard,
  ports,
  onRetry,
  onSubmit,
  onDesignate,
  onVerifyIncoming,
  onReconcile,
  form,
  section = "activation",
  readiness,
  pricingEnabled = false,
}: {
  scope: ReceivingSetupScope;
  platformOwner?: boolean;
  state: ReceivingAccountSetupState;
  guard?: FinancialReauthenticationGuard;
  incomingGuard?: FinancialReauthenticationGuard;
  reconcileGuard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  onRetry?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onDesignate?: (holderUserId: string) => void;
  onVerifyIncoming?: () => void;
  onReconcile?: () => void;
  form?: React.RefObject<HTMLFormElement | null>;
  section?: ReceivingStepSection;
  readiness?: ReceivingReadiness | null;
  pricingEnabled?: boolean;
}) {
  const setup = state.setup;
  const busy = ["loading", "submitting"].includes(state.status);
  const owner = platformOwner || scope.access?.membershipRole === "OWNER";
  const canSubmit =
    !owner &&
    !!setup?.isHolder &&
    // UNKNOWN resends are consulted on Pagar.me before anything is created.
    ["NOT_CREATED", "PENDING", "UNKNOWN"].includes(setup.accountState) &&
    !!guard?.isCurrent();
  // While the holder's own submit is in flight the guard is not current,
  // but the form stays mounted (disabled) so a refusal keeps what was typed.
  const sending =
    !owner &&
    state.status === "submitting" &&
    !!setup?.isHolder &&
    ["NOT_CREATED", "PENDING"].includes(setup.accountState);
  // Only the holder consults Pagar.me about her own uncertain dispatch.
  const canReconcile =
    !owner &&
    !!setup?.isHolder &&
    setup.accountState === "UNKNOWN" &&
    !!reconcileGuard?.isCurrent();
  const parsedReadiness = receivingReadinessResponseSchema.safeParse({
    readiness,
  });
  const currentReadiness =
    parsedReadiness.success &&
    parsedReadiness.data.readiness.siteId === scope.siteId
      ? parsedReadiness.data.readiness
      : null;
  const receivingReady =
    !!currentReadiness &&
    currentReadiness.mode === setup?.mode &&
    currentReadiness.state === "READY";
  const track = deriveReceivingTrack({
    holder: !!setup?.holder,
    accountState: setup?.accountState ?? "NOT_CREATED",
    provider: setup?.providerStatus ?? null,
    ready: receivingReady,
  });
  const context: ReceivingStepsContext = {
    scope,
    setup,
    status: state.status,
    busy,
    owner,
    canSubmit,
    receivingReady,
    readiness: currentReadiness,
    rejection: state.rejection ?? null,
    verification: state.verification ?? null,
    sending,
    ...track,
    guard,
    incomingGuard,
    ports,
    form,
    incomingAvailable: supportsIncomingVerification(setup?.mode),
    onRetry,
    onSubmit,
    onDesignate,
    onVerifyIncoming,
    onReconcile: canReconcile ? onReconcile : undefined,
  };
  switch (section) {
    case "overview":
      return <ReceivingOverviewTrack context={context} />;
    case "holder":
      return <HolderStep context={context} />;
    case "details":
      return <DetailsStep context={context} />;
    case "fees":
      return <FeesStep context={context} pricingEnabled={pricingEnabled} />;
    default:
      return <ActivationStep context={context} />;
  }
}
