export type RsvpStatus = "PENDING" | "CONFIRMED" | "DECLINED";

export type RsvpGuestSnapshot = {
  guestId: string;
  state: RsvpStatus;
  revision: number;
};

export type RsvpDraft = Record<
  string,
  {
    state: RsvpStatus;
    persistedState: RsvpStatus;
    revision: number;
  }
>;

export function createRsvpDraft(guests: RsvpGuestSnapshot[]): RsvpDraft {
  return Object.fromEntries(
    guests.map((guest) => [
      guest.guestId,
      {
        state: guest.state,
        persistedState: guest.state,
        revision: guest.revision,
      },
    ]),
  );
}

export function setDraftStatus(
  draft: RsvpDraft,
  guestId: string,
  state: RsvpStatus,
): RsvpDraft {
  const guest = draft[guestId];
  return guest ? { ...draft, [guestId]: { ...guest, state } } : draft;
}

export function confirmAllDraft(draft: RsvpDraft): RsvpDraft {
  return Object.fromEntries(
    Object.entries(draft).map(([guestId, guest]) => [
      guestId,
      { ...guest, state: "CONFIRMED" as const },
    ]),
  );
}

export function pendingRsvpUpdates(draft: RsvpDraft) {
  return Object.entries(draft)
    .filter(([, guest]) => guest.state !== guest.persistedState)
    .map(([guestId, guest]) => ({
      guestId,
      state: guest.state,
      expectedRevision: guest.revision,
    }));
}

export function reconcileRsvpDraft(
  draft: RsvpDraft,
  current: RsvpGuestSnapshot[],
): RsvpDraft {
  return Object.fromEntries(
    current.map((guest) => [
      guest.guestId,
      {
        state: draft[guest.guestId]?.state ?? guest.state,
        persistedState: guest.state,
        revision: guest.revision,
      },
    ]),
  );
}
