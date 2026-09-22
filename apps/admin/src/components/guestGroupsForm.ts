import {
  brazilianPhoneInputSchema,
  type GroupDeleteConfirmation,
  type GuestGroupCreateInput,
  type GuestGroupUpdateInput,
} from "@entrelacos/contracts";

export type GuestGroupDraftMember = {
  id?: string;
  fullName: string;
  isRepresentative: boolean;
};

export type GuestGroupDraft = {
  individual: boolean;
  name: string;
  isForeign: boolean;
  phone: string;
  members: GuestGroupDraftMember[];
};

export function canIssueDemoGuestGrant(
  owner: boolean,
  isDemo: boolean,
  inactive: boolean,
  group: Pick<GuestGroupCreateInput, "isForeign" | "phone">,
): boolean {
  return (
    owner && isDemo && !inactive && !group.isForeign && group.phone !== null
  );
}

export const guestGroupMenuActionLabels = {
  "copy-pin": "Copiar PIN",
  "rotate-pin": "Rotacionar PIN",
  "demo-grant": "Gerar acesso demo",
  edit: "Editar",
  delete: "Excluir",
} as const;

export type GuestGroupMenuAction = keyof typeof guestGroupMenuActionLabels;

export async function copyGuestAccessPin(
  accessPin: string,
  clipboard: Pick<Clipboard, "writeText">,
): Promise<boolean> {
  try {
    await clipboard.writeText(accessPin);
    return true;
  } catch {
    return false;
  }
}

export function guestAccessPinCopiedMessage(groupName: string): string {
  return `PIN de ${groupName} copiado.`;
}

export const guestAccessPinCopyFailedMessage =
  "Não foi possível copiar o PIN. Tente novamente.";

export const guestAccessPinRotatedMessage =
  "Novo PIN gerado. O PIN anterior e os acessos ativos foram revogados.";

export function guestGroupMenuActions({
  owner,
  isDemo,
  inactive,
  isForeign,
  phone,
}: {
  owner: boolean;
  isDemo: boolean;
  inactive: boolean;
  isForeign: boolean;
  phone: string | null;
}): GuestGroupMenuAction[] {
  if (inactive) return [];
  const actions: GuestGroupMenuAction[] = [];
  if (!isForeign) {
    actions.push("copy-pin", "rotate-pin");
  }
  if (canIssueDemoGuestGrant(owner, isDemo, inactive, { isForeign, phone })) {
    actions.push("demo-grant");
  }
  actions.push("edit", "delete");
  return actions;
}

export function groupDeletionConfirmation(
  groupId: string,
  groupName: string,
  confirmation: string,
): GroupDeleteConfirmation | null {
  if (confirmation !== groupName) return null;
  return { confirmGroupId: groupId, confirmGroupName: groupName };
}

export function createGuestGroupDraft(individual = false): GuestGroupDraft {
  return {
    individual,
    name: "",
    isForeign: false,
    phone: "",
    members: [{ fullName: "", isRepresentative: true }],
  };
}

export function guestGroupDialogTitle(
  individual: boolean,
  editing: boolean,
): string {
  if (individual) return editing ? "Editar convidado" : "Novo convidado";
  return editing ? "Editar grupo" : "Novo grupo";
}

export function guestGroupDialogDescription(individual: boolean): string {
  return individual
    ? "Revise os dados antes de salvar."
    : "Escolha o representante e revise os dados antes de salvar.";
}

export function guestGroupSubmitLabel(
  individual: boolean,
  editing: boolean,
  pending: boolean,
): string {
  if (pending) return "Salvando…";
  if (individual) return editing ? "Salvar convidado" : "Criar convidado";
  return editing ? "Salvar grupo" : "Criar grupo";
}

export function guestGroupSavedNotice(
  individual: boolean,
  editing: boolean,
): string {
  if (individual)
    return editing ? "Convidado atualizado." : "Convidado criado.";
  return editing ? "Grupo atualizado." : "Grupo criado.";
}

export function guestGroupDeletedNotice(individual: boolean): string {
  return individual ? "Convidado excluído." : "Grupo excluído.";
}

export function guestGroupListBadge(
  individual: boolean,
  memberCount: number,
): string {
  return individual ? "Convite individual" : `${memberCount} convidados`;
}

export function guestGroupDeleteExactNameError(individual: boolean): string {
  return individual
    ? "Digite o nome exato do convidado para confirmar a exclusão."
    : "Digite o nome exato do grupo para confirmar a exclusão.";
}

export function guestGroupDeleteActionLabel(
  individual: boolean,
  pending: boolean,
): string {
  if (pending) return "Excluindo…";
  return individual
    ? "Excluir convidado definitivamente"
    : "Excluir grupo definitivamente";
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function guestGroupDraftErrors(draft: GuestGroupDraft): string[] {
  const errors: string[] = [];
  if (draft.individual) {
    if (!cleanText(draft.name)) errors.push("Informe o nome do convidado.");
  } else {
    if (!cleanText(draft.name)) errors.push("Informe o nome do grupo.");
    if (draft.members.length === 0) {
      errors.push("Adicione pelo menos um convidado.");
    }
    if (draft.members.some((member) => !cleanText(member.fullName))) {
      errors.push("Informe o nome de todos os convidados.");
    }
    if (
      draft.members.filter((member) => member.isRepresentative).length !== 1
    ) {
      errors.push("Escolha exatamente um representante.");
    }
  }
  if (
    !draft.isForeign &&
    !brazilianPhoneInputSchema.safeParse(draft.phone).success
  ) {
    errors.push("Informe um celular brasileiro válido com DDD.");
  }
  return errors;
}

export function guestGroupDraftPayload(
  draft: GuestGroupDraft,
): GuestGroupCreateInput {
  const name = cleanText(draft.name);
  if (draft.individual) {
    const member = draft.members[0];
    return {
      name,
      isIndividual: true,
      isForeign: draft.isForeign,
      phone: draft.isForeign
        ? null
        : brazilianPhoneInputSchema.parse(draft.phone),
      members: [
        {
          ...(member?.id ? { id: member.id } : {}),
          fullName: name,
          isRepresentative: true,
        },
      ],
    };
  }
  return {
    name,
    isIndividual: false,
    isForeign: draft.isForeign,
    phone: draft.isForeign
      ? null
      : brazilianPhoneInputSchema.parse(draft.phone),
    members: draft.members.map((member) => ({
      ...(member.id ? { id: member.id } : {}),
      fullName: cleanText(member.fullName),
      isRepresentative: member.isRepresentative,
    })),
  };
}

export function guestGroupDraftUpdatePayload(
  draft: GuestGroupDraft,
): GuestGroupUpdateInput {
  const { isIndividual: _kind, ...payload } = guestGroupDraftPayload(draft);
  return payload;
}
