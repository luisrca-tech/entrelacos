import {
  type ReceivingPixDestinationInput,
  type ReceivingPixDestinationReview,
  type ReceivingPixDestinationSaved,
  receivingPixDestinationInputSchema,
  receivingPixDestinationReviewSchema,
  receivingPixDestinationSavedResponseSchema,
  receivingPixDestinationSavedSchema,
} from "@entrelacos/contracts";
import { Button, Input, showSandboxNotice } from "@entrelacos/ui";
import {
  type FormEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  FinancialReauthenticationForm,
  type FinancialReauthenticationHandle,
} from "./FinancialReauthenticationForm";
import type { FinancialReauthenticationGuard } from "./financialReauthenticationClient";
import { panelActorOwner } from "./panelActor";
import type {
  ReceivingSetupPorts,
  ReceivingSetupScope,
} from "./ReceivingSetup";

export type ReceivingPixDestinationState = {
  status:
    | "idle"
    | "loading"
    | "ready"
    | "invalid"
    | "denied"
    | "unavailable"
    | "limited"
    | "unsupported"
    | "saving"
    | "unknown"
    | "authentication_required"
    | "expired";
  review: ReceivingPixDestinationReview | null;
  saved: ReceivingPixDestinationSaved | null;
};
export function createReceivingPixDestinationController(
  siteId: string,
  mode: "sandbox" | "live",
  parentGuard: FinancialReauthenticationGuard,
  publish: (state: ReceivingPixDestinationState) => void,
  ports: ReceivingSetupPorts = {},
  readOnly = false,
) {
  const owner = ports.owner ?? panelActorOwner,
    request = ports.request ?? apiRequest,
    now = ports.now ?? Date.now;
  const captured = owner.getSnapshot?.();
  let disposed = false,
    revision = 0,
    timer: ReturnType<typeof setTimeout> | null = null;
  let state: ReceivingPixDestinationState = {
    status: "idle",
    review: null,
    saved: null,
  };
  const listeners = new Set<() => void>();
  const current = () =>
    !disposed &&
    parentGuard.isCurrent() &&
    !owner.isSuspended?.() &&
    (!captured || owner.getSnapshot?.() === captured);
  const update = (next: ReceivingPixDestinationState) => {
    state = next;
    if (!disposed) publish(structuredClone(state));
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const busy = () => ["loading", "saving"].includes(state.status);
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const validReview = () => {
    const at = now();
    return (
      !!state.review &&
      Number.isSafeInteger(at) &&
      at >= 0 &&
      Date.parse(state.review.expiresAt) > at
    );
  };
  const guard: FinancialReauthenticationGuard = {
    isCurrent: () =>
      !readOnly &&
      current() &&
      validReview() &&
      !busy() &&
      state.status !== "unknown",
    async validate() {
      if (!guard.isCurrent()) return false;
      const original = state.review;
      return (
        (await parentGuard.validate()) &&
        guard.isCurrent() &&
        state.review === original
      );
    },
    subscribeInvalidation(listener) {
      listeners.add(listener);
      if (!guard.isCurrent()) listener();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const unsubscribe = parentGuard.subscribeInvalidation(() => {
    if (!parentGuard.isCurrent()) {
      revision++;
      clearTimer();
      update({ status: "denied", review: null, saved: null });
      notify();
    }
  });
  const resume = owner.subscribeSuspension?.(() => {
    if (owner.isSuspended?.()) {
      revision++;
      if (state.status === "saving") {
        clearTimer();
        update({ ...state, status: "unknown", review: null });
      } else if (busy()) update({ ...state, status: "idle", review: null });
      notify();
    }
    if (!owner.isSuspended?.() && state.review && !validReview()) {
      clearTimer();
      update({ ...state, status: "expired", review: null });
      notify();
    } else update({ ...state });
  });
  const report = (cause: unknown) => {
    if (!(cause instanceof ApiError && cause.code === "RECENT_AUTH_REQUIRED"))
      owner.reportFailure(cause, captured?.sessionEpoch ?? null);
  };
  function scopedSaved(raw: unknown): ReceivingPixDestinationSaved {
    const value = receivingPixDestinationSavedSchema.parse(raw);
    if (value.siteId !== siteId || value.mode !== mode)
      throw new Error("Pix destination scope mismatch");
    return value;
  }
  return {
    guard,
    getState: () => structuredClone(state),
    isCurrent: current,
    resetReview() {
      if (busy() || state.status === "unknown") return;
      revision++;
      clearTimer();
      update({ ...state, status: "idle", review: null });
      notify();
    },
    async load() {
      if (!current() || busy()) return;
      const active = ++revision;
      clearTimer();
      update({ ...state, status: "loading", review: null });
      notify();
      try {
        if (
          !(await parentGuard.validate()) ||
          !current() ||
          revision !== active
        )
          return;
        const response = receivingPixDestinationSavedResponseSchema.parse(
          await request(
            `/v1/sites/${encodeURIComponent(siteId)}/receiving/pix-destination`,
          ),
        );
        if (
          !current() ||
          revision !== active ||
          !(await parentGuard.validate()) ||
          !current() ||
          revision !== active
        )
          return;
        const saved =
          response.destination === null
            ? null
            : scopedSaved(response.destination);
        update({ status: "ready", review: null, saved });
      } catch (cause) {
        if (current() && revision === active) {
          report(cause);
          if (current())
            update({ status: "unavailable", review: null, saved: null });
        }
      } finally {
        if (!disposed && revision === active && busy())
          update({ ...state, status: "idle" });
      }
    },
    async lookup(rawInput: unknown) {
      if (readOnly || busy() || state.status === "unknown" || !current())
        return;
      const input = receivingPixDestinationInputSchema.safeParse(rawInput);
      if (!input.success) {
        update({ ...state, status: "invalid", review: null });
        notify();
        return;
      }
      const active = ++revision;
      clearTimer();
      update({ ...state, status: "loading", review: null });
      notify();
      try {
        if (
          !(await parentGuard.validate()) ||
          !current() ||
          revision !== active
        )
          return;
        const review = receivingPixDestinationReviewSchema.parse(
          await request(
            `/v1/sites/${encodeURIComponent(siteId)}/receiving/pix-destination/preview`,
            { method: "POST", body: input.data },
          ),
        );
        if (
          !current() ||
          revision !== active ||
          !(await parentGuard.validate()) ||
          !current() ||
          revision !== active
        )
          return;
        const remaining = Date.parse(review.expiresAt) - now();
        if (
          review.siteId !== siteId ||
          review.mode !== mode ||
          review.keyType !== input.data.type ||
          remaining <= 0 ||
          remaining > 300000
        )
          throw new Error("Pix review scope mismatch");
        update({ ...state, status: "ready", review });
        timer = setTimeout(() => {
          if (current() && revision === active) {
            update({ ...state, status: "expired", review: null });
            notify();
          }
        }, remaining);
      } catch (cause) {
        if (!current() || revision !== active) return;
        report(cause);
        if (!current()) return;
        update({
          ...state,
          status:
            cause instanceof ApiError &&
            cause.code === "PIX_LOOKUP_RATE_LIMITED"
              ? "limited"
              : cause instanceof ApiError &&
                  cause.code === "PIX_SANDBOX_KEY_UNSUPPORTED"
                ? "unsupported"
                : "unavailable",
          review: null,
        });
      } finally {
        if (!disposed && revision === active && busy())
          update({ ...state, status: "idle" });
      }
    },
    async confirm(
      confirmRecipient: boolean,
      acceptThirdParty: boolean,
      consumeProof: () => string | null,
    ) {
      const review = state.review;
      if (
        !confirmRecipient ||
        !review ||
        (review.identity !== "MATCH" && !acceptThirdParty) ||
        !(await guard.validate()) ||
        state.review !== review
      )
        return;
      const reauthenticationToken = consumeProof();
      if (!reauthenticationToken) {
        update({ ...state, status: "authentication_required" });
        return;
      }
      if (!guard.isCurrent() || state.review !== review) return;
      const active = ++revision;
      clearTimer();
      update({ ...state, status: "saving" });
      notify();
      try {
        const saved = scopedSaved(
          await request(
            `/v1/sites/${encodeURIComponent(siteId)}/receiving/pix-destination/confirm`,
            {
              method: "POST",
              body: {
                reviewToken: review.reviewToken,
                confirmRecipient: true,
                ...(acceptThirdParty ? { acceptThirdParty: true } : {}),
                reauthenticationToken,
              },
            },
          ),
        );
        if (
          !current() ||
          revision !== active ||
          !(await parentGuard.validate()) ||
          !current() ||
          revision !== active
        )
          return;
        for (const field of [
          "keyType",
          "maskedKey",
          "ownerName",
          "maskedCpfCnpj",
          "bankName",
          "identity",
        ] as const)
          if (saved[field] !== review[field])
            throw new Error("Saved Pix destination differs from review");
        update({ status: "ready", review: null, saved });
        notify();
      } catch (cause) {
        if (!current() || revision !== active) return;
        report(cause);
        if (!current()) return;
        if (cause instanceof ApiError && cause.code === "RECENT_AUTH_REQUIRED")
          update({ ...state, status: "authentication_required" });
        else if (
          cause instanceof ApiError &&
          [400, 403, 409].includes(cause.status)
        )
          update({ ...state, status: "expired", review: null });
        else update({ ...state, status: "unknown", review: null });
        notify();
      } finally {
        if (!disposed && revision === active && busy())
          update({ ...state, status: "unknown", review: null });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      clearTimer();
      unsubscribe();
      resume?.();
      listeners.clear();
      state = { status: "denied", review: null, saved: null };
    },
  };
}
export function ReceivingPixDestination(props: {
  siteId: string;
  mode: "sandbox" | "live";
  guard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  scope?: ReceivingSetupScope;
  readOnly?: boolean;
}) {
  const [state, setState] = useState<ReceivingPixDestinationState>({
    status: "idle",
    review: null,
    saved: null,
  });
  const controller = useRef<ReturnType<
    typeof createReceivingPixDestinationController
  > | null>(null);
  const authentication = useRef<FinancialReauthenticationHandle | null>(null);
  useLayoutEffect(() => {
    if (!props.guard) return;
    const instance = createReceivingPixDestinationController(
      props.siteId,
      props.mode,
      props.guard,
      setState,
      props.ports,
      props.readOnly,
    );
    controller.current = instance;
    setState(instance.getState());
    void instance.load();
    return () => {
      instance.dispose();
      controller.current = null;
    };
  }, [props.siteId, props.mode, props.guard, props.ports, props.readOnly]);
  return (
    <ReceivingPixDestinationView
      mode={props.mode}
      state={state}
      enabled={!!controller.current?.isCurrent()}
      readOnly={props.readOnly}
      onLookup={(input) => {
        void controller.current?.lookup(input);
      }}
      onReset={() => controller.current?.resetReview()}
      onRefresh={() => {
        void controller.current?.load();
      }}
      onConfirm={(confirmed, thirdParty) => {
        void controller.current?.confirm(
          confirmed,
          thirdParty,
          () => authentication.current?.consumeProof() ?? null,
        );
      }}
    >
      {props.scope && state.review && controller.current?.guard.isCurrent() && (
        <FinancialReauthenticationForm
          key={state.review.reviewToken}
          ref={authentication}
          {...props.scope}
          action="CONFIGURE_RECEIVING"
          guard={controller.current.guard}
          request={props.ports?.request}
          now={props.ports?.now}
        />
      )}
    </ReceivingPixDestinationView>
  );
}
export function ReceivingPixDestinationView({
  mode,
  state,
  enabled,
  readOnly = false,
  onLookup,
  onReset,
  onRefresh,
  onConfirm,
  children,
}: {
  mode: "sandbox" | "live";
  state: ReceivingPixDestinationState;
  enabled: boolean;
  readOnly?: boolean;
  onLookup?: (input: ReceivingPixDestinationInput) => void;
  onReset?: () => void;
  onRefresh?: () => void;
  onConfirm?: (confirmRecipient: boolean, acceptThirdParty: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [type, setType] = useState<ReceivingPixDestinationInput["type"]>(
      mode === "sandbox" ? "PHONE" : "CPF",
    ),
    [key, setKey] = useState("");
  const busy = ["loading", "saving"].includes(state.status),
    locked = !enabled || busy || state.status === "unknown";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!locked) onLookup?.({ type, key });
  }
  return (
    <section
      aria-label="Destino Pix para saques"
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6"
    >
      <h3 className="font-admin-display text-xl">Destino Pix para saques</h3>
      <p>
        O destino pode pertencer a outra pessoa. Confira o nome completo, o
        documento e o banco retornados pelo Asaas antes de confirmar. Salvar o
        destino não envia dinheiro.
      </p>
      {showSandboxNotice(mode) && !readOnly && (
        <p>
          No Sandbox, use um exemplo de teste: tipo Celular, chave 47996515839,
          ou tipo E-mail, chave cliente-a00001@pix.bcb.gov.br. Os dados
          retornados pertencem ao ambiente de testes.
        </p>
      )}
      {state.saved && (
        <>
          <h4>Destino Pix salvo</h4>
          <PixRecipientDetails recipient={state.saved} />
          <p role="status">
            Configuração salva. Em Financeiro, o titular pode revisar os valores
            e o destinatário antes de confirmar cada saque.
          </p>
        </>
      )}
      {readOnly && !state.saved && state.status === "ready" && (
        <p>Nenhum destino Pix foi configurado.</p>
      )}
      {!readOnly && (
        <form className="grid gap-3" onSubmit={submit} autoComplete="off">
          <label htmlFor={`${id}-type`}>Tipo de chave Pix</label>
          <select
            id={`${id}-type`}
            value={type}
            disabled={locked}
            onChange={(event) => {
              onReset?.();
              setType(
                event.target.value as ReceivingPixDestinationInput["type"],
              );
            }}
            className="rounded-lg border border-admin-line p-3"
          >
            {[
              ["CPF", "CPF"],
              ["CNPJ", "CNPJ"],
              ["EMAIL", "E-mail"],
              ["PHONE", "Celular (DDD e número)"],
              ["EVP", "Chave aleatória"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-key`}>Chave Pix do destinatário</label>
          <Input
            id={`${id}-key`}
            type="text"
            value={key}
            required
            maxLength={254}
            disabled={locked}
            onChange={(event) => {
              onReset?.();
              setKey(event.target.value);
            }}
          />
          <Button type="submit" disabled={locked}>
            {state.status === "loading"
              ? "Consultando destinatário…"
              : "Consultar destinatário Pix"}
          </Button>
        </form>
      )}
      {state.status === "invalid" && (
        <p role="alert">
          Confira a chave e o tipo selecionado. Use somente números para CPF,
          CNPJ ou celular com DDD.
        </p>
      )}
      {state.status === "limited" && (
        <p role="alert">
          Limite de consultas atingido. Aguarde um minuto antes de tentar
          novamente.
        </p>
      )}
      {state.status === "unsupported" && (
        <p role="alert">
          {showSandboxNotice(mode)
            ? "Esta chave não está disponível para consulta no Sandbox. Utilize o exemplo de teste indicado."
            : "Esta chave não está disponível para consulta. Confira o tipo e a chave Pix."}
        </p>
      )}
      {state.status === "unavailable" && (
        <p role="alert">
          Não foi possível consultar a configuração Pix. Verifique a situação
          antes de continuar.
        </p>
      )}
      {state.status === "authentication_required" && (
        <p role="alert">Confirme sua senha para salvar este destino Pix.</p>
      )}
      {state.status === "expired" && (
        <p role="alert">
          A consulta expirou ou a configuração mudou. Consulte a chave novamente
          antes de salvar.
        </p>
      )}
      {state.status === "unknown" && (
        <p role="alert">
          Não foi possível confirmar se o destino foi salvo. Consulte o destino
          salvo antes de fazer outra alteração.
        </p>
      )}
      {state.review && (
        <>
          <PixRecipientDetails recipient={state.review} />
          <p role="status">
            {state.review.identity === "MISMATCH"
              ? "O destinatário informado pelo Asaas é diferente do titular do recebimento. Você pode prosseguir com esse destinatário mediante confirmação explícita."
              : state.review.identity === "INCOMPLETE"
                ? "O Asaas retornou um documento incompleto. Você pode confirmar esse destinatário, mas a consulta não comprova que seja a mesma pessoa que o titular do recebimento."
                : "Os dados completos retornados pelo Asaas correspondem ao titular do recebimento."}
          </p>
          <p>
            Confira os dados abaixo e confirme para salvar este destino Pix.
          </p>
          {onConfirm && !readOnly && (
            <PixRecipientConfirmation
              key={state.review.reviewToken}
              review={state.review}
              enabled={!locked}
              onConfirm={onConfirm}
            >
              {children}
            </PixRecipientConfirmation>
          )}
        </>
      )}
      {onRefresh && (
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || busy}
          onClick={onRefresh}
        >
          Consultar destino salvo
        </Button>
      )}
    </section>
  );
}
function PixRecipientDetails({
  recipient,
}: {
  recipient: Pick<
    ReceivingPixDestinationReview,
    "ownerName" | "maskedCpfCnpj" | "bankName" | "maskedKey"
  >;
}) {
  return (
    <dl>
      {[
        ["Nome completo do destinatário", recipient.ownerName],
        ["CPF/CNPJ retornado pelo Asaas", recipient.maskedCpfCnpj],
        ["Banco do destinatário", recipient.bankName],
        ["Chave consultada", recipient.maskedKey],
      ].map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function PixRecipientConfirmation({
  review,
  enabled,
  onConfirm,
  children,
}: {
  review: ReceivingPixDestinationReview;
  enabled: boolean;
  onConfirm: (confirmed: boolean, thirdParty: boolean) => void;
  children?: ReactNode;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [thirdParty, setThirdParty] = useState(false);
  return (
    <div className="grid gap-3">
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!enabled}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        Conferi o nome completo, o banco, o documento e a chave consultada e
        quero configurar este destinatário.
      </label>
      {review.identity !== "MATCH" && (
        <label>
          <input
            type="checkbox"
            checked={thirdParty}
            disabled={!enabled}
            onChange={(event) => setThirdParty(event.target.checked)}
          />{" "}
          Estou ciente de que o destino pode pertencer a outra pessoa ou ter
          identificação incompleta e escolho prosseguir.
        </label>
      )}
      {children}
      <Button
        type="button"
        disabled={
          !enabled || !confirmed || (review.identity !== "MATCH" && !thirdParty)
        }
        onClick={() => onConfirm(confirmed, thirdParty)}
      >
        Salvar destino Pix
      </Button>
    </div>
  );
}
