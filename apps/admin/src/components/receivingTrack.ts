import type { ReceivingSetupContext } from "@entrelacos/contracts";
import { identityTaskStatus } from "./receivingTasks";

export type ReceivingStepId = "holder" | "details" | "activation" | "fees";
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
    summary: "Um dos noivos é o titular do recebedor e dos saques.",
  },
  {
    id: "details",
    title: "Seus dados",
    short: "Seus dados",
    summary: "CPF, endereço e conta bancária no seu CPF, para a Pagar.me.",
  },
  {
    id: "activation",
    title: "Verifique sua identidade",
    short: "Verificar identidade",
    summary: "Documento e selfie pelo link seguro da Pagar.me.",
  },
  {
    id: "fees",
    title: "Taxas e presentes",
    short: "Taxas e presentes",
    summary: "Veja que o convidado paga as taxas e revise a lista.",
  },
];

export const receivingStepStatusLabel: Record<ReceivingStepStatus, string> = {
  done: "Concluída",
  current: "Agora",
  review: "Em análise pela Pagar.me",
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
};

export type ReceivingTrackStep = (typeof receivingSteps)[number] & {
  number: number;
  status: ReceivingStepStatus;
};

type BaseStatus = "done" | "todo" | "review" | "attention" | "locked";

function activationStatus(input: ReceivingTrackInput): BaseStatus {
  if (input.accountState !== "CREATED") return "locked";
  if (input.ready) return "done";
  return identityTaskStatus(input.provider);
}

// Derives the four setup steps and the single next step from server state.
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
