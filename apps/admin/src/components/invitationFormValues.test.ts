import type { InvitationRecord } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { invitationFormValues } from "./invitationFormValues";

describe("invitation form values", () => {
  it("starts with one adult guest and no optional email", () => {
    expect(invitationFormValues(null)).toEqual({
      name: "",
      phone: "",
      email: "",
      guests: [{ fullName: "", guestType: "ADULT" }],
    });
  });

  it("preserves existing guest identity and age type while editing", () => {
    const invitation: InvitationRecord = {
      id: "invitation-1",
      siteId: "site-1",
      name: "Família Silva",
      phone: "+5511999999999",
      email: null,
      guests: [
        {
          id: "guest-1",
          fullName: "Bia",
          guestType: "CHILD",
          rsvpState: "PENDING",
          rsvpRevision: 0,
        },
      ],
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    };
    expect(invitationFormValues(invitation)).toMatchObject({
      name: "Família Silva",
      phone: "+55 11 99999 9999",
      email: "",
      guests: [{ id: "guest-1", fullName: "Bia", guestType: "CHILD" }],
    });
  });
});
