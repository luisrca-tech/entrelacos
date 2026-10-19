import { financialReauthenticationResponseSchema } from "@entrelacos/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  PasswordInput,
  toast,
} from "@entrelacos/ui";
import {
  type FormEvent,
  type Ref,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createFinancialReauthenticationController,
  type FinancialReauthenticationGuard,
  type FinancialReauthenticationScope,
  type FinancialReauthenticationState,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";

export type FinancialReauthenticationHandle = { consumeProof(): string | null };
type Props = FinancialReauthenticationScope & {
  dialog?: boolean;
  feedback?: "toast";
  ref?: Ref<FinancialReauthenticationHandle>;
  guard?: FinancialReauthenticationGuard;
  request?: (
    path: string,
    options: { method: string; body: unknown },
  ) => Promise<unknown>;
  now?: () => number;
};

export function mountFinancialReauthenticationController(
  holder: {
    current: ReturnType<
      typeof createFinancialReauthenticationController
    > | null;
  },
  scope: FinancialReauthenticationScope,
  onState: (state: FinancialReauthenticationState) => void,
  options?: Parameters<typeof createFinancialReauthenticationController>[2],
): () => void {
  holder.current?.dispose();
  const controller = createFinancialReauthenticationController(
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

// A mounted caller must provide the reviewed server-context validation guard.
export function FinancialReauthenticationForm(props: Props) {
  const key = financialReauthenticationScopeKey(props);
  return key && props.guard?.isCurrent() ? (
    <FinancialReauthenticationRuntime key={key} {...props} />
  ) : (
    <FinancialReauthenticationView
      scope={props}
      state={{ status: "denied" }}
      ready={false}
      feedback={props.feedback}
    />
  );
}

function FinancialReauthenticationRuntime(props: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<FinancialReauthenticationState>({
    status: "idle",
  });
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const scope = useRef(props).current;
  const controller = useRef<ReturnType<
    typeof createFinancialReauthenticationController
  > | null>(null);
  const updateState = useCallback((next: FinancialReauthenticationState) => {
    if (input.current) input.current.value = "";
    setState(next);
  }, []);
  const passwordRef = useCallback((node: HTMLInputElement | null) => {
    if (input.current && input.current !== node) input.current.value = "";
    input.current = node;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Cancel recreates the disposed controller while keeping its modal owner mounted.
  useLayoutEffect(() => {
    const dispose = mountFinancialReauthenticationController(
      controller,
      scope,
      updateState,
      { guard: props.guard, request: props.request, now: props.now },
    );
    setState({ status: "idle" });
    setReady(true);
    return () => {
      if (input.current) input.current.value = "";
      dispose();
    };
  }, [scope, updateState, props.guard, props.request, props.now, generation]);
  useImperativeHandle(
    props.ref,
    () => ({ consumeProof: () => controller.current?.consumeProof() ?? null }),
    [],
  );
  function changeOpen(next: boolean) {
    if (!next) {
      if (input.current) input.current.value = "";
      controller.current?.dispose();
      controller.current = null;
      setReady(false);
      setState({ status: "idle" });
      setGeneration((value) => value + 1);
    }
    setOpen(next);
  }
  const view = (
    <FinancialReauthenticationView
      scope={props}
      state={state}
      ready={ready}
      feedback={props.feedback}
      dialog={props.dialog}
      now={props.now?.()}
      passwordRef={passwordRef}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const active = controller.current;
        if (!active || active.getState().status === "loading") return;
        void submitFinancialPassword(active, input.current).then(() => {
          if (
            props.feedback !== "toast" ||
            controller.current !== active ||
            !props.guard?.isCurrent()
          )
            return;
          const result = active.getState();
          if (controller.current !== active || !props.guard?.isCurrent())
            return;
          if (result.status === "verified") {
            if (props.dialog) setOpen(false);
            toast.success(
              props.action === "REQUEST_WITHDRAWAL"
                ? "Senha confirmada. Agora confirme os termos do saque."
                : "Senha confirmada. Agora confirme o destino Pix.",
            );
          } else if (result.status !== "idle" && result.status !== "loading")
            toast.error(messages[result.status]);
        });
      }}
    />
  );
  if (!props.dialog) return view;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" disabled={!ready} />}
      >
        Confirmar senha
      </DialogTrigger>
      <DialogContent>
        {view}
        <Button
          type="button"
          variant="outline"
          onClick={() => changeOpen(false)}
        >
          Cancelar
        </Button>
      </DialogContent>
    </Dialog>
  );
}

const expiryFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});
const messages: Record<
  Exclude<FinancialReauthenticationState["status"], "verified" | "idle">,
  string
> = {
  loading: "Confirmando sua senha…",
  denied:
    "Acesso financeiro restrito. Esta confirmação exige o administrador autorizado deste casamento.",
  unavailable:
    "Confirmação de senha indisponível. Nenhuma confirmação foi concluída.",
  error:
    "Não foi possível confirmar a senha. Confira os dados e tente novamente.",
  expired:
    "Esta confirmação não está mais válida. Confirme sua senha novamente.",
  consumed:
    "Confirmação utilizada. Uma nova confirmação exige sua senha novamente.",
  session_expired:
    "Sua sessão expirou. Entre novamente para confirmar sua senha.",
  rate_limited: "Muitas tentativas. Aguarde antes de confirmar novamente.",
};
export function FinancialReauthenticationView({
  scope,
  state,
  ready,
  now = Date.now(),
  onSubmit,
  passwordRef,
  feedback,
  dialog,
}: {
  scope: FinancialReauthenticationScope;
  state: FinancialReauthenticationState;
  ready: boolean;
  now?: number;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  passwordRef?: Ref<HTMLInputElement>;
  feedback?: "toast";
  dialog?: boolean;
}) {
  const id = useId();
  const allowed = financialReauthenticationScopeKey(scope) !== null;
  const expiry =
    state.status === "verified"
      ? financialReauthenticationResponseSchema.shape.expiresAt.safeParse(
          state.expiresAt,
        )
      : null;
  const current = !allowed
    ? { status: "denied" as const }
    : state.status === "verified" &&
        (!expiry?.success ||
          !Number.isSafeInteger(now) ||
          Date.parse(expiry.data) <= now)
      ? { status: "expired" as const }
      : state;
  const restricted =
    current.status === "denied" || current.status === "session_expired";
  const disabled = !ready || !onSubmit || current.status === "loading";
  return (
    <section
      aria-labelledby={dialog ? undefined : `${id}-title`}
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      {dialog ? (
        <DialogTitle>Confirme sua senha</DialogTitle>
      ) : (
        <h2
          id={`${id}-title`}
          className="m-0 font-admin-display text-2xl text-admin-graphite"
        >
          Confirme sua senha
        </h2>
      )}
      {!restricted && (
        <>
          {feedback !== "toast" && (
            <p className="m-0 text-admin-muted">
              {scope.action === "CONFIGURE_RECEIVING"
                ? "Confirmação para configurar o recebimento."
                : "Confirmação para solicitar um saque."}
            </p>
          )}
          {dialog ? (
            <DialogDescription>
              <span id={`${id}-hint`}>
                {scope.action === "CONFIGURE_RECEIVING"
                  ? "Confirme sua senha para salvar o destino Pix."
                  : "Confirme sua senha para continuar com o saque."}{" "}
                Esta etapa não envia dinheiro.
              </span>
            </DialogDescription>
          ) : (
            <p id={`${id}-hint`} className="m-0 text-sm text-admin-muted">
              {feedback === "toast"
                ? "Confirme sua senha para continuar."
                : "Esta confirmação não altera o responsável financeiro nem movimenta valores."}
            </p>
          )}
        </>
      )}
      {feedback !== "toast" && current.status !== "idle" && (
        <p
          id={`${id}-status`}
          role={
            ["error", "denied", "session_expired", "rate_limited"].includes(
              current.status,
            )
              ? "alert"
              : "status"
          }
          className="m-0 text-admin-muted"
        >
          {current.status === "verified" ? (
            <>
              Senha confirmada para esta finalidade. Confirmação válida até{" "}
              <time dateTime={current.expiresAt}>
                {expiryFormatter.format(new Date(current.expiresAt))}
              </time>
              .
            </>
          ) : (
            messages[current.status]
          )}
        </p>
      )}
      {!restricted && (
        <form
          method="post"
          action={`/api/v1/sites/${encodeURIComponent(scope.siteId)}/financial-reauthentication`}
          onSubmit={onSubmit}
          className="grid gap-4"
        >
          <div className="grid gap-2">
            <label
              htmlFor={`${id}-password`}
              className="text-sm font-semibold text-admin-graphite"
            >
              Senha atual
            </label>
            <PasswordInput
              ref={passwordRef}
              id={`${id}-password`}
              name="password"
              autoComplete="current-password"
              maxLength={200}
              required
              disabled={disabled}
              aria-describedby={`${id}-hint`}
            />
          </div>
          <Button type="submit" disabled={disabled} className="w-fit">
            {current.status === "loading" ? "Confirmando…" : "Confirmar senha"}
          </Button>
        </form>
      )}
    </section>
  );
}

export function submitFinancialPassword(
  controller: { submit(password: string): Promise<void> },
  input: Pick<HTMLInputElement, "value"> | null,
): Promise<void> {
  const password = input?.value ?? "";
  if (input) input.value = "";
  return controller.submit(password);
}
