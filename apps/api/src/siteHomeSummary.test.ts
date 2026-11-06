import type { SiteAccess } from "@entrelacos/contracts";
import { expect, it, vi } from "vitest";
import { readSiteHomeSummary } from "./siteHomeSummary";

const adminAccess: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "membership-a",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: true,
  },
};

it("keeps non-financial counts when the receiving status cannot be read", async () => {
  const execute = vi.fn().mockResolvedValue({
    rows: [
      {
        invitations: {
          total: 2,
          confirmed: 3,
          pending: 1,
          declined: 0,
          adults: 3,
          children: 1,
          byStatus: { confirmed: 1, pending: 1, declined: 0, partial: 0 },
        },
        messages: 4,
        publishedGifts: 5,
        peopleWithAccess: 2,
      },
    ],
  });
  const readReadiness = vi
    .fn()
    .mockRejectedValue(new Error("provider unavailable"));

  await expect(
    readSiteHomeSummary({ execute } as never, adminAccess, readReadiness),
  ).resolves.toEqual({
    invitations: {
      total: 2,
      confirmed: 3,
      pending: 1,
      declined: 0,
      adults: 3,
      children: 1,
      byStatus: { confirmed: 1, pending: 1, declined: 0, partial: 0 },
    },
    messages: 4,
    publishedGifts: 5,
    peopleWithAccess: 2,
  });
  expect(execute).toHaveBeenCalledOnce();
});
