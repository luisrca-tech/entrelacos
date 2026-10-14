import { receivingNominationResponseSchema } from "@entrelacos/contracts";
import { Button, Checkbox } from "@entrelacos/ui";
import {
  type FormEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  FinancialReauthenticationForm,
  type FinancialReauthenticationHandle,
} from "./FinancialReauthenticationForm";
import type { FinancialReauthenticationGuard } from "./financialReauthenticationClient";
import {
  createReceivingNominationController,
  type ReceivingNominationScope,
  type ReceivingNominationState,
  receivingNominationScopeKey,
} from "./receivingNominationClient";

type Props = ReceivingNominationScope & {
  guard?: FinancialReauthenticationGuard;
  request?: (
    path: string,
    options: { method: string; body: unknown },
  ) => Promise<unknown>;
  now?: () => number;
  initialUncertainty?: boolean;
  onStateChange?: (state: ReceivingNominationState) => void;
};

export function mountReceivingNominationController(
  holder: {
    current: ReturnType<typeof createReceivingNominationController> | null;
  },
  scope: ReceivingNominationScope,
  onState: (state: ReceivingNominationState) => void,
  options?: Parameters<typeof createReceivingNominationController>[2],
) {
  holder.current?.dispose();
  const controller = createReceivingNominationController(
    scope,
    onState,
    options,
  );
  holder.current = controller;
  return () => {
    controller.dispose();
    if (holder.current === controller) holder.current = null;
  };
}

// The guarded setup caller retains the server request and policy across retries.
export function ReceivingNominationForm(props: Props) {
  const key = receivingNominationScopeKey(props);
  return key && props.guard?.isCurrent() ? (
    <ReceivingNominationRuntime key={key} {...props} />
  ) : (
    <ReceivingNominationView
      scope={props}
      state={{ status: "denied", uncertain: false }}
      ready={false}
      confirmed={false}
    />
  );
}
function ReceivingNominationRuntime(props: Props) {
  const scope = useRef(props).current;
  const [state, setState] = useState<ReceivingNominationState>({
    status: "idle",
    uncertain: props.initialUncertainty ?? false,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [ready, setReady] = useState(false);
  const controller = useRef<ReturnType<
    typeof createReceivingNominationController
  > | null>(null);
  const authentication = useRef<FinancialReauthenticationHandle | null>(null);
  useLayoutEffect(() => {
    const cleanup = mountReceivingNominationController(
      controller,
      scope,
      (next) => {
        setState(next);
        scope.onStateChange?.(next);
      },
      {
        guard: props.guard,
        request: props.request,
        initialUncertainty: scope.initialUncertainty,
      },
    );
    setState({ status: "idle", uncertain: scope.initialUncertainty ?? false });
    setConfirmed(false);
    setReady(true);
    return cleanup;
  }, [scope, props.guard, props.request]);
  return (
    <div className="grid gap-6">
      <ReceivingNominationView
        scope={scope}
        state={state}
        ready={ready}
        confirmed={confirmed}
        onConfirmChange={setConfirmed}
        onSubmit={(event) => {
          event.preventDefault();
          setConfirmed(false);
          void controller.current?.submit(confirmed, {
            scope: { ...scope, action: "CONFIGURE_RECEIVING" },
            consumeProof: () => authentication.current?.consumeProof() ?? null,
          });
        }}
      />
      {!["pending", "denied", "session_expired"].includes(state.status) && (
        <FinancialReauthenticationForm
          siteId={scope.siteId}
          access={scope.access}
          sessionEpoch={scope.sessionEpoch}
          action="CONFIGURE_RECEIVING"
          guard={props.guard}
          request={props.request}
          now={props.now}
          ref={authentication}
        />
      )}
    </div>
  );
}
const messages: Record<
  Exclude<ReceivingNominationState["status"], "idle" | "pending">,
  string
> = {
  loading: "Registrando sua indicação…",
  unknown:
    "Não foi possível verificar o resultado. Confirme sua senha e verifique esta mesma indicação.",
  unavailable:
    "Indicação indisponível no momento. Aguarde antes de verificar novamente.",
  denied: "Indicação restrita ao administrador autorizado deste casamento.",
  session_expired:
    "Sua sessão expirou. Entre novamente antes de verificar a indicação.",
  reauthentication_required:
    "Confirme sua senha novamente antes de verificar a indicação.",
};
export function ReceivingNominationView({
  scope,
  state,
  ready,
  confirmed,
  onConfirmChange,
  onSubmit,
}: {
  scope: ReceivingNominationScope;
  state: ReceivingNominationState;
  ready: boolean;
  confirmed: boolean;
  onConfirmChange?: (confirmed: boolean) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const id = useId();
  const pending =
    state.status === "pending"
      ? receivingNominationResponseSchema.safeParse({
          nomination: state.nomination,
        })
      : null;
  const current = !receivingNominationScopeKey(scope)
    ? { status: "denied" as const, uncertain: false }
    : state.status === "pending" &&
        (!pending?.success ||
          pending.data.nomination.siteId !== scope.siteId ||
          pending.data.nomination.requestId !== scope.requestId)
      ? { status: "unknown" as const, uncertain: true }
      : state;
  const restricted = ["pending", "denied", "session_expired"].includes(
    current.status,
  );
  const disabled =
    !ready || !onSubmit || !confirmed || current.status === "loading";
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      <h2
        id={`${id}-title`}
        className="m-0 font-admin-display text-2xl text-admin-graphite"
      >
        Indicação de recebedor
      </h2>
      <p className="m-0 text-admin-muted">
        Indique a si mesmo como recebedor deste casamento. A verificação do
        provedor ainda será necessária.
      </p>
      {current.status !== "idle" && (
        <p
          role={
            ["denied", "session_expired", "unknown"].includes(current.status)
              ? "alert"
              : "status"
          }
          className="m-0 text-admin-muted"
        >
          {current.status === "pending" ? (
            <>
              Indicação registrada. Verificação do provedor pendente. Ainda não
              confirma a liberação para receber valores.
              {pending?.success &&
                pending.data.nomination.mode === "sandbox" &&
                " Ambiente de teste."}
            </>
          ) : (
            messages[current.status]
          )}
        </p>
      )}
      {current.uncertain && current.status !== "unknown" && (
        <p role="alert" className="m-0 text-admin-muted">
          Não foi possível verificar o resultado anterior. A mesma indicação
          será verificada após nova confirmação de senha.
        </p>
      )}
      {!restricted && (
        <form
          method="post"
          action={`/api/v1/sites/${encodeURIComponent(scope.siteId)}/receiving/nomination`}
          onSubmit={onSubmit}
          className="grid gap-4"
        >
          <div className="flex items-start gap-3">
            <Checkbox
              id={`${id}-confirm`}
              checked={confirmed}
              disabled={
                !ready || !onConfirmChange || current.status === "loading"
              }
              onCheckedChange={(value) => onConfirmChange?.(value === true)}
            />
            <label
              htmlFor={`${id}-confirm`}
              className="text-sm text-admin-graphite"
            >
              Confirmo que estou me indicando como recebedor deste casamento.
            </label>
          </div>
          <Button type="submit" disabled={disabled}>
            {current.uncertain
              ? "Verificar esta indicação"
              : "Confirmar minha indicação"}
          </Button>
        </form>
      )}
    </section>
  );
}
