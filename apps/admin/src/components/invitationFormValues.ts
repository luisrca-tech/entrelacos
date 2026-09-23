import {
  formatInvitationPhoneInput,
  type InvitationRecord,
  type invitationCreateInputSchema,
} from "@entrelacos/contracts";
import type { z } from "zod";

export function invitationFormValues(
  invitation: InvitationRecord | null,
): z.input<typeof invitationCreateInputSchema> {
  if (!invitation) {
    return {
      name: "",
      phone: "",
      email: "",
      guests: [{ fullName: "", guestType: "ADULT" }],
    };
  }
  return {
    name: invitation.name,
    phone: formatInvitationPhoneInput(invitation.phone),
    email: invitation.email ?? "",
    guests: invitation.guests.map((guest) => ({
      id: guest.id,
      fullName: guest.fullName,
      guestType: guest.guestType,
    })),
  };
}
