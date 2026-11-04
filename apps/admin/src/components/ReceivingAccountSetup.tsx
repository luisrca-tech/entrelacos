import {
  meResponseSchema,
  type ReceivingReadiness,
  type ReceivingSetupContext,
  receivingIncomingPixDisclosure,
  receivingReadinessResponseSchema,
  receivingSetupAccountSchema,
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
  AccountStep,
  ActivationStep,
  DetailsStep,
  FeesStep,
  HolderStep,
  ReceivingOverviewTrack,
  type ReceivingStepSection,
  type ReceivingStepsContext,
} from "./ReceivingSteps";
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

export type ReceivingAccountSetupState = {
  status: "loading" | "ready" | "submitting" | "denied" | "unavailable";
  setup: ReceivingSetupContext | null;
  message: string | null;
};
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
          setup.pixConsentRecorded === true &&
          setup.accountState === "CREATED" &&
          setup.providerStatus?.commercialInfoExpired !== true &&
          (["commercialInfo", "documentation", "general"] as const).every(
            (key) => setup.providerStatus?.[key] === "APPROVED",
          )
        )
          return await verifyIncoming();
      }
    } catch (cause) {
      if (revision === active) fail(cause);
    }
  }
  function createGuard(
    accountStates: readonly string[],
    allowOwnerRead = false,
  ) {
    const guard: FinancialReauthenticationGuard = {
      isCurrent: () =>
        current() &&
        ((allowOwnerRead && ownerView) ||
          (actor?.user.role === "SITE_ADMIN" &&
            !!scopeKey &&
            state.setup?.isHolder === true)) &&
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
  const pixGuard = createGuard(["CREATED"], true);
  const incomingGuard = createGuard(["CREATED"]);
  async function verifyIncoming(
    authorizePix = false,
  ): Promise<ReceivingReadiness | undefined> {
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
            body: {
              confirmIncomingAccount: true,
              ...(authorizePix
                ? { pixConsentVersion: receivingIncomingPixDisclosure.version }
                : {}),
            },
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
          "Conta consultada no Asaas. Confira a situação atual dos recebimentos.",
      });
      return readiness;
    } catch (cause) {
      if (
        revision === active &&
        current() &&
        cause instanceof ApiError &&
        cause.status === 409 &&
        [
          "RECEIVING_PIX_PREPARATION_PENDING",
          "RECEIVING_PIX_PREPARATION_REVIEW_REQUIRED",
        ].includes(cause.code)
      ) {
        await refresh(false);
        if (!current() || state.status !== "ready") return;
        update({
          ...state,
          status: "ready",
          message: cause.code.endsWith("REVIEW_REQUIRED")
            ? "A preparação dos recebimentos está em verificação. Não é necessário cadastrar outra chave. Se a situação persistir, entre em contato com o suporte."
            : "A preparação dos recebimentos aguarda a liberação do Asaas. Conclua as pendências da conta e use Verificar situação para acompanhar.",
        });
      } else if (
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
            "Não foi possível atualizar a verificação no Asaas agora. Sua configuração está salva. Use Verificar situação para acompanhar.",
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
    pixGuard,
    incomingGuard,
    refresh,
    getState: () => structuredClone(state),
    verifyIncoming,
    async submit(account: unknown, confirmed: boolean) {
      if (!confirmed || owner.isSuspended?.() || !(await guard.validate()))
        return;
      const parsed = receivingSetupAccountSchema.safeParse(account);
      if (!parsed.success) {
        update({
          ...state,
          message: "Confira os dados cadastrais antes de enviar.",
        });
        return;
      }
      const setup = state.setup;
      if (!setup || !guard.isCurrent() || owner.isSuspended?.()) {
        update({
          ...state,
          message: "Verifique o titular e a sessão antes de enviar o cadastro.",
        });
        return;
      }
      const active = ++revision;
      update({ ...state, status: "submitting", message: null });
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
                consentToAsaas: true,
                pixConsentVersion: receivingIncomingPixDisclosure.version,
              },
            },
          ),
        );
        if (!current() || active !== revision) return;
        await refresh();
        if (current())
          update({
            ...state,
            message:
              result.state === "STORED"
                ? "Cadastro enviado ao Asaas. Acompanhe as verificações abaixo."
                : "O resultado permanece incerto. Verifique a situação antes de tentar novamente.",
          });
      } catch (cause) {
        if (revision === active) fail(cause);
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
    feesChosen?: boolean;
    onFeesChosen?: () => void;
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
      !setup.pixConsentRecorded ||
      setup.accountState !== "CREATED" ||
      setup.providerStatus?.commercialInfoExpired === true ||
      !(["commercialInfo", "documentation", "general"] as const).every(
        (key) => setup.providerStatus?.[key] === "APPROVED",
      )
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
      state.message.startsWith("Conta consultada")
    )
      toast.success(state.message);
    else toast.warning(state.message);
  }, [state.message, state.status]);
  return (
    <ReceivingAccountSetupView
      scope={props}
      section={props.section}
      readiness={props.readiness}
      feesChosen={props.feesChosen}
      onFeesChosen={props.onFeesChosen}
      pricingEnabled={props.pricingEnabled}
      platformOwner={props.platformOwner}
      state={state}
      guard={controller.current?.guard}
      pixGuard={controller.current?.pixGuard}
      incomingGuard={controller.current?.incomingGuard}
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
      onAuthorizePix={() => {
        const current = controller.current;
        void current?.verifyIncoming(true).then(() => {
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
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const account = normalizeSetupAccount(Object.fromEntries(data));
        const confirmed = data.get("consent") === "on";
        event.currentTarget.reset();
        void controller.current?.submit(account, confirmed);
      }}
    />
  );
}
export function ReceivingAccountSetupView({
  scope,
  platformOwner = false,
  state,
  guard,
  pixGuard,
  incomingGuard,
  ports,
  onRetry,
  onSubmit,
  onDesignate,
  onVerifyIncoming,
  onAuthorizePix,
  onFeesChosen,
  form,
  section = "activation",
  readiness,
  feesChosen = false,
  pricingEnabled = false,
}: {
  scope: ReceivingSetupScope;
  platformOwner?: boolean;
  state: ReceivingAccountSetupState;
  guard?: FinancialReauthenticationGuard;
  pixGuard?: FinancialReauthenticationGuard;
  incomingGuard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  onRetry?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onDesignate?: (holderUserId: string) => void;
  onVerifyIncoming?: () => void;
  onAuthorizePix?: () => void;
  onFeesChosen?: () => void;
  form?: React.RefObject<HTMLFormElement | null>;
  section?: ReceivingStepSection;
  readiness?: ReceivingReadiness | null;
  feesChosen?: boolean;
  pricingEnabled?: boolean;
}) {
  const setup = state.setup;
  const busy = ["loading", "submitting"].includes(state.status);
  const owner = platformOwner || scope.access?.membershipRole === "OWNER";
  const canSubmit =
    !owner &&
    !!setup?.isHolder &&
    ["NOT_CREATED", "PENDING"].includes(setup.accountState) &&
    !!guard?.isCurrent();
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
    destinationSaved:
      !!currentReadiness && currentReadiness.destinationVersion !== null,
    feesChosen,
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
    ...track,
    feesChosen,
    guard,
    pixGuard,
    incomingGuard,
    ports,
    form,
    incomingAvailable: supportsIncomingVerification(setup?.mode),
    onRetry,
    onSubmit,
    onDesignate,
    onVerifyIncoming,
    onAuthorizePix,
    onFeesChosen,
  };
  switch (section) {
    case "overview":
      return <ReceivingOverviewTrack context={context} />;
    case "holder":
      return <HolderStep context={context} />;
    case "details":
      return <DetailsStep context={context} />;
    case "account":
      return <AccountStep context={context} />;
    case "fees":
      return <FeesStep context={context} pricingEnabled={pricingEnabled} />;
    default:
      return <ActivationStep context={context} />;
  }
}
