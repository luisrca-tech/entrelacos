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

// Identity verification happens at Pagar.me; its account state drives the task.
export function identityTaskStatus(
  accountState: ProviderStatus["accountState"] | undefined,
): Exclude<ReceivingTaskStatus, "waiting"> {
  switch (accountState) {
    case "APPROVED":
      return "done";
    case "UNDER_REVIEW":
      return "review";
    case "BLOCKED":
    case "SUSPENDED":
      return "attention";
    default:
      return "todo";
  }
}

// The three Pagar.me steps, all derived from server state: nothing is
// marked by hand or kept in the browser.
export function deriveReceivingTasks(
  input: ReceivingTasksInput,
): ReceivingTask[] {
  const created = input.accountState === "CREATED";
  const identity = created
    ? input.ready
      ? "done"
      : identityTaskStatus(input.provider?.accountState)
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
        "Foto do documento e selfie, pelo link seguro da Pagar.me no celular ou no computador.",
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
