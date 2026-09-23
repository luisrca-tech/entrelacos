import type { SiteRsvpResponse } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { pendingAdminRsvpUpdates } from "./confirmationDraft";

const view: SiteRsvpResponse = {
  siteId: "site-1",
  lifecycle: "ACTIVE",
  deadlineAt: null,
  deadlineTimezone: null,
  totals: { pending: 1, confirmed: 1, declined: 0 },
  invitations: [
    {
      id: "invitation-1",
      name: "Família Silva",
      totals: { pending: 1, confirmed: 1, declined: 0 },
      guests: [
        {
          id: "guest-1",
          fullName: "Ana",
          guestType: "ADULT",
          state: "CONFIRMED",
          revision: 2,
        },
        {
          id: "guest-2",
          fullName: "Bia",
          guestType: "CHILD",
          state: "PENDING",
          revision: 0,
        },
      ],
    },
  ],
};

describe("admin confirmation draft", () => {
  it("sends only changed guests with their current revisions", () => {
    expect(pendingAdminRsvpUpdates(view, { "guest-2": "DECLINED" })).toEqual([
      { guestId: "guest-2", state: "DECLINED", expectedRevision: 0 },
    ]);
  });

  it("omits unchanged and removed guests", () => {
    expect(
      pendingAdminRsvpUpdates(view, {
        "guest-1": "CONFIRMED",
        removed: "DECLINED",
      }),
    ).toEqual([]);
  });
});
