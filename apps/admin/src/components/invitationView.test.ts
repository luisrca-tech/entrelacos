import { describe, expect, it } from "vitest";
import {
  filterInvitations,
  type InvitationListItem,
  invitationBudget,
  invitationResponseSummary,
  invitationSummaryFromTotals,
  peopleCount,
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
      guestsByStatus: {
        confirmed: { adults: 1, children: 0 },
        pending: { adults: 0, children: 1 },
        declined: { adults: 1, children: 0 },
      },
    });
  });

  it("reads the same summary from wedding-wide totals", () => {
    expect(
      invitationSummaryFromTotals({
        total: 8,
        confirmed: 9,
        pending: 7,
        declined: 2,
        adults: 14,
        children: 4,
        byStatus: { confirmed: 4, pending: 2, declined: 1, partial: 1 },
        guestsByStatus: {
          confirmed: { adults: 7, children: 2 },
          pending: { adults: 5, children: 2 },
          declined: { adults: 2, children: 0 },
        },
      }),
    ).toEqual({
      invitations: 8,
      guests: 18,
      adults: 14,
      children: 4,
      confirmed: 9,
      pending: 7,
      declined: 2,
      guestsByStatus: {
        confirmed: { adults: 7, children: 2 },
        pending: { adults: 5, children: 2 },
        declined: { adults: 2, children: 0 },
      },
    });
  });

  it("sizes the budget from confirmed guests and the pending maximum", () => {
    expect(
      invitationBudget({
        confirmed: { adults: 7, children: 2 },
        pending: { adults: 5, children: 1 },
        declined: { adults: 2, children: 0 },
      }),
    ).toEqual({
      confirmed: { adults: 7, children: 2 },
      maximum: { adults: 12, children: 3 },
    });
  });

  it("describes people, adults and children in singular and plural", () => {
    expect(peopleCount({ adults: 1, children: 0 })).toBe(
      "1 pessoa (1 adulto e 0 crianças)",
    );
    expect(peopleCount({ adults: 0, children: 1 })).toBe(
      "1 pessoa (0 adultos e 1 criança)",
    );
    expect(peopleCount({ adults: 12, children: 3 })).toBe(
      "15 pessoas (12 adultos e 3 crianças)",
    );
    expect(peopleCount({ adults: 0, children: 0 })).toBe(
      "0 pessoas (0 adultos e 0 crianças)",
    );
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
