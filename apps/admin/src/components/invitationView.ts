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

export type InvitationFilters = {
  search: string;
  status: InvitationRsvpState | "ALL";
  guestType: InvitationGuestType | "ALL";
};

export type InvitationSummary = {
  invitations: number;
  guests: number;
  adults: number;
  children: number;
  pending: number;
  confirmed: number;
  declined: number;
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
  };
  for (const invitation of invitations) {
    for (const guest of invitation.guests) {
      summary.guests += 1;
      if (guest.guestType === "ADULT") summary.adults += 1;
      else summary.children += 1;
      if (guest.rsvpState === "PENDING") summary.pending += 1;
      else if (guest.rsvpState === "CONFIRMED") summary.confirmed += 1;
      else summary.declined += 1;
    }
  }
  return summary;
}
