import {
  GIFT_PLATFORM_TARIFFS,
  type GiftItem,
  RECEIVING_HOLDER_NAME_MAX_LENGTH,
  type ReceivingReadiness,
  type ReceivingSetupContext,
  receivingSetupAccountSchema,
  suggestReceivingHolderName,
} from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { Check, Clock, Gift, Plus, RefreshCw, Smartphone } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { apiRequest } from "../lib/apiClient";
import { AdminButton } from "./AdminButton";
import { brazilianBanks, otherBankValue } from "./brazilianBanks";
import {
  FinancialReauthenticationForm,
  type FinancialReauthenticationHandle,
} from "./FinancialReauthenticationForm";
import type { FinancialReauthenticationGuard } from "./financialReauthenticationClient";
import {
  GiftPricingPreview,
  GiftPricingSettings,
  giftFeeExplanation,
  money,
  useGiftPricingPreview,
} from "./GiftPricingSettings";
import { GiftCatalogClient } from "./giftCatalogClient";
import { isCurrentPanelSessionEpoch } from "./panelActor";
import { ReceivingIdentityVerification } from "./ReceivingIdentityVerification";
import type {
  ReceivingSetupPorts,
  ReceivingSetupScope,
} from "./ReceivingSetup";
import {
  type LabeledProviderRejection,
  rejectionFieldErrors,
} from "./receivingProviderRejection";
import {
  accountFieldErrors,
  normalizeSetupAccount,
  parseAccount,
  type ReceivingFormField,
} from "./receivingSetupForm";
import {
  deriveReceivingTasks,
  identityStage,
  kycStatusLabel,
  type ReceivingTaskStatus,
  recipientStatusLabel,
} from "./receivingTasks";
import type { ReceivingStepId, ReceivingTrackStep } from "./receivingTrack";
import {
  AsideCard,
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
  "mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20os%20recebimentos";

export type ReceivingStepsContext = {
  scope: ReceivingSetupScope;
  setup: ReceivingSetupContext | null;
  status: "loading" | "ready" | "submitting" | "denied" | "unavailable";
  busy: boolean;
  owner: boolean;
  /** The owner, or a site administrator allowed to fill the empty slot. */
  canDesignate?: boolean;
  canSubmit: boolean;
  receivingReady: boolean;
  readiness: ReceivingReadiness | null;
  steps: ReceivingTrackStep[];
  next: ReceivingTrackStep | null;
  completed: number;
  guard?: FinancialReauthenticationGuard;
  incomingGuard?: FinancialReauthenticationGuard;
  /** Guards a site administrator's password proof for the designation. */
  designateGuard?: FinancialReauthenticationGuard;
  ports?: ReceivingSetupPorts;
  form?: RefObject<HTMLFormElement | null>;
  incomingAvailable: boolean;
  onRetry?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onDesignate?: (
    holderUserId: string,
    reauthenticationToken?: string | null,
  ) => void;
  onVerifyIncoming?: () => void;
  /** "Verificar situação" consults Pagar.me; set only for the holder. */
  onReconcile?: () => void;
  /** Pagar.me's refusal of the last submit; the form keeps its data. */
  rejection?: LabeledProviderRejection | null;
  /** What the last verification found; "released" reopens the form. */
  verification?: { outcome: "released" | "unknown"; text: string } | null;
  /** The holder's own submit is in flight: the form stays with its data. */
  sending?: boolean;
};

const lastCheckFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function LastCheck({ setup }: { setup: ReceivingSetupContext | null }) {
  const observedAt = setup?.providerStatus?.observedAt;
  return (
    <p className="m-0 flex items-center gap-2 text-[0.82rem] text-admin-text-secondary">
      <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
      {observedAt ? (
        <span>
          Última consulta à Pagar.me em{" "}
          <time dateTime={observedAt}>
            {lastCheckFormatter.format(new Date(observedAt))}
          </time>
        </span>
      ) : (
        <span>Ainda sem consulta à Pagar.me</span>
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
          ? "Atualizando a liberação dos recebimentos…"
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
        <AdminButton
          tone="secondary"
          className="w-fit"
          disabled={!context.onRetry}
          onClick={context.onRetry}
        >
          Tentar novamente
        </AdminButton>
      </div>
    );
  return null;
}

function SandboxNotice({ mode }: { mode: string | null | undefined }) {
  return showSandboxNotice(mode) ? (
    <p className="m-0 rounded-[10px] bg-admin-pending-subtle p-3 text-sm text-admin-pending-text">
      Ambiente de teste da Pagar.me, sem movimentação de dinheiro real.
    </p>
  ) : null;
}

function nextCopy(context: ReceivingStepsContext) {
  const { next, setup, owner } = context;
  const holderName = setup?.holder?.name ?? "O titular";
  const canDesignate = owner || !!context.canDesignate;
  switch (next?.id) {
    case "holder":
      return {
        text: canDesignate
          ? "Escolha qual dos noivos será titular do recebedor e dos saques."
          : "Os administradores do casamento escolhem quem dos noivos será titular do recebedor. Depois disso, o titular preenche os dados.",
        action: canDesignate ? "Escolher titular" : "Ver etapa",
      };
    case "details":
      return next.status === "attention"
        ? {
            text: "Não sabemos se o cadastro foi criado. Verifique a situação antes de tentar de novo.",
            action: "Verificar situação",
          }
        : {
            text: setup?.isHolder
              ? "Preencha seus dados para cadastrarmos você como recebedor na Pagar.me, no seu nome."
              : `${holderName} precisa preencher os dados para o cadastro na Pagar.me.`,
            action: setup?.isHolder ? "Preencher meus dados" : "Ver etapa",
          };
    case "activation":
      switch (identityStage(setup?.providerStatus)) {
        case "initial_analysis":
          return {
            text: "Cadastro criado. A Pagar.me faz uma análise inicial, que pode levar até 24 horas. Quando ela pedir a selfie e a foto do documento, a verificação de identidade é liberada nesta etapa.",
            action: "Acompanhar análise",
          };
        case "documents_review":
          return {
            text: "A Pagar.me está analisando o documento e a selfie. Não há nada a fazer aqui agora.",
            action: "Acompanhar análise",
          };
        case "refused":
          return {
            text: "A Pagar.me recusou a verificação de identidade. Fale com o suporte para entender os próximos passos.",
            action: "Ver detalhes",
          };
        case "blocked":
          return {
            text: "A Pagar.me bloqueou ou suspendeu o recebedor. Fale com o suporte para entender o que ajustar.",
            action: "Ver o que ajustar",
          };
        default:
          return {
            text: "A Pagar.me pediu a foto de um documento e uma selfie para confirmar que você é o titular.",
            action: "Verificar identidade",
          };
      }
    case "fees":
      return {
        text: "Veja como o convidado paga as taxas e você recebe 100% do presente.",
        action: "Entender as taxas",
      };
    default:
      return null;
  }
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
      step.id === "fees" &&
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
            ? "Enquanto a Pagar.me analisa"
            : "Já pode adiantar"
        }
      >
        <p className="m-0 text-sm leading-[1.55]">
          Você não precisa esperar a aprovação para adiantar esta etapa.
        </p>
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {pending.map((step) => (
            <li key={step.id}>
              <Link
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: step.id }}
                className="font-semibold text-admin-accent-hover underline underline-offset-4"
              >
                {step.number} · Entender as taxas dos presentes
              </Link>
            </li>
          ))}
        </ul>
      </AsideCard>
    </div>
  );
}

const withdrawalFee = money(GIFT_PLATFORM_TARIFFS.withdrawalFeeCents);
const moneyPath = [
  "O convidado escolhe um presente no site e paga por Pix ou cartão.",
  "A Pagar.me processa o pagamento e guarda o valor no recebedor cadastrado no seu nome.",
  `Você saca aqui no EntreLaços para a conta bancária do seu CPF. Cada saque tem tarifa de ${withdrawalFee}.`,
];

const commonQuestions = [
  {
    question: "Por que o cadastro é feito na Pagar.me?",
    answer: (
      <p className="m-0">
        A Pagar.me, uma empresa Stone, é a instituição de pagamento que recebe
        os presentes e guarda os valores no nome do titular. O EntreLaços
        organiza a lista e os pedidos de saque, mas não guarda o dinheiro.
      </p>
    ),
  },
  {
    question: "O EntreLaços vê meus documentos?",
    answer: (
      <p className="m-0">
        Não. A foto do documento e a selfie vão direto para a Pagar.me, pelo
        link de verificação. O EntreLaços só recebe a situação do cadastro.
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
  const copy = nextCopy(context);
  return (
    <div className="grid min-w-0 gap-6">
      <header className="grid gap-1.5">
        <h1 className={receivingStepTitle}>Recebimentos</h1>
        <p className="m-0 text-base leading-[1.6] text-admin-text-secondary">
          Configure uma vez para receber os presentes em dinheiro e sacar para o
          seu banco.
        </p>
      </header>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-5">
          <SetupStatus context={context} />
          <section className={`${receivingCard} grid gap-3 px-6 py-[22px]`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="m-0 text-base font-bold text-admin-text">
                Configuração dos recebimentos
              </h2>
              <p className="m-0 text-sm text-admin-text-secondary">
                {completed} de {steps.length} concluídas
              </p>
            </div>
            <ProgressBar completed={completed} />
          </section>
          {next && copy && (
            <section
              aria-labelledby="receiving-next-step"
              className="grid min-w-0 gap-3.5 rounded-2xl border-2 border-admin-accent bg-admin-surface p-7 [@media(max-width:760px)]:p-5"
            >
              <p className={receivingEyebrow}>
                Próximo passo · Etapa {next.number} de {steps.length}
              </p>
              <h2
                id="receiving-next-step"
                className="m-0 font-admin-display text-[1.75rem] leading-[1.15] font-normal text-admin-text"
              >
                {next.title}
              </h2>
              <p className={receivingBody}>{copy.text}</p>
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
              className="m-0 px-6 pt-4 pb-2 text-sm font-bold uppercase tracking-[0.06em] text-admin-text-secondary"
            >
              As {steps.length} etapas
            </h2>
            <ol className="m-0 list-none p-0">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className="flex gap-4 border-t border-admin-subtle px-6 py-4 [@media(max-width:760px)]:px-4"
                >
                  <StepIndicator number={step.number} status={step.status} />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <h3 className="m-0 text-base font-bold text-admin-text">
                        {step.status === "locked" ? (
                          step.title
                        ) : (
                          <Link
                            to="/sites/$siteId/receiving/$page"
                            params={{ siteId, page: step.id }}
                            className="text-admin-text no-underline hover:underline"
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
                    <p className="m-0 text-sm leading-[1.5] text-admin-text-secondary">
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
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-admin-subtle text-[0.8rem] font-bold text-admin-text"
                  >
                    {index + 1}
                  </span>
                  <span className="text-sm leading-[1.5] text-admin-text">
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
  const canDesignate = owner || !!context.canDesignate;
  const candidates = !!setup?.holderCandidates?.length;
  const authentication = useRef<FinancialReauthenticationHandle | null>(null);
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
                  O recebedor na Pagar.me é cadastrado no CPF de uma pessoa, que
                  verifica a identidade e faz os saques. Os dois continuam
                  administrando o casamento normalmente.
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
            Um dos noivos é o titular do recebedor na Pagar.me e dos saques. A
            permissão de administrar o casamento não define quem recebe.
          </p>
        </StepHeading>
        <SetupStatus context={context} />
        {setup?.holder && (
          <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-admin-canvas p-4">
            <p className="m-0 text-[0.95rem] text-admin-text">
              Titular dos recebimentos: <strong>{setup.holder.name}</strong>
            </p>
            <StatusBadge status="done" />
          </div>
        )}
        {setup && !setup.holder && !canDesignate && (
          <p className={receivingBody}>
            O titular dos recebimentos ainda não foi designado. Os
            administradores do casamento escolhem quem dos noivos será o
            titular.
          </p>
        )}
        {setup && !setup.holder && canDesignate && (
          <>
            <form
              id={`${id}-designation`}
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get(
                  "holderUserId",
                );
                if (typeof value !== "string") return;
                context.onDesignate?.(
                  value,
                  owner
                    ? undefined
                    : (authentication.current?.consumeProof() ?? null),
                );
              }}
              className="grid gap-3"
            >
              <label
                htmlFor={`${id}-holder`}
                className="text-sm font-bold text-admin-text"
              >
                Conta do titular neste casamento
              </label>
              <select
                id={`${id}-holder`}
                name="holderUserId"
                required
                disabled={busy || !candidates}
                className={receivingField}
              >
                <option value="">Selecione o titular</option>
                {setup.holderCandidates?.map((candidate) => (
                  <option key={candidate.userId} value={candidate.userId}>
                    {candidate.name} ({candidate.email})
                  </option>
                ))}
              </select>
              {!candidates && (
                <p className="m-0 text-sm text-admin-text-secondary">
                  Nenhuma conta ativa administra este casamento ainda. Convide o
                  titular como administrador antes de designá-lo.
                </p>
              )}
              <p className="m-0 text-sm text-admin-text-secondary">
                {owner
                  ? "A conta deve estar ativa e administrar este casamento. A designação será fixa; confirme a identidade antes de salvar."
                  : "Pode ser você ou a outra pessoa que administra o casamento. A designação fica fixa depois de salva."}
              </p>
            </form>
            {!owner && (
              <FinancialReauthenticationForm
                siteId={context.scope.siteId}
                access={context.scope.access}
                sessionEpoch={context.scope.sessionEpoch}
                action="CONFIGURE_RECEIVING"
                guard={context.designateGuard}
                request={context.ports?.request}
                now={context.ports?.now}
                hint="Confirme sua senha para designar o titular. Esta etapa não envia dinheiro."
                ref={authentication}
              />
            )}
            <button
              type="submit"
              form={`${id}-designation`}
              className={receivingPrimaryAction}
              disabled={busy || !context.onDesignate || !candidates}
            >
              Designar titular
            </button>
          </>
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

type DetailFieldSpec = {
  name: string;
  label: string;
  type: string;
  placeholder?: string;
  hint?: string;
  inputMode?: "numeric" | "decimal" | "tel" | "email";
  autoComplete?: string;
  wide?: boolean;
  optional?: boolean;
  maxLength?: number;
  // Native validation keeps the error on the visible field; the contract
  // schema still validates the normalized account on submit.
  pattern?: string;
  title?: string;
  options?: readonly { value: string; label: string }[];
};

const detailFields: DetailFieldSpec[] = [
  {
    name: "name",
    label: "Nome completo do titular",
    type: "text",
    hint: "Igual ao documento de identidade.",
    autoComplete: "name",
    wide: true,
  },
  {
    name: "cpf",
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
    autoComplete: "email",
  },
  {
    name: "mobilePhone",
    label: "Celular com DDD",
    type: "tel",
    placeholder: "(11) 90000-0000",
    inputMode: "tel",
    autoComplete: "tel-national",
  },
  {
    name: "monthlyIncome",
    label: "Renda mensal aproximada",
    type: "text",
    placeholder: "R$ 0,00",
    hint: "Exigida pela Pagar.me para cadastrar o recebedor.",
    inputMode: "decimal",
  },
  {
    name: "professionalOccupation",
    label: "Profissão",
    type: "text",
    autoComplete: "organization-title",
  },
  {
    name: "zipCode",
    label: "CEP",
    type: "text",
    placeholder: "00000-000",
    inputMode: "numeric",
    autoComplete: "postal-code",
  },
  {
    name: "street",
    label: "Endereço",
    type: "text",
    placeholder: "Rua, avenida…",
    autoComplete: "address-line1",
    wide: true,
  },
  { name: "streetNumber", label: "Número", type: "text" },
  {
    name: "complement",
    label: "Complemento (opcional)",
    type: "text",
    autoComplete: "address-line2",
    optional: true,
  },
  { name: "neighborhood", label: "Bairro", type: "text" },
  {
    name: "city",
    label: "Cidade",
    type: "text",
    autoComplete: "address-level2",
  },
  {
    name: "state",
    label: "Estado (UF)",
    type: "text",
    placeholder: "SP",
    autoComplete: "address-level1",
    maxLength: 2,
  },
  {
    name: "referencePoint",
    label: "Ponto de referência (opcional)",
    type: "text",
    wide: true,
    optional: true,
  },
];

const accountTypeField: DetailFieldSpec = {
  name: "accountType",
  label: "Tipo de conta",
  type: "select",
  options: [
    { value: "checking", label: "Conta corrente" },
    { value: "savings", label: "Conta poupança" },
  ],
};

const bankCodeField: DetailFieldSpec = {
  name: "bankCode",
  label: "Código do banco",
  type: "text",
  placeholder: "000",
  hint: "3 dígitos. Se o app mostrar 4, como 0260, pode digitar assim.",
  inputMode: "numeric",
  maxLength: 4,
  pattern: "\\s*0?\\d{3}\\s*",
  title: "Use 3 dígitos, ou 4 começando com 0.",
};

const branchField: DetailFieldSpec = {
  name: "branch",
  label: "Agência",
  type: "text",
  placeholder: "0001",
  hint: "Se tiver dígito, use hífen: 1234-5.",
  inputMode: "numeric",
  maxLength: 8,
  pattern: "\\s*\\d{1,4}(-\\d)?\\s*",
  title: "Até 4 números; dígito opcional depois do hífen, como 1234-5.",
};

const accountField: DetailFieldSpec = {
  name: "account",
  label: "Conta com dígito",
  type: "text",
  placeholder: "12345-6",
  maxLength: 20,
  pattern: "[\\s.]*\\d[\\d\\s.]*-?[\\s.]*[0-9Xx][\\s.]*",
  title: "Número da conta seguido do dígito, como 12345-6.",
};

const holderNameField: DetailFieldSpec = {
  name: "holderName",
  label: `Nome do titular da conta (como está no banco, até ${RECEIVING_HOLDER_NAME_MAX_LENGTH} caracteres)`,
  type: "text",
  hint: "Sugerimos a partir do nome completo; ajuste se o banco abrevia diferente.",
  wide: true,
};

function DetailFieldInput({
  id,
  field,
  busy,
  onChange,
  describedBy,
  defaultValue,
  value,
  error,
}: {
  id: string;
  field: DetailFieldSpec;
  busy: boolean;
  onChange?: (value: string) => void;
  describedBy?: string;
  defaultValue?: string;
  value?: string;
  error?: string;
}) {
  const fieldId = `${id}-${field.name}`;
  const described =
    [
      describedBy ?? (field.hint ? `${fieldId}-hint` : undefined),
      error ? `${fieldId}-error` : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return field.options ? (
    <select
      id={fieldId}
      name={field.name}
      required
      disabled={busy}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${fieldId}-error` : undefined}
      className={`${receivingField} ${invalidField}`}
    >
      {field.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ) : (
    <input
      id={fieldId}
      name={field.name}
      type={field.type}
      required={!field.optional}
      disabled={busy}
      placeholder={field.placeholder}
      defaultValue={value === undefined ? defaultValue : undefined}
      value={value}
      inputMode={field.inputMode}
      maxLength={field.maxLength}
      pattern={field.pattern}
      title={field.title}
      autoComplete={field.autoComplete ?? "off"}
      aria-invalid={error ? true : undefined}
      aria-describedby={described}
      onChange={onChange && ((event) => onChange(event.currentTarget.value))}
      className={`${receivingField} ${invalidField}`}
    />
  );
}

const invalidField =
  "aria-[invalid=true]:border-admin-danger aria-[invalid=true]:bg-admin-danger-subtle";

/** Why the input is refused, in pt-BR: before sending or from Pagar.me. */
function FieldError({
  id,
  name,
  error,
}: {
  id: string;
  name: string;
  error?: string;
}) {
  return error ? (
    <p
      id={`${id}-${name}-error`}
      className="m-0 text-[0.8rem] font-bold leading-[1.4] text-admin-danger-text"
    >
      {error}
    </p>
  ) : null;
}

function FieldLabel({ id, field }: { id: string; field: DetailFieldSpec }) {
  return (
    <label
      htmlFor={`${id}-${field.name}`}
      className="text-sm font-bold text-admin-text"
    >
      {field.label}
    </label>
  );
}

function FieldHint({
  id,
  name,
  hint,
}: {
  id: string;
  name: string;
  hint?: string;
}) {
  return hint ? (
    <p
      id={`${id}-${name}-hint`}
      className="m-0 text-[0.8rem] leading-[1.4] text-admin-text-secondary"
    >
      {hint}
    </p>
  ) : null;
}

/** Marks a field the holder must type again: it is never stored. */
function ReentryNote() {
  return (
    <p className="m-0 text-[0.8rem] font-bold leading-[1.4] text-admin-danger-text">
      Não guardamos este dado. Preencha de novo.
    </p>
  );
}

function DetailField({
  id,
  field,
  busy,
  reentry = false,
  defaultValue,
  value,
  onChange,
  error,
}: {
  id: string;
  field: DetailFieldSpec;
  busy: boolean;
  reentry?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  error?: string;
}) {
  return (
    <div
      data-reentry={reentry ? "" : undefined}
      className={`grid min-w-0 content-start gap-1.5 ${field.wide ? "sm:col-span-2" : ""}`}
    >
      <FieldLabel id={id} field={field} />
      <DetailFieldInput
        id={id}
        field={field}
        busy={busy}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange}
        error={error}
      />
      <FieldHint id={id} name={field.name} hint={field.hint} />
      <FieldError id={id} name={field.name} error={error} />
      {reentry && <ReentryNote />}
    </div>
  );
}

// Banco, tipo, agência e conta. The admin normalizer splits branch and
// account check digits into the unchanged contract fields.
function BankAccountFields({
  id,
  busy,
  reentry = false,
  errors,
  holderName,
}: {
  id: string;
  busy: boolean;
  reentry?: boolean;
  errors: Partial<Record<ReceivingFormField, string>>;
  holderName: {
    value: string;
    onChange: (value: string) => void;
    reentry: boolean;
  };
}) {
  const [otherBank, setOtherBank] = useState(false);
  const [account, setAccount] = useState("");
  const parsedAccount = parseAccount(account);
  const bankHintId = `${id}-bank-hint`;
  const marked = reentry ? "" : undefined;
  return (
    <>
      <div data-reentry={marked} className="grid min-w-0 content-start gap-1.5">
        <label
          htmlFor={`${id}-bank`}
          className="text-sm font-bold text-admin-text"
        >
          Banco
        </label>
        <select
          id={`${id}-bank`}
          name="bank"
          required
          disabled={busy}
          aria-invalid={errors.bank ? true : undefined}
          aria-describedby={
            errors.bank ? `${bankHintId} ${id}-bank-error` : bankHintId
          }
          onChange={(event) =>
            setOtherBank(event.currentTarget.value === otherBankValue)
          }
          className={`${receivingField} ${invalidField}`}
        >
          <option value="">Selecione o banco</option>
          {brazilianBanks.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.label}
            </option>
          ))}
          <option value={otherBankValue}>Outro banco</option>
        </select>
        <FieldHint
          id={id}
          name="bank"
          hint="A conta precisa estar no CPF informado acima; os saques vão para ela."
        />
        <FieldError id={id} name="bank" error={errors.bank} />
        {reentry && <ReentryNote />}
        {otherBank && (
          <div className="mt-2 grid gap-1.5">
            <FieldLabel id={id} field={bankCodeField} />
            <DetailFieldInput id={id} field={bankCodeField} busy={busy} />
            <FieldHint id={id} name="bankCode" hint={bankCodeField.hint} />
          </div>
        )}
      </div>
      <DetailField
        id={id}
        field={accountTypeField}
        busy={busy}
        reentry={reentry}
        error={errors.accountType}
      />
      <DetailField
        id={id}
        field={branchField}
        busy={busy}
        reentry={reentry}
        error={errors.branch}
      />
      <div data-reentry={marked} className="grid min-w-0 content-start gap-1.5">
        <FieldLabel id={id} field={accountField} />
        <DetailFieldInput
          id={id}
          field={accountField}
          busy={busy}
          onChange={setAccount}
          describedBy={`${id}-account-hint`}
          error={errors.account}
        />
        <p
          id={`${id}-account-hint`}
          aria-live="polite"
          className="m-0 min-h-[1.12rem] text-[0.8rem] leading-[1.4] text-admin-text-secondary"
        >
          {parsedAccount &&
            `Conta ${parsedAccount.accountNumber}, dígito ${parsedAccount.accountCheckDigit}`}
        </p>
        <FieldError id={id} name="account" error={errors.account} />
        {reentry && <ReentryNote />}
      </div>
      <DetailField
        id={id}
        field={holderNameField}
        busy={busy}
        reentry={holderName.reentry}
        value={holderName.value}
        onChange={holderName.onChange}
        error={errors.holderName}
      />
    </>
  );
}

const nextSteps = [
  {
    icon: Smartphone,
    title: "Verificação de identidade",
    text: "Na Pagar.me: foto do documento e selfie, por um link seguro.",
  },
  {
    icon: Clock,
    title: "Análise da Pagar.me",
    text: "A Pagar.me analisa o cadastro. Acompanhe a situação aqui em Recebimentos.",
  },
];

export function DetailsStep({ context }: { context: ReceivingStepsContext }) {
  const id = useId();
  const [resetCount, setResetCount] = useState(0);
  const { setup, busy, canSubmit, owner } = context;
  const siteId = context.scope.siteId;
  // After a verification proved Pagar.me never received the registration,
  // only the holder's name is stored to fill in again.
  const reopened = canSubmit && context.verification?.outcome === "released";
  const verifySituation = context.onReconcile ?? context.onRetry;
  // The saved name a release reopened the form with; kept after a resend
  // clears the verification, so neither the name nor its suggestion vanish.
  const [savedName, setSavedName] = useState<string | undefined>();
  const reopenedName = reopened ? setup?.holder?.name : undefined;
  if (reopenedName && reopenedName !== savedName) setSavedName(reopenedName);
  // The bank holder name follows the full name until the holder edits it.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [typedHolderName, setTypedHolderName] = useState<string | null>(null);
  const holderName =
    typedHolderName ?? suggestReceivingHolderName(typedName ?? savedName ?? "");
  const [inputErrors, setInputErrors] = useState<
    Partial<Record<ReceivingFormField, string>>
  >({});
  // Pagar.me's refusal points at inputs; what was checked here comes first.
  const rejection = canSubmit ? context.rejection : null;
  const errors = {
    ...(rejection ? rejectionFieldErrors(rejection) : {}),
    ...inputErrors,
  };
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
                    className="mt-0.5 size-[18px] shrink-0 text-admin-accent-hover"
                  />
                  <span className="grid gap-0.5 text-sm leading-[1.5]">
                    <strong className="text-admin-text">{title}</strong>
                    <span className="text-admin-text">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </AsideCard>
          <AsideCard title="Seus dados ficam seguros">
            <p className="m-0 text-sm leading-[1.6] text-admin-text">
              Os dados vão direto para a Pagar.me, a instituição de pagamento
              que processa os presentes e repassa os valores para a sua conta
              bancária.
            </p>
          </AsideCard>
          <FaqList
            items={[
              {
                question: "Por que a Pagar.me pede renda e endereço?",
                answer: (
                  <p className="m-0">
                    São exigências da Pagar.me para cadastrar qualquer recebedor
                    e verificar a identidade do titular.
                  </p>
                ),
              },
              {
                question: "O que eu autorizo ao continuar?",
                answer: (
                  <p className="m-0">
                    O cadastro como recebedor na Pagar.me, no seu nome e com a
                    sua conta bancária. O aceite fica registrado com a versão do
                    termo.
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
        <StepHeading number={2} title="Seus dados de recebedor">
          <p className={receivingBody}>
            Usamos esses dados uma única vez para o cadastro na Pagar.me
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
              Somente o titular designado pode consentir e enviar o cadastro à
              Pagar.me. Administrar o casamento não autoriza abrir uma conta em
              nome de outra pessoa.
            </p>
          )}
        {setup?.accountState === "UNKNOWN" && (
          <div className="grid gap-3 rounded-[14px] bg-admin-danger-subtle p-4 text-admin-danger-text">
            <p role="alert" className="m-0 text-sm leading-[1.55]">
              {canSubmit
                ? "O resultado do envio anterior está incerto. Envie o cadastro de novo: antes de criar outro, consultamos a Pagar.me para não duplicar."
                : context.onReconcile
                  ? "Não sabemos se a Pagar.me recebeu seu cadastro. Use Verificar situação: só consultamos a Pagar.me, sem criar outro cadastro."
                  : "O resultado da criação está incerto. Verifique a conta existente antes de repetir qualquer criação."}
            </p>
            {context.verification?.outcome === "unknown" && (
              <p role="status" className="m-0 text-sm font-bold leading-[1.55]">
                {context.verification.text}
              </p>
            )}
          </div>
        )}
        {reopened && context.verification && (
          <div className="grid gap-2 rounded-[14px] bg-admin-pending-subtle p-4 text-admin-pending-text">
            <p role="alert" className="m-0 text-sm font-bold leading-[1.55]">
              {context.verification.text}
            </p>
          </div>
        )}
        {rejection && (
          <div className="grid gap-2 rounded-[14px] bg-admin-danger-subtle p-4 text-admin-danger-text">
            <p role="alert" className="m-0 text-sm font-bold leading-[1.55]">
              A Pagar.me recusou o cadastro. Corrija os dados indicados e envie
              novamente.
            </p>
            {rejection.fields.length > 0 && (
              <ul className="m-0 grid list-disc gap-1 pl-5 text-sm leading-[1.55]">
                {rejection.fields.map((field) => (
                  <li key={field.field}>
                    <strong>{field.label}</strong>
                    {field.messages.length > 0 &&
                      `: ${field.messages.join(" ")}`}
                  </li>
                ))}
              </ul>
            )}
            {rejection.message && (
              <p className="m-0 text-sm leading-[1.55]">{rejection.message}</p>
            )}
          </div>
        )}
        {setup?.accountState === "PENDING" && !canSubmit && (
          <p role="status" className={receivingBody}>
            Estamos enviando seu cadastro à Pagar.me. Verifique a situação em
            instantes.
          </p>
        )}
        {setup?.accountState === "CREATED" && (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-admin-canvas p-4">
              <p role="status" className="m-0 text-[0.95rem] text-admin-text">
                Cadastro criado na Pagar.me
                {setup.holder ? ` em nome de ${setup.holder.name}` : ""}.
              </p>
              <StatusBadge status="done" />
            </div>
            <Link
              to="/sites/$siteId/receiving/$page"
              params={{ siteId, page: "activation" }}
              className={receivingPrimaryAction}
            >
              Ir para a verificação de identidade
            </Link>
          </div>
        )}
        {(canSubmit || context.sending) && setup && (
          <form
            ref={context.form}
            onSubmit={(event) => {
              // The contract that the API applies, checked before sending.
              const checked = receivingSetupAccountSchema.safeParse(
                normalizeSetupAccount(
                  Object.fromEntries(new FormData(event.currentTarget)),
                ),
              );
              const found = checked.success
                ? {}
                : accountFieldErrors(checked.error.issues);
              setInputErrors(found);
              const first = Object.keys(found)[0];
              if (first) {
                event.preventDefault();
                event.currentTarget
                  .querySelector<HTMLElement>(`[name="${first}"]`)
                  ?.focus();
                return;
              }
              context.onSubmit?.(event);
            }}
            onInput={(event) => {
              const name = (event.target as HTMLInputElement).name;
              if (name in inputErrors)
                setInputErrors(
                  ({ [name as ReceivingFormField]: _, ...rest }) => rest,
                );
            }}
            // Remount the bank fields so their local state follows reset().
            onReset={() => {
              setResetCount((count) => count + 1);
              setTypedName(null);
              setTypedHolderName(null);
              setInputErrors({});
            }}
            className="grid gap-6"
            autoComplete="off"
          >
            <div className="grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
              {detailFields.map((field) => (
                <DetailField
                  key={field.name}
                  id={id}
                  field={field}
                  busy={busy}
                  reentry={reopened && field.name !== "name"}
                  defaultValue={field.name === "name" ? savedName : undefined}
                  onChange={field.name === "name" ? setTypedName : undefined}
                  error={errors[field.name as ReceivingFormField]}
                />
              ))}
              <BankAccountFields
                key={resetCount}
                id={id}
                busy={busy}
                reentry={reopened}
                errors={errors}
                holderName={{
                  value: holderName,
                  onChange: setTypedHolderName,
                  reentry: reopened && !holderName,
                }}
              />
            </div>
            <fieldset className="m-0 grid min-w-0 gap-3 rounded-[14px] border border-admin-border bg-admin-canvas p-5">
              <legend className="sr-only">Autorizações</legend>
              <p className="m-0 text-[0.95rem] font-bold text-admin-text">
                Ao continuar, você autoriza
              </p>
              <ul className="m-0 grid list-disc gap-2 pl-5 text-sm leading-[1.55] text-admin-text">
                <li>
                  Cadastrar você como recebedor na Pagar.me, no seu nome, e
                  verificar sua identidade.
                </li>
                <li>
                  Usar a conta bancária informada como destino dos repasses.
                </li>
              </ul>
              <details>
                <summary
                  className={`${receivingLink} w-fit cursor-pointer text-sm`}
                >
                  Ler o termo completo
                </summary>
                <div className="mt-3 grid gap-2 text-sm leading-[1.6] text-admin-text">
                  <p className="m-0">
                    {showSandboxNotice(setup.mode)
                      ? setup.disclosure.text
                      : setup.disclosure.text.split(" Em teste,")[0]}
                  </p>
                </div>
              </details>
              <label className="mt-1 flex cursor-pointer items-start gap-3 text-[0.95rem] text-admin-text">
                <input
                  type="checkbox"
                  name="consent"
                  required
                  disabled={busy}
                  className="mt-0.5 size-5 shrink-0 accent-admin-accent"
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
                Enviar cadastro à Pagar.me
              </button>
              <p className="m-0 text-[0.82rem] text-admin-text-secondary">
                Depois disso, você verifica sua identidade.
              </p>
            </div>
          </form>
        )}
        {!canSubmit &&
          setup &&
          setup.accountState !== "CREATED" &&
          context.status === "ready" &&
          !owner && (
            <AdminButton
              tone="secondary"
              className="w-fit"
              disabled={busy || !verifySituation}
              onClick={verifySituation}
            >
              Verificar situação
            </AdminButton>
          )}
      </section>
    </StepFrame>
  );
}

const taskBadges: Record<
  ReceivingTaskStatus,
  { label: string; className: string }
> = {
  done: {
    label: "Feito",
    className: "bg-admin-success-subtle text-admin-success-text",
  },
  todo: { label: "A fazer", className: "bg-admin-subtle text-admin-text" },
  review: {
    label: "Em análise",
    className: "bg-admin-pending-subtle text-admin-pending-text",
  },
  attention: {
    label: "Precisa de ajuste",
    className: "bg-admin-danger-subtle text-admin-danger-text",
  },
  waiting: {
    label: "Depois",
    className: "bg-admin-subtle text-admin-text-secondary",
  },
};

function TaskMarker({ status }: { status: ReceivingTaskStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${
        status === "done"
          ? "border-admin-success bg-admin-success text-admin-on-accent"
          : status === "attention"
            ? "border-admin-danger"
            : status === "review"
              ? "border-admin-pending"
              : "border-admin-border-strong"
      }`}
    >
      {status === "done" && <Check className="size-3.5" />}
    </span>
  );
}

const activationQuestions = (mode: string | null | undefined) => [
  {
    question: "O que preciso ter em mãos?",
    answer: (
      <p className="m-0">
        Um documento com foto (RG ou CNH) e um celular com câmera para a selfie.
        No computador, use o QR Code para continuar pelo celular.
      </p>
    ),
  },
  {
    question: "Por que a Pagar.me pede selfie?",
    answer: (
      <p className="m-0">
        A selfie confirma que quem cadastrou o recebedor é a mesma pessoa do
        documento. Isso protege seus recebimentos contra fraudes.
      </p>
    ),
  },
  {
    question: "O link expirou. E agora?",
    answer: (
      <p className="m-0">
        Clique em Verificar identidade de novo. Cada clique gera um link novo,
        válido por 20 minutos; o EntreLaços não guarda nenhum deles.
      </p>
    ),
  },
  {
    question: "Como o painel acompanha a análise?",
    answer: (
      <>
        <p className="m-0">
          A Pagar.me avisa o EntreLaços quando a situação do recebedor muda. O
          botão Verificar agora consulta a situação na hora.
        </p>
        {showSandboxNotice(mode) && (
          <p className="m-0">
            No ambiente de teste, a verificação não analisa documentos reais.
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
  const { setup, busy, owner, receivingReady } = context;
  const siteId = context.scope.siteId;
  const provider = setup?.providerStatus ?? null;
  const created = setup?.accountState === "CREATED";
  const tasks = deriveReceivingTasks({
    accountState: setup?.accountState ?? "NOT_CREATED",
    provider,
    ready: receivingReady,
  });
  const stage = identityStage(provider);
  // Pagar.me issues the link only once it asks for the selfie and document.
  // The API accepts the platform owner or the holder; a new link per click.
  const canVerify =
    created &&
    !receivingReady &&
    stage === "verify" &&
    (owner || !!setup?.isHolder);
  const blocked =
    created && !receivingReady && (stage === "refused" || stage === "blocked");
  return (
    <StepFrame
      siteId={siteId}
      steps={context.steps}
      current="activation"
      aside={
        <>
          <AsideCard
            title="Situação na Pagar.me"
            icon={
              <RefreshCw
                aria-hidden="true"
                className="size-[18px] text-admin-accent-hover"
              />
            }
          >
            <p className="m-0 text-sm leading-[1.55] text-admin-text">
              Recebedor:{" "}
              <strong>
                {created
                  ? recipientStatusLabel(provider?.recipientStatus ?? null)
                  : "Ainda não cadastrado"}
              </strong>
            </p>
            {created && (
              <p className="m-0 text-sm leading-[1.55] text-admin-text">
                Identidade:{" "}
                <strong>{kycStatusLabel(provider?.kycStatus)}</strong>
              </p>
            )}
            <p className="m-0 text-sm leading-[1.55] text-admin-text">
              {receivingReady
                ? "Recebimentos liberados. Você pode acompanhar os pagamentos e consultar a disponibilidade de saque."
                : "Depois de enviar o documento e a selfie, verifique de novo para atualizar a situação aqui."}
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
              !!setup?.isHolder &&
              !owner &&
              setup.consentRecorded &&
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
      <StepHeading number={3} title="Verifique sua identidade">
        <p className={receivingBody}>
          {created
            ? "A Pagar.me confirma que você é o titular com a foto de um documento e uma selfie. Leva poucos minutos, pelo celular ou pelo computador."
            : "Primeiro, envie seus dados na etapa 2. Depois, a verificação de identidade aparece aqui."}
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
          aria-label="Etapas na Pagar.me"
          className={`${receivingCard} overflow-hidden`}
        >
          <ol className="m-0 list-none p-0">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex gap-4 border-b border-admin-subtle px-6 py-5 last:border-b-0 [@media(max-width:760px)]:px-4"
              >
                <div className="pt-0.5">
                  <TaskMarker status={task.status} />
                </div>
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <h3 className="m-0 text-base font-bold text-admin-text">
                      {task.title}
                    </h3>
                    <span
                      className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs leading-none font-bold ${taskBadges[task.status].className}`}
                    >
                      {taskBadges[task.status].label}
                    </span>
                  </div>
                  <p className="m-0 text-[0.95rem] leading-[1.55] text-admin-text">
                    {task.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {canVerify && (
            <div className="grid gap-3 border-t border-admin-subtle px-6 py-5 [@media(max-width:760px)]:px-4">
              <ReceivingIdentityVerification
                siteId={siteId}
                request={context.ports?.request}
                disabled={busy || context.status === "denied"}
                onUnavailable={context.onRetry}
              />
              <a
                href={supportMailto}
                className={`${receivingLink} inline-flex w-fit text-sm`}
              >
                Falar com o suporte do EntreLaços
              </a>
            </div>
          )}
          {!owner && !setup.isHolder && setup.holder && (
            <p className="m-0 border-t border-admin-subtle px-6 py-4 text-sm text-admin-text-secondary">
              Somente {setup.holder.name} verifica a identidade na Pagar.me.
            </p>
          )}
        </section>
      )}
      {blocked && (
        <p
          role="alert"
          className="m-0 rounded-[14px] bg-admin-danger-subtle p-4 text-sm leading-[1.55] text-admin-danger-text"
        >
          {stage === "refused"
            ? "A Pagar.me recusou a verificação de identidade. "
            : "A Pagar.me bloqueou ou suspendeu o recebedor. "}
          <a href={supportMailto} className={receivingLink}>
            Fale com o suporte do EntreLaços
          </a>{" "}
          para entender os próximos passos.
        </p>
      )}
      {created && (
        <section className={`${receivingCard} flex gap-4 p-6`}>
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-admin-subtle text-admin-text"
          >
            <Clock className="size-[18px]" />
          </span>
          <div className="grid gap-1">
            <h2 className="m-0 text-base font-bold text-admin-text">
              {receivingReady
                ? "Recebimentos liberados"
                : "Depois: análise da Pagar.me"}
            </h2>
            <p className="m-0 text-[0.95rem] leading-[1.55] text-admin-text">
              {receivingReady
                ? "Os convidados já podem presentear por Pix e cartão."
                : "Com o documento e a selfie enviados, a Pagar.me analisa o cadastro. Não é preciso fazer nada aqui; a liberação aparece nesta página."}
            </p>
          </div>
        </section>
      )}
    </StepFrame>
  );
}

function FeesExample() {
  const estimate = useGiftPricingPreview(20000);
  return (
    <GiftPricingPreview
      title="Exemplo de um presente de R$ 200,00"
      nominalCents={20000}
      estimate={estimate}
    />
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
          <h2 className="m-0 font-admin-display text-[1.75rem] leading-[1.15] font-normal text-admin-text">
            Sua lista de presentes
          </h2>
          <p className="m-0 text-sm leading-[1.5] text-admin-text">
            {eligible
              ? "Monte e ajuste à vontade. Os presentes publicados aparecem para os convidados."
              : "A lista é liberada para montar quando a Pagar.me aprovar o cadastro."}
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
              className="grid min-w-0 overflow-hidden rounded-[14px] border border-admin-border bg-admin-surface"
            >
              <span
                aria-hidden="true"
                className="flex h-[110px] items-center justify-center bg-admin-subtle"
              >
                <Gift className="size-7 text-admin-accent-hover" />
              </span>
              <span className="grid gap-1 p-4">
                <strong className="break-words text-[0.95rem] text-admin-text">
                  {gift.title}
                </strong>
                <span className="text-sm text-admin-text">
                  {money(gift.nominalCents)}
                </span>
              </span>
            </li>
          ))}
          <li className="min-w-0">
            <Link
              to="/sites/$siteId/gifts"
              params={{ siteId }}
              className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-admin-border-strong p-4 text-center font-bold text-admin-accent-hover no-underline hover:bg-admin-canvas"
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
  const [request] = useState(
    () =>
      (
        path: string,
        options?: { method?: string; body?: unknown; signal?: AbortSignal },
      ) =>
        apiRequest(path, options),
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
      >
        <section
          className={`${receivingCard} grid gap-6 p-8 [@media(max-width:760px)]:p-5`}
        >
          <StepHeading number={4} title="Taxas dos presentes">
            <p className={receivingBody}>{giftFeeExplanation}</p>
          </StepHeading>
          <div className="grid min-w-0 gap-3">
            <p className={receivingBody}>
              Cadastre quanto vocês querem receber por cada presente. Se
              parcelar no cartão, o convidado confere as parcelas e o total
              antes de pagar.
            </p>
            <p className={receivingBody}>
              O convidado paga as taxas e você recebe o valor inteiro de cada
              presente.
            </p>
            {pricingEnabled && <FeesExample />}
            <Link
              to="/sites/$siteId/receiving-guide"
              params={{ siteId }}
              hash="receiving-guide-credit"
              className="w-fit text-sm font-semibold text-admin-accent-hover underline underline-offset-4"
            >
              Veja quando o dinheiro fica disponível
            </Link>
          </div>
          <div className="border-t border-admin-border pt-6">
            <Link
              to="/sites/$siteId/receiving"
              params={{ siteId }}
              className={receivingPrimaryAction}
            >
              Voltar para Recebimentos
            </Link>
          </div>
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
