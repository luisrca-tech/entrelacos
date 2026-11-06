import type { ReceivingSetupContext } from "@entrelacos/contracts";

export type ReceivingStepId =
  | "holder"
  | "details"
  | "activation"
  | "account"
  | "fees";
export type ReceivingStepStatus =
  | "done"
  | "current"
  | "review"
  | "attention"
  | "available"
  | "locked";

export const receivingSteps: readonly {
  id: ReceivingStepId;
  title: string;
  short: string;
  summary: string;
}[] = [
  {
    id: "holder",
    title: "Quem vai receber",
    short: "Quem recebe",
    summary: "Um dos noivos é o titular da conta e dos saques.",
  },
  {
    id: "details",
    title: "Seus dados",
    short: "Seus dados",
    summary: "CPF, celular e endereço para abrir a conta no Asaas.",
  },
  {
    id: "activation",
    title: "Ative sua conta no Asaas",
    short: "Ativar no Asaas",
    summary: "Criar a senha, confirmar o celular e enviar documentos.",
  },
  {
    id: "account",
    title: "Conta para saque",
    short: "Conta para saque",
    summary: "A chave Pix do seu banco, para onde o dinheiro vai.",
  },
  {
    id: "fees",
    title: "Taxas e presentes",
    short: "Taxas e presentes",
    summary: "Entenda as taxas incluídas no preço e revise a lista.",
  },
];

export const receivingStepStatusLabel: Record<ReceivingStepStatus, string> = {
  done: "Concluída",
  current: "Agora",
  review: "Em análise pelo Asaas",
  attention: "Precisa de ajuste",
  available: "Pode fazer já",
  locked: "Depois",
};

export type ReceivingTrackInput = {
  holder: boolean;
  accountState: ReceivingSetupContext["accountState"];
  provider: Omit<
    NonNullable<ReceivingSetupContext["providerStatus"]>,
    "observedAt"
  > | null;
  ready: boolean;
  destinationSaved: boolean;
};

export type ReceivingTrackStep = (typeof receivingSteps)[number] & {
  number: number;
  status: ReceivingStepStatus;
};

type BaseStatus = "done" | "todo" | "review" | "attention" | "locked";

function activationStatus(input: ReceivingTrackInput): BaseStatus {
  if (input.accountState !== "CREATED") return "locked";
  if (input.ready || input.provider?.general === "APPROVED") return "done";
  const provider = input.provider;
  if (
    provider &&
    (provider.commercialInfoExpired === true ||
      [
        provider.commercialInfo,
        provider.documentation,
        provider.general,
      ].includes("REJECTED"))
  )
    return "attention";
  if (provider?.general === "AWAITING_APPROVAL") return "review";
  return "todo";
}

// Derives the five setup steps and the single next step from server state.
export function deriveReceivingTrack(input: ReceivingTrackInput) {
  const created = input.accountState === "CREATED";
  const base: Record<ReceivingStepId, BaseStatus> = {
    holder: input.holder ? "done" : "todo",
    details: !input.holder
      ? "locked"
      : created
        ? "done"
        : input.accountState === "UNKNOWN"
          ? "attention"
          : "todo",
    activation: activationStatus(input),
    account: !created
      ? "locked"
      : input.destinationSaved || input.ready
        ? "done"
        : "todo",
    fees: created ? "done" : "locked",
  };
  const actionable = receivingSteps.find(({ id }) =>
    ["todo", "attention"].includes(base[id]),
  );
  const steps: ReceivingTrackStep[] = receivingSteps.map((step, index) => {
    const value = base[step.id];
    return {
      ...step,
      number: index + 1,
      status:
        value === "todo"
          ? step.id === actionable?.id
            ? "current"
            : "available"
          : value,
    };
  });
  const next =
    steps.find(({ id }) => id === actionable?.id) ??
    steps.find(({ status }) => status === "review") ??
    null;
  return {
    steps,
    next,
    completed: steps.filter(({ status }) => status === "done").length,
  };
}
