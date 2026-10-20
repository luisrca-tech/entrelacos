import {
  meResponseSchema,
  type ReceivingReadiness,
  type ReceivingSetupContext,
  receivingReadinessResponseSchema,
  receivingSetupAccountSchema,
  receivingSetupResponseSchema,
  receivingSetupResultSchema,
} from "@entrelacos/contracts";
import { Button, Input, showSandboxNotice } from "@entrelacos/ui";
import {
  type FormEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { apiRequest } from "../lib/apiClient";
import {
  type FinancialReauthenticationGuard,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";
import { panelActorOwner } from "./panelActor";
import { ReceivingPixDestination } from "./ReceivingPixDestination";
import type {
  ReceivingSetupPorts,
  ReceivingSetupScope,
} from "./ReceivingSetup";

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
  async function refresh() {
    if (!current()) {
      invalidate();
      return;
    }
    const active = ++revision;
    update({ status: "loading", setup: null, message: null });
    notify();
    try {
      const setup = await load();
      if (current() && revision === active)
        update({ status: "ready", setup, message: null });
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
  const unsubscribe = owner.subscribe(() => {
    if (!current()) invalidate();
  });
  return {
    guard,
    pixGuard,
    incomingGuard,
    refresh,
    getState: () => structuredClone(state),
    async verifyIncoming(): Promise<ReceivingReadiness | undefined> {
      if (
        incomingInFlight ||
        !showSandboxNotice(state.setup?.mode) ||
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
          !showSandboxNotice(setup.mode) ||
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
            { method: "POST", body: { confirmIncomingAccount: true } },
          ),
        );
        if (!current() || active !== revision) return;
        if (readiness.siteId !== scope.siteId || readiness.mode !== setup.mode)
          throw new Error("Unexpected incoming receiving readiness");
        await refresh();
        if (!current() || state.status !== "ready") return;
        update({
          ...state,
          message:
            "Conta consultada no Asaas. Confira a situação atual dos recebimentos.",
        });
        return readiness;
      } catch (cause) {
        if (revision === active) fail(cause);
      } finally {
        incomingInFlight = false;
      }
    },
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
  useLayoutEffect(() => {
    const current = createReceivingAccountSetupController(
      { siteId, access, sessionEpoch },
      setState,
      ports,
    );
    controller.current = current;
    void current.refresh();
    return () => {
      form.current?.reset();
      current.dispose();
      controller.current = null;
    };
  }, [siteId, access, sessionEpoch, ports]);
  return (
    <ReceivingAccountSetupView
      scope={props}
      platformOwner={props.platformOwner}
      state={state}
      guard={controller.current?.guard}
      pixGuard={controller.current?.pixGuard}
      incomingGuard={controller.current?.incomingGuard}
      ports={ports}
      form={form}
      onRetry={() => {
        void controller.current?.refresh();
      }}
      onVerifyIncoming={() => {
        void controller.current?.verifyIncoming().then((readiness) => {
          if (readiness) props.onReadinessChange?.();
        });
      }}
      onDesignate={(id) => {
        void controller.current?.designate(id);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const account = Object.fromEntries(
          [
            "name",
            "email",
            "cpfCnpj",
            "mobilePhone",
            "incomeValue",
            "address",
            "addressNumber",
            "province",
            "postalCode",
            "birthDate",
          ].map((name) => [
            name,
            name === "incomeValue" ? Number(data.get(name)) : data.get(name),
          ]),
        );
        const confirmed = data.get("consent") === "on";
        event.currentTarget.reset();
        void controller.current?.submit(account, confirmed);
      }}
    />
  );
}
const fields = [
  ["name", "Nome completo do titular", "text"],
  ["email", "E-mail do titular", "email"],
  ["cpfCnpj", "CPF (somente números)", "text"],
  ["birthDate", "Data de nascimento", "date"],
  ["mobilePhone", "Celular com DDD (somente números)", "tel"],
  ["incomeValue", "Renda mensal (R$)", "number"],
  ["postalCode", "CEP (somente números)", "text"],
  ["address", "Logradouro", "text"],
  ["addressNumber", "Número", "text"],
  ["province", "Bairro", "text"],
] as const;
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
  form,
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
  form?: React.RefObject<HTMLFormElement | null>;
}) {
  const id = useId(),
    setup = state.setup;
  const busy = ["loading", "submitting"].includes(state.status);
  const owner = platformOwner || scope.access?.membershipRole === "OWNER";
  const canSubmit =
    !owner &&
    !!setup?.isHolder &&
    ["NOT_CREATED", "PENDING"].includes(setup.accountState) &&
    guard?.isCurrent();
  const rejected =
    setup?.providerStatus &&
    [
      setup.providerStatus.commercialInfo,
      setup.providerStatus.bankAccountInfo,
      setup.providerStatus.documentation,
      setup.providerStatus.general,
    ].includes("REJECTED");
  return (
    <section
      aria-label="Cadastro de recebimento Asaas"
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      <h2 className="m-0 font-admin-display text-2xl text-admin-graphite">
        Configurar recebimentos
      </h2>
      {showSandboxNotice(setup?.mode) && (
        <p>
          Sandbox Asaas: ambiente de teste, sem movimentação de dinheiro real.
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
      {state.status === "loading" && (
        <p role="status">Verificando o titular e o cadastro…</p>
      )}
      {state.status === "submitting" && (
        <p role="status">Atualizando a configuração de recebimento…</p>
      )}
      {state.status === "denied" && (
        <p role="alert">
          Sua sessão ou permissão mudou. Entre novamente para continuar.
        </p>
      )}
      {state.status === "unavailable" && (
        <p role="alert">
          Configuração indisponível. Verifique a conexão e tente novamente.
        </p>
      )}
      {setup && !setup.holder && (
        <>
          <p>
            O titular dos recebimentos ainda não foi designado. O responsável
            pela plataforma deve selecionar a conta do titular; a permissão de
            administrar o casamento não define quem recebe.
          </p>
          {owner && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get(
                  "holderUserId",
                );
                if (typeof value === "string") onDesignate?.(value);
              }}
              className="grid gap-3"
            >
              <label htmlFor={`${id}-holder`}>
                Conta do titular neste casamento
              </label>
              <select
                id={`${id}-holder`}
                name="holderUserId"
                required
                disabled={busy || !setup.holderCandidates?.length}
                className="rounded-lg border border-admin-line bg-admin-surface p-3"
              >
                <option value="">Selecione o titular</option>
                {setup.holderCandidates?.map((candidate) => (
                  <option key={candidate.userId} value={candidate.userId}>
                    {candidate.name} ({candidate.email})
                  </option>
                ))}
              </select>
              {!setup.holderCandidates?.length && (
                <p>
                  Adicione uma conta administradora para o titular antes de
                  designar o titular.
                </p>
              )}
              <p>
                A conta deve estar ativa e administrar este casamento. A
                designação será fixa; confirme a identidade antes de salvar.
              </p>
              <Button
                type="submit"
                disabled={
                  busy || !onDesignate || !setup.holderCandidates?.length
                }
              >
                Designar titular
              </Button>
            </form>
          )}
        </>
      )}
      {setup?.holder && (
        <p>
          Titular dos recebimentos: <strong>{setup.holder.name}</strong>.
        </p>
      )}
      {setup?.holder && !setup.isHolder && (
        <p>
          Somente o titular designado pode consentir e enviar o cadastro ao
          Asaas. Administrar o casamento não autoriza abrir uma conta em nome de
          outra pessoa.
        </p>
      )}
      {setup?.accountState === "UNKNOWN" && (
        <p role="alert">
          O resultado da criação está incerto. Verifique a conta existente antes
          de repetir qualquer criação.
        </p>
      )}
      {setup?.accountState === "CREATED" && (
        <>
          <p>
            Conta criada no Asaas. A criação não confirma liberação para receber
            ou sacar.
          </p>
          <section
            aria-label="Ativação e acesso ao Asaas"
            className="grid gap-2"
          >
            <h3 className="font-admin-display text-xl">
              Ativação e acesso ao Asaas
            </h3>
            <p>
              A ativação de acesso e o envio ou recebimento de e-mail não são
              consultados por este painel. O botão Verificar situação atualiza
              as verificações cadastrais do Asaas.
            </p>
            <p>
              Se o Asaas exigir ativação por e-mail, confira o e-mail informado
              no cadastro e siga as instruções recebidas. Em modalidades BaaS,
              conclua o onboarding fornecido pelo Asaas, quando exigido.
            </p>
            {showSandboxNotice(setup.mode) && (
              <p>
                No Sandbox, confira o e-mail da conta principal do Asaas: as
                comunicações de teste são redirecionadas para ele.
              </p>
            )}
          </section>
          {showSandboxNotice(setup.mode) && (
            <>
              <p>
                O titular deve consultar e confirmar a conta Asaas criada em seu
                nome para receber os presentes. A liberação depende das
                verificações do Asaas.
              </p>
              {!owner &&
                setup.isHolder &&
                setup.consentRecorded &&
                incomingGuard?.isCurrent() && (
                  <Button
                    disabled={busy || !onVerifyIncoming}
                    onClick={onVerifyIncoming}
                  >
                    Confirmar minha conta de recebimento
                  </Button>
                )}
            </>
          )}
          {!setup.providerStatus && (
            <p>
              Não foi possível consultar as verificações do Asaas. Verifique a
              situação novamente.
            </p>
          )}
          {setup.providerStatus && (
            <>
              <dl className="grid gap-2">
                {[
                  ["Dados cadastrais", setup.providerStatus.commercialInfo],
                  ["Dados bancários", setup.providerStatus.bankAccountInfo],
                  ["Documentação", setup.providerStatus.documentation],
                  ["Aprovação geral", setup.providerStatus.general],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {
                        {
                          PENDING: "Pendente",
                          AWAITING_APPROVAL: "Em análise",
                          APPROVED: "Aprovado",
                          REJECTED: "Rejeitado",
                        }[value]
                      }
                    </dd>
                  </div>
                ))}
              </dl>
              {rejected && (
                <p role="alert">
                  Há dados rejeitados pelo Asaas. O titular precisa corrigir as
                  pendências no fluxo de verificação do provedor.
                </p>
              )}
              {setup.providerStatus.commercialInfoExpired && (
                <p role="alert">
                  Os dados comerciais estão expirados. Atualize ou confirme os
                  dados com o Asaas.
                </p>
              )}
              <p>
                As aprovações cadastrais não substituem a validação do destino
                bancário e da habilitação para este serviço.
              </p>
            </>
          )}
        </>
      )}
      {setup &&
        (owner || setup.isHolder) &&
        setup.accountState === "CREATED" &&
        state.status === "ready" && (
          <ReceivingPixDestination
            siteId={scope.siteId}
            mode={setup.mode}
            guard={pixGuard}
            ports={ports}
            scope={scope}
            readOnly={owner}
          />
        )}
      {canSubmit && (
        <>
          <p>{setup.disclosure.text}</p>
          <p>
            Preencha os dados do titular e confirme o consentimento antes de
            enviar.
          </p>
          <form
            ref={form}
            onSubmit={onSubmit}
            className="grid gap-4 sm:grid-cols-2"
            autoComplete="off"
          >
            {fields.map(([name, label, type]) => (
              <div key={name} className="grid gap-1">
                <label htmlFor={`${id}-${name}`}>{label}</label>
                <Input
                  id={`${id}-${name}`}
                  name={name}
                  type={type}
                  required
                  disabled={busy}
                  {...(name === "incomeValue" ? { min: 0, step: "0.01" } : {})}
                />
              </div>
            ))}
            <label className="flex gap-2 sm:col-span-2">
              <input type="checkbox" name="consent" required disabled={busy} />
              Confirmo que sou o titular designado e autorizo o cadastro e a
              verificação no Asaas descritos acima.
            </label>
            <Button type="submit" disabled={busy || !onSubmit}>
              Enviar cadastro ao Asaas
            </Button>
          </form>
        </>
      )}
      {state.status !== "denied" && (
        <Button disabled={busy || !onRetry} onClick={onRetry}>
          Verificar situação
        </Button>
      )}
    </section>
  );
}
