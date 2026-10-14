import type { SiteAccess, WithdrawalIntent } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  loadWithdrawalHistory,
  parseWithdrawalHistory,
} from "./withdrawalHistory";

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
const withdrawal: WithdrawalIntent = {
  id: "withdrawal-a",
  siteId: "wedding-a",
  amountCents: 10000,
  feeCents: 200,
  netCents: 9800,
  currency: "BRL",
  destinationVersion: 1,
  state: "PROCESSING",
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T11:00:00.000Z",
  mode: "sandbox",
};

describe("withdrawal history client", () => {
  it("uses only the selected site's GET with no-store session transport", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ withdrawals: [withdrawal] })),
      );
    await expect(
      loadWithdrawalHistory("wedding-a", access, (path) =>
        apiRequest(path, {}, fetcher),
      ),
    ).resolves.toEqual([withdrawal]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/sites/wedding-a/withdrawals",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  it("accepts an actual empty successful response", async () => {
    await expect(
      loadWithdrawalHistory(
        "wedding-a",
        access,
        vi.fn().mockResolvedValue({ withdrawals: [] }),
      ),
    ).resolves.toEqual([]);
  });
  it.each([
    null,
    { ...access, siteId: "wedding-b" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, membershipId: null },
    { ...access, capabilities: { ...access.capabilities, readFinance: false } },
  ])(
    "denies missing or non-current administrator authority before a request: %j",
    async (candidate) => {
      const request = vi.fn();
      await expect(
        loadWithdrawalHistory(
          "wedding-a",
          candidate as SiteAccess | null,
          request,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { withdrawals: [{ ...withdrawal, siteId: "wedding-b" }] },
    { withdrawals: [{ ...withdrawal, walletId: "private" }] },
    { withdrawals: [withdrawal], bankAccount: "private" },
    { withdrawals: [{ ...withdrawal, netCents: 10000 }] },
    { withdrawals: [{ ...withdrawal, amountCents: 1.5 }] },
    { withdrawals: [{ ...withdrawal, feeCents: -1 }] },
    { withdrawals: [{ ...withdrawal, state: "PAID" }] },
    { withdrawals: [{ ...withdrawal, updatedAt: "invalid" }] },
    { withdrawals: [{ ...withdrawal, updatedAt: "2026-10-12T09:59:59.000Z" }] },
    { withdrawals: [withdrawal, withdrawal] },
    { withdrawals: null },
    {},
  ])(
    "rejects foreign, private, invalid or contradictory records: %j",
    async (payload) => {
      expect(() => parseWithdrawalHistory("wedding-a", payload)).toThrow();
      await expect(
        loadWithdrawalHistory(
          "wedding-a",
          access,
          vi.fn().mockResolvedValue(payload),
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects an invalid site before any transport call", async () => {
    const request = vi.fn();
    await expect(loadWithdrawalHistory("", access, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"),
    new ApiError(403, "MEMBERSHIP_DENIED"),
    new Error("offline"),
  ])(
    "preserves transport failures instead of inventing an empty history",
    async (failure) => {
      await expect(
        loadWithdrawalHistory(
          "wedding-a",
          access,
          vi.fn().mockRejectedValue(failure),
        ),
      ).rejects.toBe(failure);
    },
  );
});
