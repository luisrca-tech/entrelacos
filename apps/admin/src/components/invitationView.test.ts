import { describe, expect, it } from "vitest";
import {
  filterInvitations,
  invitationResponseSummary,
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

describe("invitation response summary", () => {
  const guest = (rsvpState: "PENDING" | "CONFIRMED" | "DECLINED") => ({
    guestType: "ADULT" as const,
    rsvpState,
  });

  it("states how many confirmed people will attend", () => {
    expect(
      invitationResponseSummary([guest("CONFIRMED"), guest("CONFIRMED")]),
    ).toBe("2 de 2 irão");
    expect(invitationResponseSummary([guest("CONFIRMED")])).toBe("1 de 1 irá");
  });

  it("breaks down a partial answer", () => {
    expect(
      invitationResponseSummary([
        guest("CONFIRMED"),
        guest("CONFIRMED"),
        guest("PENDING"),
        guest("PENDING"),
      ]),
    ).toBe("2 irão · 2 sem resposta");
    expect(
      invitationResponseSummary([
        guest("CONFIRMED"),
        guest("DECLINED"),
        guest("PENDING"),
      ]),
    ).toBe("1 irá · 1 sem resposta · 1 não irá");
  });

  it("adds nothing when the badge already says it all", () => {
    expect(invitationResponseSummary([guest("PENDING")])).toBeNull();
    expect(
      invitationResponseSummary([guest("DECLINED"), guest("DECLINED")]),
    ).toBeNull();
    expect(invitationResponseSummary([])).toBeNull();
  });
});
