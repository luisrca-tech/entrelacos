import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { loadFinancialOverview } from "./financialOverview";

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};
const overview = {
  siteId: "wedding-a",
  currency: "BRL",
  nominalReceivedCents: 10000,
  netReceivedCents: 10000,
  processingCents: 300,
  commissionCents: 200,
  awaitingReleaseCents: 10000,
  availableCents: null,
  pendingCommitmentsCents: 0,
  withdrawnCents: 0,
  refundedCents: 0,
  synchronizedAt: null,
  availability: "UNKNOWN",
  mode: "sandbox",
};

describe("financial overview client", () => {
  it("loads only the selected site's strict server projection", async () => {
    const request = vi.fn().mockResolvedValue({ overview });
    await expect(
      loadFinancialOverview("wedding-a", access, request),
    ).resolves.toEqual(overview);
    expect(request).toHaveBeenCalledWith("/v1/sites/wedding-a/finance");
  });
  it("does not fetch for owner, assistant, missing or mismatched authority", async () => {
    for (const candidate of [
      null,
      { ...access, siteId: "wedding-b" },
      { ...access, membershipRole: "OWNER" },
      { ...access, membershipRole: "SITE_ASSISTANT" },
      { ...access, membershipId: null },
      {
        ...access,
        capabilities: { ...access.capabilities, readFinance: false },
      },
    ]) {
      const request = vi.fn();
      await expect(
        loadFinancialOverview(
          "wedding-a",
          candidate as SiteAccess | null,
          request,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });
  it("rejects foreign, private and contradictory projections", async () => {
    for (const data of [
      { ...overview, siteId: "wedding-b" },
      { ...overview, walletId: "private" },
      { ...overview, availableCents: 0 },
    ]) {
      await expect(
        loadFinancialOverview(
          "wedding-a",
          access,
          vi.fn().mockResolvedValue({ overview: data }),
        ),
      ).rejects.toThrow();
    }
  });
  it("keeps disabled provider and network failures unavailable", async () => {
    for (const failure of [
      new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"),
      new Error("offline"),
    ])
      await expect(
        loadFinancialOverview(
          "wedding-a",
          access,
          vi.fn().mockRejectedValue(failure),
        ),
      ).rejects.toBe(failure);
  });
});
