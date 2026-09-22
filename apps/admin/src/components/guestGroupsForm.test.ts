import { describe, expect, it } from "vitest";
import {
  copyGuestAccessPin,
  createGuestGroupDraft,
  groupDeletionConfirmation,
  guestAccessPinCopiedMessage,
  guestAccessPinCopyFailedMessage,
  guestAccessPinRotatedMessage,
  guestGroupDeleteActionLabel,
  guestGroupDeletedNotice,
  guestGroupDeleteExactNameError,
  guestGroupDialogDescription,
  guestGroupDialogTitle,
  guestGroupDraftErrors,
  guestGroupDraftPayload,
  guestGroupDraftUpdatePayload,
  guestGroupListBadge,
  guestGroupMenuActionLabels,
  guestGroupMenuActions,
  guestGroupSavedNotice,
  guestGroupSubmitLabel,
} from "./guestGroupsForm";

describe("guest group admin form", () => {
  it("lists overflow actions for an active Brazilian group", () => {
    expect(
      guestGroupMenuActions({
        inactive: false,
        isForeign: false,
      }),
    ).toEqual(["copy-pin", "rotate-pin", "edit", "delete"]);
  });

  it("hides PIN and demo actions for foreign groups", () => {
    expect(
      guestGroupMenuActions({
        inactive: false,
        isForeign: true,
      }),
    ).toEqual(["edit", "delete"]);
  });

  it("hides the overflow menu when the wedding is inactive", () => {
    expect(
      guestGroupMenuActions({
        inactive: true,
        isForeign: false,
      }),
    ).toEqual([]);
  });

  it("starts individual invitation with one representative member", () => {
    expect(createGuestGroupDraft(true)).toEqual({
      individual: true,
      name: "",
      isForeign: false,
      phone: "",
      members: [{ fullName: "", isRepresentative: true }],
    });
  });

  it("maps the individual guest name to the single representative member", () => {
    const draft = createGuestGroupDraft(true);
    draft.name = "  Ana   Solo ";
    draft.phone = "(62) 99999-9999";

    expect(guestGroupDraftErrors(draft)).toEqual([]);
    expect(guestGroupDraftPayload(draft)).toEqual({
      name: "Ana Solo",
      isIndividual: true,
      isForeign: false,
      phone: "+5562999999999",
      members: [{ fullName: "Ana Solo", isRepresentative: true }],
    });
    expect(guestGroupDraftUpdatePayload(draft)).toEqual({
      name: "Ana Solo",
      isForeign: false,
      phone: "+5562999999999",
      members: [{ fullName: "Ana Solo", isRepresentative: true }],
    });
  });

  it("asks for the guest name instead of a group name on individual drafts", () => {
    expect(guestGroupDraftErrors(createGuestGroupDraft(true))).toEqual([
      "Informe o nome do convidado.",
      "Informe um celular brasileiro válido com DDD.",
    ]);
  });

  it("labels individual create and edit copy without group language", () => {
    expect(guestGroupDialogTitle(true, false)).toBe("Novo convidado");
    expect(guestGroupDialogTitle(true, true)).toBe("Editar convidado");
    expect(guestGroupDialogTitle(false, false)).toBe("Novo grupo");
    expect(guestGroupDialogTitle(false, true)).toBe("Editar grupo");
    expect(guestGroupDialogDescription(true)).toBe(
      "Revise os dados antes de salvar.",
    );
    expect(guestGroupSubmitLabel(true, false, false)).toBe("Criar convidado");
    expect(guestGroupSubmitLabel(true, true, false)).toBe("Salvar convidado");
    expect(guestGroupSubmitLabel(false, false, false)).toBe("Criar grupo");
    expect(guestGroupSubmitLabel(true, false, true)).toBe("Salvando…");
    expect(guestGroupSavedNotice(true, false)).toBe("Convidado criado.");
    expect(guestGroupSavedNotice(true, true)).toBe("Convidado atualizado.");
    expect(guestGroupDeletedNotice(true)).toBe("Convidado excluído.");
    expect(guestGroupListBadge(true, 1)).toBe("Convite individual");
    expect(guestGroupListBadge(false, 3)).toBe("3 convidados");
    expect(guestGroupDeleteExactNameError(true)).toContain("convidado");
    expect(guestGroupDeleteActionLabel(true, false)).toBe(
      "Excluir convidado definitivamente",
    );
  });

  it("requires one representative and a phone for Brazilian groups", () => {
    const draft = createGuestGroupDraft();
    draft.name = "  Família   Silva ";
    draft.phone = "(62) 99999-9999";
    draft.members = [
      { fullName: "Ana", isRepresentative: false },
      { fullName: "Bia", isRepresentative: false },
    ];

    expect(guestGroupDraftErrors(draft)).toEqual([
      "Escolha exatamente um representante.",
    ]);
    draft.members[0].isRepresentative = true;
    expect(guestGroupDraftErrors(draft)).toEqual([]);
  });

  it("does not ask for phone from foreign groups and normalizes payload", () => {
    const draft = createGuestGroupDraft();
    draft.name = "  The   Smiths ";
    draft.isForeign = true;
    draft.phone = "(62) 99999-9999";
    draft.members = [{ fullName: "  John   Smith ", isRepresentative: true }];

    expect(guestGroupDraftErrors(draft)).toEqual([]);
    expect(guestGroupDraftPayload(draft)).toEqual({
      name: "The Smiths",
      isIndividual: false,
      isForeign: true,
      phone: null,
      members: [{ fullName: "John Smith", isRepresentative: true }],
    });
  });

  it("keeps member ids when editing", () => {
    const draft = createGuestGroupDraft();
    draft.name = "Família";
    draft.phone = "62999999999";
    draft.members = [
      { id: "member-1", fullName: "Ana", isRepresentative: true },
    ];

    expect(guestGroupDraftPayload(draft)).toEqual({
      name: "Família",
      isIndividual: false,
      isForeign: false,
      phone: "+5562999999999",
      members: [{ id: "member-1", fullName: "Ana", isRepresentative: true }],
    });
  });
});

describe("guest group PIN menu", () => {
  it("labels the PIN action as copy, not reveal", () => {
    expect(guestGroupMenuActionLabels["copy-pin"]).toBe("Copiar PIN");
    expect(guestGroupMenuActionLabels).not.toHaveProperty("reveal-pin");
  });
});

describe("copy guest access PIN", () => {
  it("writes the PIN to the clipboard", async () => {
    const writes: string[] = [];

    await expect(
      copyGuestAccessPin("004218", {
        writeText: async (text) => {
          writes.push(text);
        },
      }),
    ).resolves.toBe(true);
    expect(writes).toEqual(["004218"]);
    expect(guestAccessPinCopiedMessage("Confirmed Family")).toBe(
      "PIN de Confirmed Family copiado.",
    );
  });

  it("reports clipboard failure without throwing", async () => {
    await expect(
      copyGuestAccessPin("004218", {
        writeText: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBe(false);
    expect(guestAccessPinCopyFailedMessage).toContain(
      "Não foi possível copiar",
    );
  });

  it("describes PIN rotation for the success toast", () => {
    expect(guestAccessPinRotatedMessage).toBe(
      "Novo PIN gerado. O PIN anterior e os acessos ativos foram revogados.",
    );
  });
});

describe("group deletion confirmation", () => {
  it("requires the exact group name and binds the target ID", () => {
    expect(
      groupDeletionConfirmation("group-a", "Família Silva", "Família Silva"),
    ).toEqual({
      confirmGroupId: "group-a",
      confirmGroupName: "Família Silva",
    });
    expect(
      groupDeletionConfirmation("group-a", "Família Silva", "familia silva"),
    ).toBeNull();
  });
});
