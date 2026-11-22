import type { ReceivingSetupContext } from "@entrelacos/contracts";

type ProviderStatus = NonNullable<ReceivingSetupContext["providerStatus"]>;

export type ReceivingTaskId = "recipient" | "identity" | "ready";
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
 * Where the Pagar.me identity check stands:
 * - `initial_analysis`: Pagar.me is still analysing the registration (up to
 *   24 hours) and has not asked for the selfie and document;
 * - `verify`: Pagar.me asked for them (`affiliation` with KYC
 *   `partially_denied`), the only time it issues the verification link;
 * - `documents_review`: the selfie and document are being analysed;
 * - `done`: the recipient is active;
 * - `refused`: Pagar.me refused the recipient or its identity;
 * - `blocked`: the recipient was blocked or suspended.
 */
export type IdentityStage =
  | "initial_analysis"
  | "verify"
  | "documents_review"
  | "done"
  | "refused"
  | "blocked";
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
  if (provider?.recipientStatus === "affiliation") {
    if (provider.kycStatus === "partially_denied") return "verify";
    if (
      provider.kycStatus === "approved" ||
      provider.kycStatusReason === "answered_waiting_analysis"
    )
      return "documents_review";
  }
  return "initial_analysis";
}

const identityStageStatus: Record<
  IdentityStage,
  Exclude<ReceivingTaskStatus, "waiting">
> = {
  initial_analysis: "review",
  verify: "todo",
  documents_review: "review",
  done: "done",
  refused: "attention",
  blocked: "attention",
};
// Identity verification happens at Pagar.me; its recipient and KYC status
// drive the task.
export function identityTaskStatus(
  provider: IdentityProvider | null | undefined,
): Exclude<ReceivingTaskStatus, "waiting"> {
  return identityStageStatus[identityStage(provider)];
}

const identityDescriptions: Record<IdentityStage, string> = {
  initial_analysis:
    "A Pagar.me faz primeiro uma análise do cadastro, que pode levar até 24 horas. Quando ela pedir a foto do documento e a selfie, o botão Verificar identidade aparece aqui.",
  verify:
    "A Pagar.me pediu a foto do documento e uma selfie. Envie pelo link seguro, no celular ou no computador.",
  documents_review:
    "Documento e selfie recebidos. A Pagar.me está concluindo a análise.",
  done: "Identidade confirmada pela Pagar.me.",
  refused: "Recusada pela Pagar.me.",
  blocked: "Recebedor bloqueado ou suspenso na Pagar.me.",
};

// The three Pagar.me steps, all derived from server state: nothing is
// marked by hand or kept in the browser.
export function deriveReceivingTasks(
  input: ReceivingTasksInput,
): ReceivingTask[] {
  const created = input.accountState === "CREATED";
  const identity = created
    ? input.ready
      ? "done"
      : identityTaskStatus(input.provider)
    : "waiting";
  return [
    {
      id: "recipient",
      title: "Dados do recebedor",
      description:
        "Nome, CPF, endereço e a conta bancária no mesmo CPF, enviados à Pagar.me.",
      status: created
        ? "done"
        : input.accountState === "UNKNOWN"
          ? "attention"
          : "todo",
    },
    {
      id: "identity",
      title: "Verificação de identidade",
      description:
        created && !input.ready
          ? identityDescriptions[identityStage(input.provider)]
          : "Foto do documento e selfie, pelo link seguro da Pagar.me no celular ou no computador.",
      status: identity,
    },
    {
      id: "ready",
      title: "Pronto para receber",
      description:
        "Com a identidade aprovada, os convidados podem presentear por Pix e cartão.",
      status: input.ready ? "done" : "waiting",
    },
  ];
}

const recipientStatusLabels: Record<
  NonNullable<ProviderStatus["recipientStatus"]>,
  string
> = {
  registration: "Cadastro recebido",
  affiliation: "Em análise",
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
  partially_denied: "Aguardando documento e selfie",
  approved: "Aprovada",
  denied: "Recusada",
  unknown: "Situação não reconhecida",
};

export function kycStatusLabel(status: ProviderStatus["kycStatus"]): string {
  return status ? kycStatusLabels[status] : "Ainda não solicitada";
}
