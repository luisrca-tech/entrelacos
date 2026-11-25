import type { ReceivingSetupContext } from "@entrelacos/contracts";

type ProviderStatus = NonNullable<ReceivingSetupContext["providerStatus"]>;

export type ReceivingTaskId = "recipient" | "bank" | "account";
export type ReceivingTaskStatus =
  | "done"
  | "todo"
  | "review"
  | "attention"
  | "waiting";
export type ReceivingTask = {
  id: ReceivingTaskId;
  title: string;
  description: string;
  status: ReceivingTaskStatus;
};
export type ReceivingTasksInput = {
  accountState: ReceivingSetupContext["accountState"];
  provider: Omit<ProviderStatus, "observedAt"> | null;
  ready: boolean;
};

type IdentityProvider = Pick<
  ProviderStatus,
  "recipientStatus" | "accountState" | "kycStatus" | "kycStatusReason"
>;
/**
 * Where the recipient's activation at Pagar.me stands. On a pass-through
 * account Pagar.me runs no identity check of its own (the marketplace checks
 * CPF, age and bank ownership before sending), so the couple never acts here:
 * - `activating`: Pagar.me has not activated the recipient yet;
 * - `done`: the recipient is active;
 * - `refused`: Pagar.me refused the recipient or its identity;
 * - `blocked`: the recipient was blocked, suspended or deactivated;
 * - `documents_requested`: Pagar.me unexpectedly asked for documents
 *   (KYC `partially_denied` or `additional_documents_required`); the couple
 *   is sent to Entrelaços support, never to a Pagar.me link.
 */
export type IdentityStage =
  | "activating"
  | "done"
  | "refused"
  | "blocked"
  | "documents_requested";
export function identityStage(
  provider: IdentityProvider | null | undefined,
): IdentityStage {
  if (provider?.accountState === "APPROVED") return "done";
  if (
    provider?.recipientStatus === "refused" ||
    provider?.kycStatus === "denied"
  )
    return "refused";
  if (
    provider?.accountState === "BLOCKED" ||
    provider?.accountState === "SUSPENDED"
  )
    return "blocked";
  if (
    provider?.kycStatus === "partially_denied" ||
    provider?.kycStatusReason === "additional_documents_required"
  )
    return "documents_requested";
  return "activating";
}

const identityStageStatus: Record<
  IdentityStage,
  Exclude<ReceivingTaskStatus, "waiting" | "todo">
> = {
  activating: "review",
  done: "done",
  refused: "attention",
  blocked: "attention",
  documents_requested: "attention",
};
// The recipient and KYC status Pagar.me reports drive the account task.
export function identityTaskStatus(
  provider: IdentityProvider | null | undefined,
): Exclude<ReceivingTaskStatus, "waiting" | "todo"> {
  return identityStageStatus[identityStage(provider)];
}

// Only the fact: the step page's alert carries the support guidance.
const identityDescriptions: Record<IdentityStage, string> = {
  activating:
    "A Pagar.me está ativando a conta. A ativação costuma ser rápida e aparece aqui assim que terminar.",
  done: "Conta ativa. Os convidados já podem presentear por Pix e cartão.",
  refused: "Recusada pela Pagar.me.",
  blocked: "Bloqueada ou suspensa pela Pagar.me.",
  documents_requested:
    "A Pagar.me pediu documentos, fora do fluxo deste cadastro.",
};

// The registration and its activation, all derived from server state:
// nothing is marked by hand or kept in the browser.
export function deriveReceivingTasks(
  input: ReceivingTasksInput,
): ReceivingTask[] {
  const created = input.accountState === "CREATED";
  const sent = created
    ? "done"
    : input.accountState === "UNKNOWN"
      ? "attention"
      : "todo";
  const stage = input.ready ? "done" : identityStage(input.provider);
  return [
    {
      id: "recipient",
      title: "Dados do casal",
      description:
        "Nome, CPF, nascimento e endereço do titular, com a declaração de que os dados são verdadeiros.",
      status: sent,
    },
    {
      id: "bank",
      title: "Conta bancária",
      description: "No mesmo CPF do titular, para onde vão os saques.",
      status: sent,
    },
    {
      id: "account",
      title: "Status da conta",
      description: created
        ? identityDescriptions[stage]
        : "A Pagar.me ativa a conta depois que o cadastro é enviado.",
      status: created ? identityStageStatus[stage] : "waiting",
    },
  ];
}

const recipientStatusLabels: Record<
  NonNullable<ProviderStatus["recipientStatus"]>,
  string
> = {
  registration: "Cadastro recebido",
  affiliation: "Em ativação",
  active: "Ativo",
  refused: "Recusado",
  suspended: "Suspenso",
  blocked: "Bloqueado",
  inactive: "Inativo",
};

export function recipientStatusLabel(
  status: ProviderStatus["recipientStatus"],
): string {
  return status === null
    ? "Ainda sem resposta da Pagar.me"
    : recipientStatusLabels[status];
}

const kycStatusLabels: Record<
  NonNullable<ProviderStatus["kycStatus"]>,
  string
> = {
  pending: "Em análise",
  partially_denied: "Documentos pedidos, fale com o suporte",
  approved: "Aprovada",
  denied: "Recusada",
  unknown: "Situação não reconhecida",
};

export function kycStatusLabel(status: ProviderStatus["kycStatus"]): string {
  return status ? kycStatusLabels[status] : "Sem pendências";
}
