import type { SiteHomeSummary } from "@entrelacos/contracts";

export type InvitationGuestType = "ADULT" | "CHILD";
export type InvitationRsvpState = "PENDING" | "CONFIRMED" | "DECLINED";

export type InvitationListItem = {
  id: string;
  name: string;
  guests: {
    guestType: InvitationGuestType;
    rsvpState: InvitationRsvpState;
  }[];
};

/** Invitation status filter; PARTIAL matches invitations with mixed answers. */
export type InvitationStatusFilter = InvitationRsvpState | "PARTIAL" | "ALL";

export type InvitationFilters = {
  search: string;
  status: InvitationStatusFilter;
  guestType: InvitationGuestType | "ALL";
};

export type GuestTypeCounts = { adults: number; children: number };

export type GuestsByStatus = {
  confirmed: GuestTypeCounts;
  pending: GuestTypeCounts;
  declined: GuestTypeCounts;
};

export type InvitationSummary = {
  invitations: number;
  guests: number;
  adults: number;
  children: number;
  pending: number;
  confirmed: number;
  declined: number;
  guestsByStatus: GuestsByStatus;
};

function searchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function filterInvitations<T extends InvitationListItem>(
  invitations: readonly T[],
  filters: InvitationFilters,
): T[] {
  const search = searchKey(filters.search);
  return invitations.filter(
    (invitation) =>
      (!search || searchKey(invitation.name).includes(search)) &&
      (filters.status === "ALL" && filters.guestType === "ALL"
        ? true
        : invitation.guests.some(
            (guest) =>
              (filters.status === "ALL" ||
                guest.rsvpState === filters.status) &&
              (filters.guestType === "ALL" ||
                guest.guestType === filters.guestType),
          )),
  );
}

export function summarizeInvitations(
  invitations: readonly InvitationListItem[],
): InvitationSummary {
  const summary: InvitationSummary = {
    invitations: invitations.length,
    guests: 0,
    adults: 0,
    children: 0,
    pending: 0,
    confirmed: 0,
    declined: 0,
    guestsByStatus: {
      confirmed: { adults: 0, children: 0 },
      pending: { adults: 0, children: 0 },
      declined: { adults: 0, children: 0 },
    },
  };
  for (const invitation of invitations) {
    for (const guest of invitation.guests) {
      summary.guests += 1;
      const type = guest.guestType === "ADULT" ? "adults" : "children";
      summary[type] += 1;
      const state =
        guest.rsvpState === "PENDING"
          ? "pending"
          : guest.rsvpState === "CONFIRMED"
            ? "confirmed"
            : "declined";
      summary[state] += 1;
      summary.guestsByStatus[state][type] += 1;
    }
  }
  return summary;
}

/** Wedding-wide home-summary counts in the loaded-page summary shape. */
export function invitationSummaryFromTotals(
  totals: NonNullable<SiteHomeSummary["invitations"]>,
): InvitationSummary {
  return {
    invitations: totals.total,
    guests: totals.confirmed + totals.pending + totals.declined,
    adults: totals.adults,
    children: totals.children,
    confirmed: totals.confirmed,
    pending: totals.pending,
    declined: totals.declined,
    guestsByStatus: totals.guestsByStatus,
  };
}

/**
 * Head counts for event budgets: who is confirmed today, and the maximum if
 * every guest without an answer also comes.
 */
export function invitationBudget(guests: GuestsByStatus): {
  confirmed: GuestTypeCounts;
  maximum: GuestTypeCounts;
} {
  return {
    confirmed: guests.confirmed,
    maximum: {
      adults: guests.confirmed.adults + guests.pending.adults,
      children: guests.confirmed.children + guests.pending.children,
    },
  };
}

export function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** e.g. "15 pessoas (12 adultos e 3 crianças)". */
export function peopleCount({ adults, children }: GuestTypeCounts): string {
  return `${countLabel(adults + children, "pessoa", "pessoas")} (${countLabel(
    adults,
    "adulto",
    "adultos",
  )} e ${countLabel(children, "criança", "crianças")})`;
}

function willAttend(count: number) {
  return count === 1 ? "irá" : "irão";
}

/** Short answer breakdown shown beside an invitation's status badge. */
export function invitationResponseSummary(
  guests: readonly Pick<InvitationListItem["guests"][number], "rsvpState">[],
): string | null {
  const confirmed = guests.filter(
    (guest) => guest.rsvpState === "CONFIRMED",
  ).length;
  if (confirmed === 0) return null;
  if (confirmed === guests.length)
    return `${confirmed} de ${guests.length} ${willAttend(confirmed)}`;
  const pending = guests.filter(
    (guest) => guest.rsvpState === "PENDING",
  ).length;
  const declined = guests.length - confirmed - pending;
  return [
    `${confirmed} ${willAttend(confirmed)}`,
    pending ? `${pending} sem resposta` : "",
    declined ? `${declined} não ${willAttend(declined)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
