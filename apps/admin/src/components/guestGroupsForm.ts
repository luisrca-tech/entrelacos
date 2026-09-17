import {
  brazilianPhoneInputSchema,
  type GroupDeleteConfirmation,
  type GuestGroupCreateInput,
} from "@entrelacos/contracts";

export type GuestGroupDraftMember = {
  id?: string;
  fullName: string;
  isRepresentative: boolean;
};

export type GuestGroupDraft = {
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
  "reveal-pin": "Exibir PIN",
  "rotate-pin": "Rotacionar PIN",
  "demo-grant": "Gerar acesso demo",
  edit: "Editar",
  delete: "Excluir",
} as const;

export type GuestGroupMenuAction = keyof typeof guestGroupMenuActionLabels;

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
    actions.push("reveal-pin", "rotate-pin");
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

export function createGuestGroupDraft(_individual = false): GuestGroupDraft {
  return {
    name: "",
    isForeign: false,
    phone: "",
    members: [{ fullName: "", isRepresentative: true }],
  };
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function guestGroupDraftErrors(draft: GuestGroupDraft): string[] {
  const errors: string[] = [];
  if (!cleanText(draft.name)) errors.push("Informe o nome do grupo.");
  if (draft.members.length === 0) {
    errors.push("Adicione pelo menos um convidado.");
  }
  if (draft.members.some((member) => !cleanText(member.fullName))) {
    errors.push("Informe o nome de todos os convidados.");
  }
  if (draft.members.filter((member) => member.isRepresentative).length !== 1) {
    errors.push("Escolha exatamente um representante.");
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
  return {
    name: cleanText(draft.name),
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
