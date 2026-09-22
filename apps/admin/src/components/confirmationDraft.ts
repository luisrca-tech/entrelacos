import type {
  AdminRsvpWriteInput,
  RsvpState,
  SiteRsvpResponse,
} from "@entrelacos/contracts";

export function pendingAdminRsvpUpdates(
  view: SiteRsvpResponse,
  draft: Record<string, RsvpState>,
): AdminRsvpWriteInput["guests"] {
  return view.invitations.flatMap((invitation) =>
    invitation.guests.flatMap((guest) => {
      const state = draft[guest.id];
      return state && state !== guest.state
        ? [{ guestId: guest.id, state, expectedRevision: guest.revision }]
        : [];
    }),
  );
}
