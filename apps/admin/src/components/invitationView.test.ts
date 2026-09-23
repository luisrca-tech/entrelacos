import { describe, expect, it } from "vitest";
import {
  filterInvitations,
  type InvitationListItem,
  summarizeInvitations,
} from "./invitationView";

const invitations: InvitationListItem[] = [
  {
    id: "silva",
    name: "Família Silva",
    guests: [
      { guestType: "ADULT", rsvpState: "CONFIRMED" },
      { guestType: "CHILD", rsvpState: "PENDING" },
    ],
  },
  {
    id: "ana",
    name: "Ana Costa",
    guests: [{ guestType: "ADULT", rsvpState: "DECLINED" }],
  },
];

describe("invitation view", () => {
  it("searches only the invitation identification, ignoring accents and case", () => {
    expect(
      filterInvitations(invitations, {
        search: "familia SILVA",
        status: "ALL",
        guestType: "ALL",
      }).map((invitation) => invitation.id),
    ).toEqual(["silva"]);
    expect(
      filterInvitations(invitations, {
        search: "Costa",
        status: "ALL",
        guestType: "ALL",
      }).map((invitation) => invitation.id),
    ).toEqual(["ana"]);
  });

  it("requires status and age type to match the same guest", () => {
    expect(
      filterInvitations(invitations, {
        search: "",
        status: "CONFIRMED",
        guestType: "CHILD",
      }),
    ).toEqual([]);
    expect(
      filterInvitations(invitations, {
        search: "",
        status: "PENDING",
        guestType: "CHILD",
      }).map((invitation) => invitation.id),
    ).toEqual(["silva"]);
  });

  it("summarizes invitations and individual guests without double counting", () => {
    expect(summarizeInvitations(invitations)).toEqual({
      invitations: 2,
      guests: 3,
      adults: 2,
      children: 1,
      pending: 1,
      confirmed: 1,
      declined: 1,
    });
  });
});
