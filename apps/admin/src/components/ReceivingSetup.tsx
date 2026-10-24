import {
  meResponseSchema,
  type ReceivingNominationContext,
  receivingNominationContextSchema,
  receivingNominationResponseSchema,
  type SiteAccess,
} from "@entrelacos/contracts";
import { Button, showSandboxNotice } from "@entrelacos/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  type FinancialReauthenticationGuard,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";
import { type createPanelActorOwner, panelActorOwner } from "./panelActor";
import { ReceivingNominationForm } from "./ReceivingNominationForm";
import type { ReceivingNominationState } from "./receivingNominationClient";
import { loadReceivingNominationContext } from "./receivingNominationContextClient";
export type ReceivingSetupScope = {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
};
export type ReceivingSetupState = {
  status: "idle" | "loading" | "ready" | "denied" | "unavailable";
  context: ReceivingNominationContext | null;
  uncertain: boolean;
};
export type ReceivingSetupPorts = {
  request?: (
    path: string,
    options?: { method: string; body: unknown },
  ) => Promise<unknown>;
  owner?: ReturnType<typeof createPanelActorOwner>;
  now?: () => number;
};
export function createReceivingSetupController(
  scope: ReceivingSetupScope,
  onState: (state: ReceivingSetupState) => void,
  ports: ReceivingSetupPorts = {},
) {
  const owner = ports.owner ?? panelActorOwner;
  const request = ports.request ?? apiRequest;
  const now = ports.now ?? (() => Date.now());
  const captured = owner.getSnapshot();
  const key = financialReauthenticationScopeKey({
    ...scope,
    action: "CONFIGURE_RECEIVING",
  });
  let state: ReceivingSetupState = {
    status: "idle",
    context: null,
    uncertain: false,
  };
  let retained: ReceivingNominationContext | null = null;
  let knownPending = false;
  let disposed = false;
  let invalidated = false;
  let revision = 0;
  let loading: Promise<void> | null = null;
  let validating: Promise<boolean> | null = null;
  const invalidationListeners = new Set<() => void>();
  function frameCurrent() {
    const time = now();
    const selected = captured.actor?.memberships?.find(
      (entry) =>
        entry.siteId === scope.siteId &&
        entry.userId === captured.actor?.user.id,
    );
    return (
      !disposed &&
      !invalidated &&
      !!key &&
      captured.status === "verified" &&
      captured.actor !== null &&
      captured.sessionEpoch === scope.sessionEpoch &&
      captured.sessionEpoch !== null &&
      owner.getSnapshot() === captured &&
      Number.isSafeInteger(time) &&
      time >= 0 &&
      Date.parse(captured.actor.session.expiresAt) > time &&
      financialReauthenticationScopeKey({
        ...scope,
        action: "CONFIGURE_RECEIVING",
      }) === key &&
      financialReauthenticationScopeKey({
        ...scope,
        access: selected ?? null,
        action: "CONFIGURE_RECEIVING",
      }) === key
    );
  }
  function publish(next: ReceivingSetupState) {
    state = next;
    if (!disposed) onState(structuredClone(next));
  }
  function discard() {
    for (const listener of [...invalidationListeners]) {
      try {
        listener();
      } catch {}
    }
  }
  function invalidate() {
    if (disposed || invalidated) return;
    invalidated = true;
    revision++;
    loading = null;
    validating = null;
    publish({ status: "denied", context: null, uncertain: state.uncertain });
    discard();
  }
  function current() {
    if (!frameCurrent()) {
      invalidate();
      return false;
    }
    return true;
  }
  function binding(context: ReceivingNominationContext) {
    return JSON.stringify([
      context.siteId,
      context.mode,
      context.requestId,
      context.policyVersion,
    ]);
  }
  function install(context: ReceivingNominationContext) {
    if (
      context.siteId !== scope.siteId ||
      (retained && binding(context) !== binding(retained)) ||
      (knownPending && context.state !== "PENDING")
    )
      throw new Error("Receiving context changed");
    retained ??= structuredClone(context);
    const next: ReceivingSetupState = {
      status: "ready",
      context,
      uncertain: context.state === "PENDING" ? false : state.uncertain,
    };
    if (JSON.stringify(state) !== JSON.stringify(next)) publish(next);
    if (context.state === "PENDING") {
      knownPending = true;
      discard();
    }
  }
  function fail(cause: unknown, authentication = false) {
    if (!current()) return;
    if (cause instanceof ApiError && [401, 403].includes(cause.status))
      owner.reportFailure(cause, scope.sessionEpoch);
    else if (authentication) owner.invalidate();
    if (!current()) return;
    publish({
      status: "unavailable",
      context: null,
      uncertain: state.uncertain,
    });
    discard();
  }
  function refresh(): Promise<void> {
    if (!current()) return Promise.resolve();
    if (loading) return loading;
    const activeRevision = ++revision;
    validating = null;
    const work = Promise.resolve()
      .then(async () => {
        if (!current() || revision !== activeRevision) return;
        try {
          const context = await loadReceivingNominationContext(
            scope.siteId,
            request,
          );
          if (current() && revision === activeRevision) install(context);
        } catch (cause) {
          if (revision === activeRevision) fail(cause);
        }
      })
      .finally(() => {
        if (loading === work) loading = null;
      });
    loading = work;
    publish({ status: "loading", context: null, uncertain: state.uncertain });
    discard();
    return work;
  }
  const guard: FinancialReauthenticationGuard = {
    isCurrent() {
      return (
        frameCurrent() &&
        state.status === "ready" &&
        state.context?.state === "AVAILABLE"
      );
    },
    validate() {
      if (!guard.isCurrent()) return Promise.resolve(false);
      if (validating) return validating;
      const activeRevision = revision;
      const work = Promise.resolve()
        .then(async () => {
          if (!guard.isCurrent() || revision !== activeRevision) return false;
          let authentication = true;
          try {
            const raw = await request("/v1/me");
            if (!guard.isCurrent() || revision !== activeRevision) return false;
            const fresh = meResponseSchema.parse(raw);
            const time = now();
            if (
              !Number.isSafeInteger(time) ||
              time < 0 ||
              Date.parse(fresh.session.expiresAt) <= time ||
              JSON.stringify(fresh) !== JSON.stringify(captured.actor)
            )
              throw new Error("Administrative session changed");
            authentication = false;
            const context = await loadReceivingNominationContext(
              scope.siteId,
              request,
            );
            if (!guard.isCurrent() || revision !== activeRevision) return false;
            install(context);
            return guard.isCurrent();
          } catch (cause) {
            if (revision === activeRevision) fail(cause, authentication);
            return false;
          }
        })
        .finally(() => {
          if (validating === work) validating = null;
        });
      validating = work;
      return work;
    },
    subscribeInvalidation(listener) {
      invalidationListeners.add(listener);
      if (!guard.isCurrent()) listener();
      return () => {
        invalidationListeners.delete(listener);
      };
    },
  };
  const unsubscribe = owner.subscribe(() => {
    if (!frameCurrent()) invalidate();
  });
  if (!frameCurrent()) {
    invalidated = true;
    state = { status: "denied", context: null, uncertain: false };
  }
  return {
    guard,
    getState: () => structuredClone(state),
    refresh,
    observeNominationState(next: ReceivingNominationState) {
      if (!current()) return;
      if (next.uncertain && !state.uncertain)
        publish({ ...state, uncertain: true });
      if (next.status !== "pending") return;
      const response = receivingNominationResponseSchema.safeParse({
        nomination: next.nomination,
      });
      if (
        !response.success ||
        !retained ||
        response.data.nomination.siteId !== retained.siteId ||
        response.data.nomination.requestId !== retained.requestId ||
        response.data.nomination.mode !== retained.mode
      ) {
        fail(new Error("Receiving nomination changed"));
        return;
      }
      knownPending = true;
      void refresh();
    },
    dispose() {
      if (disposed) return;
      discard();
      disposed = true;
      revision++;
      unsubscribe();
      invalidationListeners.clear();
      loading = null;
      validating = null;
      retained = null;
      state = { status: "idle", context: null, uncertain: false };
    },
  };
}
export function mountReceivingSetupController(
  holder: { current: ReturnType<typeof createReceivingSetupController> | null },
  scope: ReceivingSetupScope,
  onState: (state: ReceivingSetupState) => void,
  ports?: ReceivingSetupPorts,
) {
  holder.current?.dispose();
  const controller = createReceivingSetupController(scope, onState, ports);
  holder.current = controller;
  onState(controller.getState());
  void controller.refresh();
  return () => {
    controller.dispose();
    if (holder.current === controller) holder.current = null;
  };
}
export function ReceivingSetup(
  props: ReceivingSetupScope & { ports?: ReceivingSetupPorts },
) {
  const key = financialReauthenticationScopeKey({
    ...props,
    action: "CONFIGURE_RECEIVING",
  });
  return key ? (
    <ReceivingSetupRuntime key={key} {...props} />
  ) : (
    <ReceivingSetupView
      scope={props}
      state={{ status: "denied", context: null, uncertain: false }}
      ready={false}
    />
  );
}
function ReceivingSetupRuntime(
  props: ReceivingSetupScope & { ports?: ReceivingSetupPorts },
) {
  const scope = useRef(props).current;
  const [state, setState] = useState<ReceivingSetupState>({
    status: "idle",
    context: null,
    uncertain: false,
  });
  const [ready, setReady] = useState(false);
  const holder = useRef<ReturnType<
    typeof createReceivingSetupController
  > | null>(null);
  useLayoutEffect(() => {
    const cleanup = mountReceivingSetupController(
      holder,
      scope,
      setState,
      scope.ports,
    );
    setReady(true);
    return cleanup;
  }, [scope]);
  return (
    <ReceivingSetupView
      scope={scope}
      state={state}
      ready={ready}
      guard={holder.current?.guard}
      ports={scope.ports}
      onRetry={() => {
        void holder.current?.refresh();
      }}
      onNominationState={(next) => holder.current?.observeNominationState(next)}
    />
  );
}
export function ReceivingSetupView({
  scope,
  state,
  ready,
  guard,
  ports,
  onRetry,
  onNominationState,
}: {
  scope: ReceivingSetupScope;
  state: ReceivingSetupState;
  ready: boolean;
  guard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  onRetry?: () => void;
  onNominationState?: (next: ReceivingNominationState) => void;
}) {
  const result =
    state.status === "ready"
      ? receivingNominationContextSchema.safeParse(state.context)
      : null;
  const context =
    result?.success &&
    result.data.siteId === scope.siteId &&
    financialReauthenticationScopeKey({
      ...scope,
      action: "CONFIGURE_RECEIVING",
    })
      ? result.data
      : null;
  if (context?.state === "AVAILABLE" && ready && guard?.isCurrent())
    return (
      <div className="grid gap-4">
        <ReceivingNominationForm
          {...scope}
          requestId={context.requestId}
          policyVersion={context.policyVersion}
          guard={guard}
          request={ports?.request}
          now={ports?.now}
          initialUncertainty={state.uncertain}
          onStateChange={onNominationState}
        />
        {state.uncertain && (
          <Button disabled={!onRetry} onClick={onRetry}>
            Verificar situação
          </Button>
        )}
      </div>
    );
  return (
    <section
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
      aria-label="Configuração de recebimento"
    >
      <h2 className="m-0 font-admin-display text-2xl text-admin-graphite">
        Indicação de recebedor
      </h2>
      {context?.state === "PENDING" ? (
        <>
          <p role="status">
            Indicação registrada. Verificação do provedor pendente. Ainda não
            confirma a liberação para receber valores.
          </p>
          <p>Política da indicação: {context.policyVersion}.</p>
          {!context.postAllowed && (
            <p role="alert">
              A política atual mudou. Esta indicação permanece registrada; uma
              nova confirmação está bloqueada.
            </p>
          )}
          {showSandboxNotice(context.mode) && <p>Ambiente de teste.</p>}
        </>
      ) : (
        <p role={state.status === "loading" ? "status" : "alert"}>
          {state.status === "loading"
            ? "Verificando a indicação…"
            : state.status === "denied"
              ? "Indicação restrita ao administrador autorizado deste casamento."
              : "Não foi possível verificar o contexto da indicação."}
        </p>
      )}
      {state.uncertain && (
        <p role="alert">
          O resultado anterior permanece incerto. A mesma indicação será
          verificada antes de qualquer confirmação.
        </p>
      )}
      {state.status !== "denied" && (
        <Button
          disabled={!ready || !onRetry || state.status === "loading"}
          onClick={onRetry}
        >
          Verificar situação
        </Button>
      )}
    </section>
  );
}
