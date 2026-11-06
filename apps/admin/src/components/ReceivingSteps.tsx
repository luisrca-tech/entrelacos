import {
  type GiftItem,
  type ReceivingReadiness,
  type ReceivingSetupContext,
  receivingIncomingPixDisclosure,
} from "@entrelacos/contracts";
import { Button, showSandboxNotice, toast } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Clock,
  Gift,
  Mail,
  Plus,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useState,
} from "react";
import { apiRequest } from "../lib/apiClient";
import {
  type AsaasTasks,
  asaasTasksKey,
  documentsTaskStatus,
  useAsaasTasks,
} from "./asaasTasks";
import type { FinancialReauthenticationGuard } from "./financialReauthenticationClient";
import {
  GiftFeeAllocationChooser,
  GiftPricingPreview,
  GiftPricingSettings,
  money,
  useGiftPricingControls,
} from "./GiftPricingSettings";
import { GiftCatalogClient } from "./giftCatalogClient";
import { isCurrentPanelSessionEpoch } from "./panelActor";
import { ReceivingPixDestination } from "./ReceivingPixDestination";
import type {
  ReceivingSetupPorts,
  ReceivingSetupScope,
} from "./ReceivingSetup";
import type { ReceivingStepId, ReceivingTrackStep } from "./receivingTrack";
import {
  AsideCard,
  ExternalLink,
  FaqList,
  ProgressBar,
  receivingBody,
  receivingCard,
  receivingEyebrow,
  receivingField,
  receivingLink,
  receivingPrimaryAction,
  receivingSecondaryAction,
  receivingStepTitle,
  StatusBadge,
  StepFrame,
  StepHeading,
  StepIndicator,
} from "./receivingUi";

export const supportMailto =
  "mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20a%20ativa%C3%A7%C3%A3o%20no%20Asaas";

export function asaasLoginUrl(mode: string | null | undefined) {
  return mode === "sandbox"
    ? "https://sandbox.asaas.com/login/auth?customerSignUpOriginChannel=HOME"
    : "https://www.asaas.com/login/auth?customerSignUpOriginChannel=HOME";
}

export type ReceivingStepsContext = {
  scope: ReceivingSetupScope;
  setup: ReceivingSetupContext | null;
  status: "loading" | "ready" | "submitting" | "denied" | "unavailable";
  busy: boolean;
  owner: boolean;
  canSubmit: boolean;
  receivingReady: boolean;
  readiness: ReceivingReadiness | null;
  steps: ReceivingTrackStep[];
  next: ReceivingTrackStep | null;
  completed: number;
  feesChosen: boolean;
  guard?: FinancialReauthenticationGuard;
  pixGuard?: FinancialReauthenticationGuard;
  incomingGuard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  form?: RefObject<HTMLFormElement | null>;
  incomingAvailable: boolean;
  onRetry?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onDesignate?: (holderUserId: string) => void;
  onVerifyIncoming?: () => void;
  onAuthorizePix?: () => void;
  onFeesChosen?: () => void;
};

const lastCheckFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function LastCheck({ setup }: { setup: ReceivingSetupContext | null }) {
  const observedAt = setup?.providerStatus?.observedAt;
  return (
    <p className="m-0 flex items-center gap-2 text-[0.82rem] text-admin-muted">
      <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
      {observedAt ? (
        <span>
          Última consulta ao Asaas em{" "}
          <time dateTime={observedAt}>
            {lastCheckFormatter.format(new Date(observedAt))}
          </time>
        </span>
      ) : (
        <span>Ainda sem consulta ao Asaas</span>
      )}
    </p>
  );
}

function SetupStatus({ context }: { context: ReceivingStepsContext }) {
  const { status, setup } = context;
  if (status === "loading")
    return (
      <p role="status" className={receivingBody}>
        Verificando o titular e o cadastro…
      </p>
    );
  if (status === "submitting")
    return (
      <p role="status" className={receivingBody}>
        {setup?.accountState === "CREATED"
          ? "Preparando sua conta para receber por Pix…"
          : "Atualizando a configuração de recebimento…"}
      </p>
    );
  if (status === "denied")
    return (
      <p role="alert" className={receivingBody}>
        Sua sessão ou permissão mudou. Entre novamente para continuar.
      </p>
    );
  if (status === "unavailable")
    return (
      <div className="grid gap-3">
        <p role="alert" className={receivingBody}>
          Configuração indisponível. Verifique a conexão e tente novamente.
        </p>
        <Button
          variant="outline"
          className="w-fit"
          disabled={!context.onRetry}
          onClick={context.onRetry}
        >
          Tentar novamente
        </Button>
      </div>
    );
  return null;
}

function SandboxNotice({ mode }: { mode: string | null | undefined }) {
  return showSandboxNotice(mode) ? (
    <p className="m-0 rounded-[10px] bg-admin-pending-wash p-3 text-sm text-admin-pending-ink">
      Sandbox Asaas: ambiente de teste, sem movimentação de dinheiro real.
    </p>
  ) : null;
}

function nextCopy(context: ReceivingStepsContext, tasks: AsaasTasks) {
  const { next, setup, owner } = context;
  const holderName = setup?.holder?.name ?? "O titular";
  switch (next?.id) {
    case "holder":
      return {
        text: owner
          ? "Escolha qual dos noivos será titular da conta e dos saques."
          : "A equipe do EntreLaços define quem dos noivos será titular da conta. Depois disso, você segue para os seus dados.",
        action: owner ? "Escolher titular" : "Ver etapa",
      };
    case "details":
      return next.status === "attention"
        ? {
            text: "Não sabemos se a conta foi criada. Verifique a situação antes de tentar de novo.",
            action: "Verificar situação",
          }
        : {
            text: setup?.isHolder
              ? "Preencha seus dados para abrirmos sua conta no Asaas, no seu nome."
              : `${holderName} precisa preencher os dados para abrir a conta no Asaas.`,
            action: setup?.isHolder ? "Preencher meus dados" : "Ver etapa",
          };
    case "activation": {
      if (next.status === "review")
        return {
          text: "O Asaas está analisando a conta. Não há nada a fazer aqui agora.",
          action: "Acompanhar análise",
        };
      if (next.status === "attention")
        return {
          text: "O Asaas pediu um ajuste nos dados ou documentos. Confira no Asaas e envie de novo.",
          action: "Ver o que ajustar",
        };
      const done =
        Number(tasks.password) +
        Number(tasks.phone) +
        Number(
          documentsTaskStatus(setup?.providerStatus?.documentation) ===
            "done" ||
            documentsTaskStatus(setup?.providerStatus?.documentation) ===
              "review",
        );
      const missing = 3 - done;
      return {
        text:
          missing > 0
            ? `Sua conta foi criada. ${missing === 1 ? "Falta 1 de 3 tarefas" : `Faltam ${missing} de 3 tarefas`} no Asaas: criar a senha, confirmar o celular e enviar os documentos com selfie.`
            : "Tarefas marcadas como feitas. Verifique a situação para atualizar a análise do Asaas.",
        action: "Continuar ativação",
      };
    }
    case "account":
      return {
        text: "Informe a chave Pix do seu banco. É para lá que os saques vão.",
        action: "Cadastrar conta para saque",
      };
    case "fees":
      return {
        text: "Escolha quem paga as taxas dos presentes.",
        action: "Escolher quem paga as taxas",
      };
    default:
      return null;
  }
}

function TaskQuickList({
  tasks,
  documentation,
  onToggle,
  disabled,
}: {
  tasks: AsaasTasks;
  documentation: Parameters<typeof documentsTaskStatus>[0];
  onToggle: (task: keyof AsaasTasks, value: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  const documents = documentsTaskStatus(documentation);
  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {(
        [
          ["password", "Criar a senha pelo e-mail"],
          ["phone", "Confirmar o celular por SMS"],
        ] as const
      ).map(([task, label]) => (
        <li key={task}>
          <label
            htmlFor={`${id}-${task}`}
            className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.95rem] text-admin-ink"
          >
            <input
              id={`${id}-${task}`}
              type="checkbox"
              className="size-[22px] shrink-0 accent-admin-status-confirmed"
              checked={tasks[task]}
              disabled={disabled}
              onChange={(event) => onToggle(task, event.target.checked)}
            />
            {label}
          </label>
        </li>
      ))}
      <li className="flex min-h-11 items-center gap-3 text-[0.95rem] text-admin-ink">
        <span
          aria-hidden="true"
          className={`flex size-[22px] shrink-0 items-center justify-center rounded-[5px] border-2 ${documents === "done" ? "border-admin-status-confirmed bg-admin-status-confirmed text-white" : "border-admin-line-strong"}`}
        >
          {documents === "done" && <Check className="size-3.5" />}
        </span>
        Enviar documentos e selfie
        <span className="sr-only">
          {documents === "done"
            ? " (feito)"
            : documents === "review"
              ? " (em análise)"
              : " (a fazer)"}
        </span>
      </li>
    </ul>
  );
}

function AdvanceCard({
  context,
  className = "",
}: {
  context: ReceivingStepsContext;
  className?: string;
}) {
  const siteId = context.scope.siteId;
  const pending = context.steps.filter(
    (step) =>
      (step.id === "account" || step.id === "fees") &&
      (step.status === "available" || step.status === "current"),
  );
  const activation = context.steps.find(({ id }) => id === "activation");
  if (
    !pending.length ||
    !activation ||
    activation.status === "done" ||
    activation.status === "locked"
  )
    return null;
  return (
    <div className={className}>
      <AsideCard
        tone="accent"
        title={
          activation.status === "review"
            ? "Enquanto o Asaas analisa"
            : "Já pode adiantar"
        }
      >
        <p className="m-0 text-sm leading-[1.55]">
          Você não precisa esperar a aprovação para adiantar{" "}
          {pending.length === 2 ? "as etapas 4 e 5" : "esta etapa"}.
        </p>
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {pending.map((step) => (
            <li key={step.id}>
              <Link
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: step.id }}
                className="font-semibold text-admin-terracotta-ink underline underline-offset-4"
              >
                {step.number} ·{" "}
                {step.id === "account"
                  ? "Cadastrar a conta para saque"
                  : "Escolher quem paga as taxas"}
              </Link>
            </li>
          ))}
        </ul>
      </AsideCard>
    </div>
  );
}

const moneyPath = [
  "O convidado escolhe um presente no site e paga.",
  "O valor entra na sua conta Asaas, aberta no seu nome.",
  "Você saca aqui no EntreLaços para a chave Pix do seu banco.",
];

const commonQuestions = [
  {
    question: "Por que preciso de uma conta no Asaas?",
    answer: (
      <p className="m-0">
        O Asaas é a instituição de pagamento que recebe os presentes e guarda os
        valores no nome do titular. O EntreLaços organiza a lista e os pedidos
        de saque, mas não guarda o dinheiro.
      </p>
    ),
  },
  {
    question: "O EntreLaços vê minha senha do Asaas?",
    answer: (
      <p className="m-0">
        Não. A senha, os códigos por SMS e o Token App ficam só no Asaas. O
        EntreLaços nunca pede esses dados.
      </p>
    ),
  },
];

export function ReceivingOverviewTrack({
  context,
}: {
  context: ReceivingStepsContext;
}) {
  const siteId = context.scope.siteId;
  const { next, steps, completed, setup } = context;
  const [tasks, toggle] = useAsaasTasks(
    asaasTasksKey(siteId, setup?.holder?.userId ?? "none"),
  );
  const copy = nextCopy(context, tasks);
  const taskOwner = !!setup?.isHolder && !context.owner;
  return (
    <div className="grid min-w-0 gap-6">
      <header className="grid gap-1.5">
        <h1 className={receivingStepTitle}>Recebimentos</h1>
        <p className="m-0 text-base leading-[1.6] text-admin-muted">
          Configure uma vez para receber os presentes em dinheiro e sacar para o
          seu banco.
        </p>
      </header>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-5">
          <SetupStatus context={context} />
          <section className={`${receivingCard} grid gap-3 px-6 py-[22px]`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="m-0 text-base font-bold text-admin-ink">
                Configuração dos recebimentos
              </h2>
              <p className="m-0 text-sm text-admin-muted">
                {completed} de 5 concluídas
              </p>
            </div>
            <ProgressBar completed={completed} />
          </section>
          {next && copy && (
            <section
              aria-labelledby="receiving-next-step"
              className="grid min-w-0 gap-3.5 rounded-2xl border-2 border-admin-terracotta bg-admin-surface p-7 [@media(max-width:760px)]:p-5"
            >
              <p className={receivingEyebrow}>
                Próximo passo · Etapa {next.number} de 5
              </p>
              <h2
                id="receiving-next-step"
                className="m-0 font-admin-display text-[1.75rem] leading-[1.15] font-normal text-admin-ink"
              >
                {next.title}
              </h2>
              {next.id === "activation" &&
              next.status === "current" &&
              taskOwner ? (
                <>
                  <p
                    className={`${receivingBody} [@media(max-width:760px)]:hidden`}
                  >
                    {copy.text}
                  </p>
                  <div className="hidden [@media(max-width:760px)]:block">
                    <TaskQuickList
                      tasks={tasks}
                      documentation={setup?.providerStatus?.documentation}
                      onToggle={toggle}
                      disabled={context.busy}
                    />
                  </div>
                </>
              ) : (
                <p className={receivingBody}>{copy.text}</p>
              )}
              {next.id === "activation" && <LastCheck setup={setup} />}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{ siteId, page: next.id }}
                  className={receivingPrimaryAction}
                >
                  {copy.action}
                </Link>
              </div>
            </section>
          )}
          <AdvanceCard context={context} className="lg:hidden" />
          <section
            aria-labelledby="receiving-steps-title"
            className={`${receivingCard} py-2`}
          >
            <h2
              id="receiving-steps-title"
              className="m-0 px-6 pt-4 pb-2 text-sm font-bold uppercase tracking-[0.06em] text-admin-muted"
            >
              As 5 etapas
            </h2>
            <ol className="m-0 list-none p-0">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className="flex gap-4 border-t border-admin-beige px-6 py-4 [@media(max-width:760px)]:px-4"
                >
                  <StepIndicator number={step.number} status={step.status} />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <h3 className="m-0 text-base font-bold text-admin-ink">
                        {step.status === "locked" ? (
                          step.title
                        ) : (
                          <Link
                            to="/sites/$siteId/receiving/$page"
                            params={{ siteId, page: step.id }}
                            className="text-admin-ink no-underline hover:underline"
                          >
                            <span className="sr-only">
                              Etapa {step.number}:{" "}
                            </span>
                            {step.title}
                          </Link>
                        )}
                      </h3>
                      <StatusBadge status={step.status} />
                    </div>
                    <p className="m-0 text-sm leading-[1.5] text-admin-muted">
                      {step.summary}
                    </p>
                    {step.status === "available" && (
                      <Link
                        to="/sites/$siteId/receiving/$page"
                        params={{ siteId, page: step.id }}
                        className={`${receivingLink} mt-1 inline-flex min-h-8 w-fit items-center`}
                      >
                        Fazer agora
                        <span className="sr-only">: {step.title}</span>
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="grid min-w-0 gap-5">
          <AdvanceCard context={context} className="hidden lg:block" />
          <AsideCard title="Como o dinheiro chega até vocês">
            <ol className="m-0 grid list-none gap-3 p-0">
              {moneyPath.map((text, index) => (
                <li key={text} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-admin-beige text-[0.8rem] font-bold text-admin-ink"
                  >
                    {index + 1}
                  </span>
                  <span className="text-sm leading-[1.5] text-admin-body">
                    {text}
                  </span>
                </li>
              ))}
            </ol>
          </AsideCard>
          <FaqList
            title="Dúvidas comuns"
            items={commonQuestions}
            footer={
              <Link
                to="/sites/$siteId/receiving-guide"
                params={{ siteId }}
                className={`${receivingLink} mt-1.5 w-fit text-sm`}
              >
                Ver o guia completo
              </Link>
            }
          />
        </aside>
      </div>
    </div>
  );
}

export function HolderStep({ context }: { context: ReceivingStepsContext }) {
  const id = useId();
  const { setup, owner, busy } = context;
  return (
    <StepFrame
      siteId={context.scope.siteId}
      steps={context.steps}
      current="holder"
      aside={
        <FaqList
          items={[
            {
              question: "Por que só uma pessoa recebe?",
              answer: (
                <p className="m-0">
                  A conta no Asaas é aberta no nome de uma pessoa, que confirma
                  a identidade e faz os saques. Os dois continuam administrando
                  o casamento normalmente.
                </p>
              ),
            },
            {
              question: "Dá para trocar o titular depois?",
              answer: (
                <p className="m-0">
                  A designação é fixa depois de salva. Se precisar mudar, fale
                  com o suporte do EntreLaços.
                </p>
              ),
            },
          ]}
        />
      }
    >
      <section
        className={`${receivingCard} grid gap-5 p-8 [@media(max-width:760px)]:p-5`}
      >
        <StepHeading number={1} title="Quem vai receber os presentes?">
          <p className={receivingBody}>
            Um dos noivos é o titular da conta no Asaas e dos saques. A
            permissão de administrar o casamento não define quem recebe.
          </p>
        </StepHeading>
        <SetupStatus context={context} />
        {setup?.holder && (
          <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-admin-canvas p-4">
            <p className="m-0 text-[0.95rem] text-admin-ink">
              Titular dos recebimentos: <strong>{setup.holder.name}</strong>
            </p>
            <StatusBadge status="done" />
          </div>
        )}
        {setup && !setup.holder && !owner && (
          <p className={receivingBody}>
            O titular dos recebimentos ainda não foi designado. O responsável
            pela plataforma deve selecionar a conta do titular.
          </p>
        )}
        {setup && !setup.holder && owner && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get(
                "holderUserId",
              );
              if (typeof value === "string") context.onDesignate?.(value);
            }}
            className="grid gap-3"
          >
            <label
              htmlFor={`${id}-holder`}
              className="text-sm font-bold text-admin-ink"
            >
              Conta do titular neste casamento
            </label>
            <select
              id={`${id}-holder`}
              name="holderUserId"
              required
              disabled={busy || !setup.holderCandidates?.length}
              className={receivingField}
            >
              <option value="">Selecione o titular</option>
              {setup.holderCandidates?.map((candidate) => (
                <option key={candidate.userId} value={candidate.userId}>
                  {candidate.name} ({candidate.email})
                </option>
              ))}
            </select>
            {!setup.holderCandidates?.length && (
              <p className="m-0 text-sm text-admin-muted">
                Adicione uma conta administradora para o titular antes de
                designar o titular.
              </p>
            )}
            <p className="m-0 text-sm text-admin-muted">
              A conta deve estar ativa e administrar este casamento. A
              designação será fixa; confirme a identidade antes de salvar.
            </p>
            <button
              type="submit"
              className={receivingPrimaryAction}
              disabled={
                busy || !context.onDesignate || !setup.holderCandidates?.length
              }
            >
              Designar titular
            </button>
          </form>
        )}
        {setup?.holder && (
          <Link
            to="/sites/$siteId/receiving/$page"
            params={{ siteId: context.scope.siteId, page: "details" }}
            className={receivingPrimaryAction}
          >
            Ir para Seus dados
          </Link>
        )}
      </section>
    </StepFrame>
  );
}

const detailFields: {
  name: string;
  label: string;
  type: string;
  placeholder?: string;
  hint?: string;
  inputMode?: "numeric" | "decimal" | "tel" | "email";
  autoComplete?: string;
  wide?: boolean;
}[] = [
  {
    name: "name",
    label: "Nome completo do titular",
    type: "text",
    hint: "Igual ao documento de identidade.",
    autoComplete: "name",
    wide: true,
  },
  {
    name: "cpfCnpj",
    label: "CPF",
    type: "text",
    placeholder: "000.000.000-00",
    inputMode: "numeric",
  },
  { name: "birthDate", label: "Data de nascimento", type: "date" },
  {
    name: "email",
    label: "E-mail do titular",
    type: "email",
    placeholder: "nome@email.com",
    hint: "O Asaas manda o link para criar a senha neste e-mail.",
    autoComplete: "email",
  },
  {
    name: "mobilePhone",
    label: "Celular com DDD",
    type: "tel",
    placeholder: "(11) 90000-0000",
    hint: "Você vai receber um código por SMS.",
    inputMode: "tel",
    autoComplete: "tel-national",
  },
  {
    name: "postalCode",
    label: "CEP",
    type: "text",
    placeholder: "00000-000",
    inputMode: "numeric",
    autoComplete: "postal-code",
  },
  {
    name: "incomeValue",
    label: "Renda mensal aproximada",
    type: "text",
    placeholder: "R$ 0,00",
    hint: "Pedido pelo Asaas para abrir qualquer conta.",
    inputMode: "decimal",
  },
  {
    name: "address",
    label: "Endereço",
    type: "text",
    placeholder: "Rua, avenida…",
    autoComplete: "address-line1",
    wide: true,
  },
  { name: "addressNumber", label: "Número", type: "text" },
  { name: "province", label: "Bairro", type: "text" },
];

const nextSteps = [
  {
    icon: Mail,
    title: "E-mail do Asaas",
    text: "Com o link para criar a sua senha.",
  },
  {
    icon: Smartphone,
    title: "SMS e documentos",
    text: "No Asaas: confirmar o celular, enviar o documento e a selfie.",
  },
  {
    icon: Clock,
    title: "Análise do Asaas",
    text: "O Asaas analisa a conta. Acompanhe a situação aqui em Recebimentos.",
  },
];

export function DetailsStep({ context }: { context: ReceivingStepsContext }) {
  const id = useId();
  const { setup, busy, canSubmit, owner } = context;
  const siteId = context.scope.siteId;
  return (
    <StepFrame
      siteId={siteId}
      steps={context.steps}
      current="details"
      aside={
        <>
          <AsideCard title="O que vem depois">
            <ul className="m-0 grid list-none gap-3.5 p-0">
              {nextSteps.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-3">
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 size-[18px] shrink-0 text-admin-terracotta-deep"
                  />
                  <span className="grid gap-0.5 text-sm leading-[1.5]">
                    <strong className="text-admin-ink">{title}</strong>
                    <span className="text-admin-body">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </AsideCard>
          <AsideCard title="Seus dados ficam seguros">
            <p className="m-0 text-sm leading-[1.6] text-admin-body">
              Os dados vão direto para o Asaas, a instituição de pagamento que
              guarda os valores no seu nome. Não abra outra conta no Asaas por
              conta própria: use a que criamos aqui.
            </p>
          </AsideCard>
          <FaqList
            items={[
              {
                question: "Por que o Asaas pede renda e endereço?",
                answer: (
                  <p className="m-0">
                    São exigências do Asaas para abrir qualquer conta de
                    pagamento e verificar a identidade do titular.
                  </p>
                ),
              },
              {
                question: "O que eu autorizo ao continuar?",
                answer: (
                  <p className="m-0">
                    A abertura da conta no seu nome e a criação de uma chave Pix
                    aleatória nessa conta, só para receber os presentes. Os dois
                    aceites ficam registrados separadamente, cada um com a sua
                    versão.
                  </p>
                ),
              },
            ]}
          />
        </>
      }
    >
      <section
        className={`${receivingCard} grid gap-6 p-8 [@media(max-width:760px)]:p-5`}
      >
        <StepHeading number={2} title="Seus dados para abrir a conta">
          <p className={receivingBody}>
            Usamos esses dados uma única vez para criar sua conta no Asaas
            {setup?.holder ? (
              <>
                , no nome de <strong>{setup.holder.name}</strong>, titular dos
                recebimentos.
              </>
            ) : (
              "."
            )}
          </p>
        </StepHeading>
        <SandboxNotice mode={setup?.mode} />
        <SetupStatus context={context} />
        {setup && !setup.holder && (
          <p className={receivingBody}>
            Primeiro, defina quem vai receber.{" "}
            <Link
              to="/sites/$siteId/receiving/$page"
              params={{ siteId, page: "holder" }}
              className={receivingLink}
            >
              Ir para a etapa 1
            </Link>
          </p>
        )}
        {setup?.holder &&
          !setup.isHolder &&
          setup.accountState !== "CREATED" && (
            <p className={receivingBody}>
              Somente o titular designado pode consentir e enviar o cadastro ao
              Asaas. Administrar o casamento não autoriza abrir uma conta em
              nome de outra pessoa.
            </p>
          )}
        {setup?.accountState === "UNKNOWN" && (
          <div className="grid gap-3 rounded-[14px] bg-admin-danger-wash p-4 text-admin-danger-ink">
            <p role="alert" className="m-0 text-sm leading-[1.55]">
              O resultado da criação está incerto. Verifique a conta existente
              antes de repetir qualquer criação.
            </p>
          </div>
        )}
        {setup?.accountState === "PENDING" && !canSubmit && (
          <p role="status" className={receivingBody}>
            Estamos abrindo sua conta no Asaas. Verifique a situação em
            instantes.
          </p>
        )}
        {setup?.accountState === "CREATED" && (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-admin-canvas p-4">
              <p role="status" className="m-0 text-[0.95rem] text-admin-ink">
                Conta criada no Asaas
                {setup.holder ? ` em nome de ${setup.holder.name}` : ""}.
              </p>
              <StatusBadge status="done" />
            </div>
            <Link
              to="/sites/$siteId/receiving/$page"
              params={{ siteId, page: "activation" }}
              className={receivingPrimaryAction}
            >
              Ir para a ativação
            </Link>
          </div>
        )}
        {canSubmit && setup && (
          <form
            ref={context.form}
            onSubmit={context.onSubmit}
            className="grid gap-6"
            autoComplete="off"
          >
            <div className="grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
              {detailFields.map((field) => (
                <div
                  key={field.name}
                  className={`grid min-w-0 content-start gap-1.5 ${field.wide ? "sm:col-span-2" : ""}`}
                >
                  <label
                    htmlFor={`${id}-${field.name}`}
                    className="text-sm font-bold text-admin-ink"
                  >
                    {field.label}
                  </label>
                  <input
                    id={`${id}-${field.name}`}
                    name={field.name}
                    type={field.type}
                    required
                    disabled={busy}
                    placeholder={field.placeholder}
                    inputMode={field.inputMode}
                    autoComplete={field.autoComplete ?? "off"}
                    aria-describedby={
                      field.hint ? `${id}-${field.name}-hint` : undefined
                    }
                    className={receivingField}
                  />
                  {field.hint && (
                    <p
                      id={`${id}-${field.name}-hint`}
                      className="m-0 text-[0.8rem] leading-[1.4] text-admin-muted"
                    >
                      {field.hint}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <fieldset className="m-0 grid min-w-0 gap-3 rounded-[14px] border border-admin-line bg-admin-canvas p-5">
              <legend className="sr-only">Autorizações</legend>
              <p className="m-0 text-[0.95rem] font-bold text-admin-ink">
                Ao continuar, você autoriza
              </p>
              <ul className="m-0 grid list-disc gap-2 pl-5 text-sm leading-[1.55] text-admin-body">
                <li>
                  Abrir uma conta no Asaas no seu nome e verificar sua
                  identidade.
                </li>
                <li>
                  Criar nessa conta uma chave Pix aleatória só para receber os
                  presentes.
                </li>
                <li>
                  Sua chave do banco não muda; ela será só o destino dos saques.
                </li>
              </ul>
              <details>
                <summary
                  className={`${receivingLink} w-fit cursor-pointer text-sm`}
                >
                  Ler o termo completo
                </summary>
                <div className="mt-3 grid gap-2 text-sm leading-[1.6] text-admin-body">
                  <p className="m-0">
                    {showSandboxNotice(setup.mode)
                      ? setup.disclosure.text
                      : setup.disclosure.text.split(" Em Sandbox,")[0]}
                  </p>
                  <p className="m-0">{receivingIncomingPixDisclosure.text}</p>
                </div>
              </details>
              <label className="mt-1 flex cursor-pointer items-start gap-3 text-[0.95rem] text-admin-ink">
                <input
                  type="checkbox"
                  name="consent"
                  required
                  disabled={busy}
                  className="mt-0.5 size-5 shrink-0 accent-admin-terracotta"
                />
                Confirmo que sou o titular designado dos recebimentos e concordo
                com os itens acima.
              </label>
            </fieldset>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="submit"
                className={receivingPrimaryAction}
                disabled={busy || !context.onSubmit}
              >
                Criar minha conta no Asaas
              </button>
              <p className="m-0 text-[0.82rem] text-admin-muted">
                Depois disso, você segue para a ativação.
              </p>
            </div>
          </form>
        )}
        {!canSubmit &&
          setup &&
          setup.accountState !== "CREATED" &&
          context.status === "ready" &&
          !owner && (
            <Button
              variant="outline"
              className="w-fit"
              disabled={busy || !context.onRetry}
              onClick={context.onRetry}
            >
              Verificar situação
            </Button>
          )}
      </section>
    </StepFrame>
  );
}

function ActivationTaskRow({
  title,
  badge,
  description,
  note,
  control,
}: {
  title: string;
  badge: ReactNode;
  description: ReactNode;
  note: string;
  control: ReactNode;
}) {
  return (
    <li className="flex gap-4 border-b border-admin-beige px-6 py-5 last:border-b-0 [@media(max-width:760px)]:px-4">
      <div className="pt-0.5">{control}</div>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="m-0 text-base font-bold text-admin-ink">{title}</h3>
          {badge}
        </div>
        <p className="m-0 text-[0.95rem] leading-[1.55] text-admin-body">
          {description}
        </p>
        <p className="m-0 text-xs text-admin-muted">{note}</p>
      </div>
    </li>
  );
}

function TaskBadge({
  tone,
  children,
}: {
  tone: "done" | "todo" | "waiting" | "review" | "attention";
  children: ReactNode;
}) {
  const classes = {
    done: "bg-admin-success-wash text-admin-success-ink",
    todo: "bg-admin-beige text-admin-body",
    waiting: "bg-admin-pending-wash text-admin-pending-ink",
    review: "bg-admin-pending-wash text-admin-pending-ink",
    attention: "bg-admin-danger-wash text-admin-danger-ink",
  }[tone];
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs leading-none font-bold ${classes}`}
    >
      {children}
    </span>
  );
}

const activationQuestions = (mode: string | null | undefined) => [
  {
    question: "Preciso baixar o app do Asaas?",
    answer: (
      <>
        <p className="m-0">
          Não. Tudo pode ser feito pelo navegador. O app é útil depois, para o
          Token App, quando o Asaas habilitar.
        </p>
        <p className="m-0">
          <ExternalLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32094322891291-O-que-%C3%A9-o-Token-App">
            Entenda o Token App
          </ExternalLink>
        </p>
      </>
    ),
  },
  {
    question: "Por que o Asaas pede selfie?",
    answer: (
      <p className="m-0">
        A selfie confirma que a pessoa que abre a conta é a mesma do documento.
        Isso protege seus recebimentos contra fraudes.
      </p>
    ),
  },
  {
    question: "Onde confirmo o celular?",
    answer: (
      <p className="m-0">
        No Asaas, em Minha conta, na tela de ativação: digite o código recebido
        por SMS.
      </p>
    ),
  },
  {
    question: "Como o painel acompanha a ativação?",
    answer: (
      <>
        <p className="m-0">
          A senha e o recebimento do e-mail não são consultados por este painel.
          O botão Verificar agora atualiza as verificações cadastrais do Asaas.
        </p>
        {showSandboxNotice(mode) && (
          <p className="m-0">
            No Sandbox, o link de definição de senha e as demais comunicações de
            teste são redirecionadas para o e-mail da conta principal do Asaas.
            Depois de definir a senha, entre no Asaas Sandbox com o e-mail
            cadastrado para o recebedor.
          </p>
        )}
      </>
    ),
  },
];

export function ActivationStep({
  context,
}: {
  context: ReceivingStepsContext;
}) {
  const helpId = useId();
  const { setup, busy, owner, receivingReady } = context;
  const siteId = context.scope.siteId;
  const [tasks, toggle] = useAsaasTasks(
    asaasTasksKey(siteId, setup?.holder?.userId ?? "none"),
  );
  const [help, setHelp] = useState(false);
  const provider = setup?.providerStatus ?? null;
  const documents = documentsTaskStatus(provider?.documentation);
  const created = setup?.accountState === "CREATED";
  const taskOwner = !!setup?.isHolder && !owner;
  const rejected =
    provider &&
    [
      provider.commercialInfo,
      provider.bankAccountInfo,
      provider.documentation,
      provider.general,
    ].includes("REJECTED");
  const consentsReady =
    !!setup?.consentRecorded && setup.pixConsentRecorded === true;
  return (
    <StepFrame
      siteId={siteId}
      steps={context.steps}
      current="activation"
      aside={
        <>
          <AsideCard
            title="Situação no Asaas"
            icon={
              <RefreshCw
                aria-hidden="true"
                className="size-[18px] text-admin-terracotta-deep"
              />
            }
          >
            <p className="m-0 text-sm leading-[1.55] text-admin-body">
              {receivingReady
                ? "Recebimentos liberados. Você pode acompanhar os pagamentos e consultar a disponibilidade de saque."
                : "Quando concluir uma tarefa no Asaas, verifique de novo para atualizar a situação aqui."}
            </p>
            <LastCheck setup={setup} />
            {context.status !== "denied" && (
              <button
                type="button"
                className={receivingSecondaryAction}
                disabled={busy || !context.onRetry}
                onClick={context.onRetry}
              >
                Verificar agora
              </button>
            )}
            {created &&
              context.incomingAvailable &&
              !receivingReady &&
              taskOwner &&
              consentsReady &&
              context.incomingGuard?.isCurrent() && (
                <button
                  type="button"
                  className={`${receivingLink} w-fit bg-transparent p-0 text-left text-sm disabled:opacity-60`}
                  disabled={busy || !context.onVerifyIncoming}
                  onClick={context.onVerifyIncoming}
                >
                  Atualizar liberação dos recebimentos
                </button>
              )}
          </AsideCard>
          <AdvanceCard context={context} />
          <FaqList items={activationQuestions(setup?.mode)} />
        </>
      }
    >
      <StepHeading number={3} title="Ative sua conta no Asaas">
        <p className={receivingBody}>
          {created
            ? "Sua conta foi criada. Estas 3 tarefas são feitas no site ou app do Asaas e levam poucos minutos. Marque cada uma quando concluir."
            : "Primeiro, crie a conta na etapa 2. Depois, as tarefas de ativação aparecem aqui."}
        </p>
      </StepHeading>
      <SandboxNotice mode={setup?.mode} />
      <SetupStatus context={context} />
      {setup && !created && (
        <p className={receivingBody}>
          <Link
            to="/sites/$siteId/receiving/$page"
            params={{ siteId, page: "details" }}
            className={receivingLink}
          >
            Ir para Seus dados
          </Link>
        </p>
      )}
      {created && setup && (
        <section
          aria-label="Tarefas no Asaas"
          className={`${receivingCard} overflow-hidden`}
        >
          <ul className="m-0 list-none p-0">
            {(
              [
                [
                  "password",
                  "Criar sua senha",
                  "Abra o e-mail do Asaas enviado para o e-mail cadastrado e defina a senha de acesso.",
                  "Marque quando concluir. O EntreLaços não vê sua senha.",
                ],
                [
                  "phone",
                  "Confirmar o celular",
                  "No Asaas, em Minha conta, na tela de ativação do Asaas, digite o código recebido por SMS.",
                  "Marque quando concluir.",
                ],
              ] as const
            ).map(([task, title, description, note]) => (
              <ActivationTaskRow
                key={task}
                title={title}
                badge={
                  <TaskBadge tone={tasks[task] ? "done" : "todo"}>
                    {tasks[task] ? "Feito" : "A fazer"}
                  </TaskBadge>
                }
                description={description}
                note={note}
                control={
                  <input
                    type="checkbox"
                    aria-label={`${title}: marcar como feito`}
                    className="size-6 accent-admin-status-confirmed"
                    checked={tasks[task]}
                    disabled={!taskOwner || busy}
                    onChange={(event) => toggle(task, event.target.checked)}
                  />
                }
              />
            ))}
            <ActivationTaskRow
              title="Enviar documentos e selfie"
              badge={
                <TaskBadge
                  tone={
                    documents === "done"
                      ? "done"
                      : documents === "review"
                        ? "review"
                        : documents === "attention"
                          ? "attention"
                          : "waiting"
                  }
                >
                  {documents === "done"
                    ? "Feito"
                    : documents === "review"
                      ? "Em análise"
                      : documents === "attention"
                        ? "Precisa reenviar"
                        : "Aguardando envio"}
                </TaskBadge>
              }
              description="No Asaas, envie a foto do documento e faça a selfie, quando solicitado, no próprio Asaas."
              note={
                provider
                  ? "Detectado automaticamente pelo Asaas."
                  : "Não foi possível consultar as verificações do Asaas. Verifique a situação novamente."
              }
              control={
                <span
                  aria-hidden="true"
                  className={`flex size-6 items-center justify-center rounded-full border-2 ${documents === "done" ? "border-admin-status-confirmed bg-admin-status-confirmed text-white" : documents === "attention" ? "border-admin-status-declined" : "border-admin-status-pending"}`}
                >
                  {documents === "done" && <Check className="size-3.5" />}
                </span>
              }
            />
          </ul>
          {taskOwner && !receivingReady && context.incomingAvailable && (
            <div className="grid gap-4 border-t border-admin-beige px-6 py-5 [@media(max-width:760px)]:px-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <ExternalLink
                  href={asaasLoginUrl(setup.mode)}
                  className={receivingPrimaryAction}
                >
                  Abrir o Asaas
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </ExternalLink>
                <button
                  type="button"
                  aria-expanded={help}
                  aria-controls={helpId}
                  onClick={() => setHelp((value) => !value)}
                  className={`${receivingLink} inline-flex min-h-11 items-center bg-transparent p-0 text-[0.95rem] [@media(max-width:760px)]:w-full [@media(max-width:760px)]:justify-center`}
                >
                  Não recebi o e-mail do Asaas
                </button>
              </div>
              <div
                id={helpId}
                hidden={!help}
                className="rounded-[14px] bg-admin-canvas p-5"
              >
                <p className="m-0 mb-2 text-[0.95rem] font-bold text-admin-ink">
                  Vamos resolver
                </p>
                <ol className="m-0 grid list-decimal gap-2 pl-5 text-sm leading-[1.55] text-admin-body">
                  <li>
                    Procure por “Asaas” na caixa de entrada, no spam e em
                    Promoções.
                  </li>
                  <li>Confira se o e-mail cadastrado na etapa 2 está certo.</li>
                  <li>
                    Ainda nada? Use “Esqueci minha senha” no Asaas com esse
                    e-mail.
                  </li>
                </ol>
                <a
                  href={supportMailto}
                  className={`${receivingLink} mt-3 inline-flex text-sm`}
                >
                  Falar com o suporte do EntreLaços
                </a>
              </div>
            </div>
          )}
          {!taskOwner && setup.holder && (
            <p className="m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted">
              Somente {setup.holder.name} conclui estas tarefas no Asaas.
            </p>
          )}
        </section>
      )}
      {rejected && (
        <p
          role="alert"
          className="m-0 rounded-[14px] bg-admin-danger-wash p-4 text-sm leading-[1.55] text-admin-danger-ink"
        >
          Há dados rejeitados pelo Asaas. O titular precisa corrigir as
          pendências no fluxo de verificação do provedor.
        </p>
      )}
      {provider?.commercialInfoExpired && (
        <p
          role="alert"
          className="m-0 rounded-[14px] bg-admin-danger-wash p-4 text-sm leading-[1.55] text-admin-danger-ink"
        >
          Os dados comerciais estão expirados. Atualize ou confirme os dados com
          o Asaas.
        </p>
      )}
      {created &&
        context.incomingAvailable &&
        !receivingReady &&
        taskOwner &&
        setup?.consentRecorded &&
        !setup.pixConsentRecorded &&
        context.incomingGuard?.isCurrent() && (
          <section
            aria-label="Autorização para preparar o Pix"
            className={`${receivingCard} grid gap-3 p-6`}
          >
            <p className="m-0 text-sm leading-[1.55] text-admin-body">
              {receivingIncomingPixDisclosure.text}
            </p>
            <button
              type="button"
              className={receivingPrimaryAction}
              disabled={busy || !context.onAuthorizePix}
              onClick={context.onAuthorizePix}
            >
              Autorizar preparação automática do Pix
            </button>
          </section>
        )}

      {created && (
        <section className={`${receivingCard} flex gap-4 p-6`}>
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-admin-beige text-admin-graphite"
          >
            <Clock className="size-[18px]" />
          </span>
          <div className="grid gap-1">
            <h2 className="m-0 text-base font-bold text-admin-ink">
              {receivingReady
                ? "Recebimentos liberados"
                : "Depois: análise do Asaas"}
            </h2>
            <p className="m-0 text-[0.95rem] leading-[1.55] text-admin-body">
              {receivingReady
                ? "Recebimentos liberados. Você pode acompanhar os pagamentos e consultar a disponibilidade de saque."
                : "Quando as 3 tarefas estiverem feitas, o Asaas analisa a conta. Não é preciso fazer nada aqui; após a aprovação, o EntreLaços prepara automaticamente o recebimento por Pix."}
            </p>
          </div>
        </section>
      )}
    </StepFrame>
  );
}

export function AccountStep({ context }: { context: ReceivingStepsContext }) {
  const { setup, owner, status, busy } = context;
  const siteId = context.scope.siteId;
  return (
    <StepFrame
      siteId={siteId}
      steps={context.steps}
      current="account"
      aside={
        <>
          <AsideCard title="Duas chaves, dois papéis">
            <ul className="m-0 grid list-none gap-4 p-0">
              {(
                [
                  [
                    ArrowDown,
                    "Para receber",
                    "Uma chave aleatória criada por nós na sua conta Asaas. Você não precisa fazer nada.",
                    "bg-admin-beige text-admin-graphite",
                  ],
                  [
                    ArrowUp,
                    "Para sacar",
                    "A chave do seu banco, informada aqui. Ela só recebe os saques e não é levada para o Asaas.",
                    "bg-admin-terracotta-wash text-admin-terracotta-deep",
                  ],
                ] as const
              ).map(([Icon, title, text, tone]) => (
                <li key={title} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={`flex size-[34px] shrink-0 items-center justify-center rounded-lg ${tone}`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="grid gap-0.5 text-sm leading-[1.5]">
                    <strong className="text-admin-ink">{title}</strong>
                    <span className="text-admin-body">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </AsideCard>
          <FaqList
            items={[
              {
                question: "A chave precisa estar no meu nome?",
                answer: (
                  <p className="m-0">
                    O destino pode pertencer a outra pessoa. Confira o nome
                    completo, o documento e o banco retornados pelo Asaas antes
                    de confirmar.
                  </p>
                ),
              },
              {
                question: "Salvar a conta envia dinheiro?",
                answer: (
                  <p className="m-0">
                    Não. Salvar o destino não envia dinheiro. Cada casamento
                    mantém um destino Pix ativo; salvar uma alteração substitui
                    o anterior.
                  </p>
                ),
              },
            ]}
          />
        </>
      }
    >
      <section
        className={`${receivingCard} grid gap-6 p-8 [@media(max-width:760px)]:p-5`}
      >
        <StepHeading number={4} title="Para onde enviar seus saques?">
          <p className={receivingBody}>
            Informe uma chave Pix de uma conta bancária sua. Quando você sacar,
            o dinheiro dos presentes vai para lá.
          </p>
        </StepHeading>
        {setup &&
        (owner || setup.isHolder) &&
        setup.accountState === "CREATED" &&
        status === "ready" ? (
          <ReceivingPixDestination
            siteId={siteId}
            mode={setup.mode}
            guard={context.pixGuard}
            ports={context.ports}
            scope={context.scope}
            readOnly={owner}
          />
        ) : (
          <div className="grid gap-3">
            <p role="status" className={receivingBody}>
              {busy
                ? "Consultando a conta de recebimento…"
                : status === "unavailable"
                  ? "Não foi possível consultar a conta."
                  : setup?.holder && !setup.isHolder && !owner
                    ? `Somente ${setup.holder.name} pode configurar a conta para saque.`
                    : "Conclua a criação da conta em Seus dados para configurar o destino Pix."}
            </p>
            {setup?.accountState !== "CREATED" &&
              !busy &&
              status !== "unavailable" && (
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{ siteId, page: "details" }}
                  className={`${receivingLink} w-fit text-sm`}
                >
                  Ir para Seus dados
                </Link>
              )}
            {status === "unavailable" && (
              <Button
                variant="outline"
                className="w-fit"
                onClick={context.onRetry}
              >
                Tentar novamente
              </Button>
            )}
          </div>
        )}
      </section>
    </StepFrame>
  );
}

function FeesExample() {
  const controls = useGiftPricingControls();
  return (
    <GiftPricingPreview
      title="Exemplo: presente de R$ 200,00"
      nominalCents={20000}
      feeAllocation={
        controls?.pending ?? controls?.savedSettings?.feeAllocation ?? undefined
      }
    />
  );
}

function FeesConfirm({
  context,
  activationDone,
}: {
  context: ReceivingStepsContext;
  activationDone: boolean;
}) {
  const controls = useGiftPricingControls();
  const saved = controls?.savedSettings;
  const disabled =
    !controls || controls.busy || !saved || Boolean(controls.pending);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-admin-line pt-6">
      {context.feesChosen ? (
        <Link
          to="/sites/$siteId/receiving"
          params={{ siteId: context.scope.siteId }}
          className={receivingPrimaryAction}
        >
          Voltar para Recebimentos
        </Link>
      ) : (
        <button
          type="button"
          className={receivingPrimaryAction}
          disabled={disabled}
          onClick={() => {
            if (!controls || !saved) return;
            void controls.save(saved.feeAllocation).then((ok) => {
              if (!ok) return;
              toast.success("Preferência de taxas confirmada.");
              context.onFeesChosen?.();
            });
          }}
        >
          Concluir configuração
        </button>
      )}
      <p className="m-0 text-[0.82rem] text-admin-muted">
        {context.feesChosen
          ? activationDone
            ? "Etapa concluída."
            : "Etapa concluída. Falta só a aprovação do Asaas."
          : controls?.pending
            ? "Confirme ou cancele a mudança acima antes de concluir."
            : activationDone
              ? "Confirma a escolha de quem paga as taxas."
              : "Falta só a aprovação do Asaas para liberar os recebimentos."}
      </p>
    </div>
  );
}

function GiftListPreview({
  siteId,
  eligible,
}: {
  siteId: string;
  eligible: boolean;
}) {
  const [gifts, setGifts] = useState<GiftItem[] | null>(null);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void new GiftCatalogClient(siteId)
      .list()
      .then((value) => {
        if (active) setGifts(value);
      })
      .catch(() => {
        if (active) setGifts([]);
      });
    return () => {
      active = false;
    };
  }, [siteId, eligible]);
  const visible = (gifts ?? [])
    .filter((gift) => gift.publicationState !== "ARCHIVED")
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .slice(0, 3);
  return (
    <section
      className={`${receivingCard} grid gap-5 p-8 [@media(max-width:760px)]:p-5`}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-xl gap-1.5">
          <h2 className="m-0 font-admin-display text-[1.75rem] leading-[1.15] font-normal text-admin-ink">
            Sua lista de presentes
          </h2>
          <p className="m-0 text-sm leading-[1.5] text-admin-body">
            {eligible
              ? "Monte e ajuste à vontade. Os presentes publicados aparecem para os convidados."
              : "A lista é liberada para montar quando o Asaas aprovar a conta."}
          </p>
        </div>
        {!eligible && (
          <StatusBadge status="review">Liberada após a aprovação</StatusBadge>
        )}
      </div>
      {eligible && (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4 p-0">
          {visible.map((gift) => (
            <li
              key={gift.id}
              className="grid min-w-0 overflow-hidden rounded-[14px] border border-admin-line bg-admin-surface"
            >
              <span
                aria-hidden="true"
                className="flex h-[110px] items-center justify-center bg-admin-beige"
              >
                <Gift className="size-7 text-admin-terracotta-deep" />
              </span>
              <span className="grid gap-1 p-4">
                <strong className="break-words text-[0.95rem] text-admin-ink">
                  {gift.title}
                </strong>
                <span className="text-sm text-admin-body">
                  {money(gift.nominalCents)}
                </span>
              </span>
            </li>
          ))}
          <li className="min-w-0">
            <Link
              to="/sites/$siteId/gifts"
              params={{ siteId }}
              className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-admin-line-strong p-4 text-center font-bold text-admin-terracotta-deep no-underline hover:bg-admin-canvas"
            >
              <Plus aria-hidden="true" className="size-6" />
              {gifts?.length ? "Ver a lista completa" : "Adicionar presente"}
            </Link>
          </li>
        </ul>
      )}
    </section>
  );
}

export function FeesStep({
  context,
  pricingEnabled,
}: {
  context: ReceivingStepsContext;
  pricingEnabled: boolean;
}) {
  const siteId = context.scope.siteId;
  const epoch = context.scope.sessionEpoch;
  const activationDone =
    context.steps.find(({ id }) => id === "activation")?.status === "done";
  const [request] = useState(
    () =>
      (
        path: string,
        options?: { method?: string; body?: unknown; signal?: AbortSignal },
      ) =>
        apiRequest(path, { method: options?.method, body: options?.body }),
  );
  const [isCurrent] = useState(
    () => () => epoch !== null && isCurrentPanelSessionEpoch(epoch),
  );
  return (
    <StepFrame siteId={siteId} steps={context.steps} current="fees">
      <GiftPricingSettings
        enabled={pricingEnabled}
        siteId={siteId}
        request={request}
        isCurrent={isCurrent}
        gifts={[]}
      >
        <section
          className={`${receivingCard} grid gap-6 p-8 [@media(max-width:760px)]:p-5`}
        >
          <StepHeading number={5} title="Quem paga as taxas dos presentes?">
            <p className={receivingBody}>
              Vale para todos os presentes. Você pode mudar depois em Presentes.
            </p>
          </StepHeading>
          {pricingEnabled ? (
            <>
              <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
                <GiftFeeAllocationChooser />
                <FeesExample />
              </div>
              <FeesConfirm context={context} activationDone={activationDone} />
            </>
          ) : (
            <p role="status" className={receivingBody}>
              Somente quem administra o catálogo e as finanças deste casamento
              pode escolher quem paga as taxas.
            </p>
          )}
        </section>
      </GiftPricingSettings>
      <GiftListPreview
        siteId={siteId}
        eligible={!!context.readiness?.catalogEligible}
      />
    </StepFrame>
  );
}

export type ReceivingStepSection = "overview" | ReceivingStepId;
