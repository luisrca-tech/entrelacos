import { describe, expect, it } from "vitest";
import {
  canIssueDemoGuestGrant,
  createGuestGroupDraft,
  groupDeletionConfirmation,
  guestGroupDraftErrors,
  guestGroupDraftPayload,
} from "./guestGroupsForm";

describe("guest group admin form", () => {
  it("offers demo authorization only to the owner for a Brazilian demo group", () => {
    const group = { isForeign: false, phone: "+5562999999999" };

    expect(canIssueDemoGuestGrant(true, true, false, group)).toBe(true);
    expect(canIssueDemoGuestGrant(false, true, false, group)).toBe(false);
    expect(canIssueDemoGuestGrant(true, false, false, group)).toBe(false);
    expect(canIssueDemoGuestGrant(true, true, true, group)).toBe(false);
    expect(
      canIssueDemoGuestGrant(true, true, false, {
        isForeign: true,
        phone: null,
      }),
    ).toBe(false);
  });

  it("starts individual invitation with one representative member", () => {
    expect(createGuestGroupDraft(true)).toEqual({
      name: "",
      isForeign: false,
      phone: "",
      members: [{ fullName: "", isRepresentative: true }],
    });
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
      isForeign: false,
      phone: "+5562999999999",
      members: [{ id: "member-1", fullName: "Ana", isRepresentative: true }],
    });
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
