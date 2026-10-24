import type { SiteRecord } from "@entrelacos/contracts";
import type { OverflowMenuItem } from "./OverflowMenu";

export type LifecycleAction =
  | "review/start"
  | "review/approve"
  | "reactivate"
  | "deactivate";

export const lifecycleConfirmation: Record<
  LifecycleAction,
  { title: string; description: string; confirmLabel: string }
> = {
  "review/start": {
    title: "Enviar este casamento para revisão?",
    description:
      "O casamento ficará em revisão até a aprovação. A vigência começa somente depois de aprovado.",
    confirmLabel: "Enviar para revisão",
  },
  "review/approve": {
    title: "Aprovar este casamento?",
    description:
      "A aprovação ativa o casamento e inicia um ano de vigência. Confira as informações antes de continuar.",
    confirmLabel: "Aprovar e iniciar vigência",
  },
  reactivate: {
    title: "Reativar este casamento?",
    description:
      "As alterações do casamento voltarão a ficar disponíveis. Confira a publicação do site separadamente.",
    confirmLabel: "Reativar casamento",
  },
  deactivate: {
    title: "Inativar este casamento?",
    description:
      "As alterações ficarão indisponíveis para a equipe. Os dados serão preservados. A publicação da página neutra deve ser feita separadamente.",
    confirmLabel: "Inativar casamento",
  },
};

export function siteLifecycleMenuActions(
  lifecycle: SiteRecord["lifecycle"],
  hasTerm = true,
): Array<OverflowMenuItem & { id: LifecycleAction }> {
  if (lifecycle === "INACTIVE") {
    return [{ id: "reactivate", label: "Reativar casamento" }];
  }
  const next: Array<OverflowMenuItem & { id: LifecycleAction }> = [];
  if (lifecycle === "DRAFT") {
    next.push({ id: "review/start", label: "Enviar para revisão" });
  }
  if (lifecycle === "IN_REVIEW" || (lifecycle === "ACTIVE" && !hasTerm)) {
    next.push({ id: "review/approve", label: "Aprovar e iniciar vigência" });
  }
  return [
    ...next,
    { id: "deactivate", label: "Inativar casamento", variant: "destructive" },
  ];
}
