import type { SiteAccess } from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelActorOwner } from "./panelActor";
import { loadReceivingOwnerAccess } from "./receivingOwnerAccess";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const selected: SiteAccess = {
  siteId: "demo-wedding",
  userId: "owner-one",
  membershipRole: "OWNER",
  membershipId: null,
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: false,
    requestWithdrawal: false,
  },
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function fixture(role: "OWNER" | "SITE_ADMIN" = "OWNER") {
  const owner = createPanelActorOwner({
    request: async () => ({
      user: {
        id: "owner-one",
        name: "Owner",
        email: "owner@example.test",
        role,
      },
      session: { id: "session-one", expiresAt: "2026-10-18T12:00:00.000Z" },
      siteId: null,
      memberships: [],
    }),
    now: () => now,
  });
  cleanup.push(() => owner.dispose());
  await owner.load();
  const request = vi.fn(async (): Promise<unknown> => ({ access: selected }));
  return {
    owner,
    request,
    epoch: owner.getSnapshot().sessionEpoch,
    ports: { owner, request, now: () => now },
  };
}
describe("server resolved owner receiving access", () => {
  it("loads actual selected-site access for an OWNER whose session has no memberships", async () => {
    const v = await fixture();
    expect(
      await loadReceivingOwnerAccess("demo-wedding", v.epoch, v.ports),
    ).toEqual(selected);
    expect(v.request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/demo-wedding/access",
    );
  });
  it("does not infer OWNER authority from a browser scope or membership", async () => {
    const v = await fixture("SITE_ADMIN");
    expect(
      await loadReceivingOwnerAccess("demo-wedding", v.epoch, v.ports),
    ).toBeNull();
    expect(v.request).not.toHaveBeenCalled();
  });
  it.each([
    { ...selected, siteId: "foreign-site" },
    { ...selected, userId: "foreign-user" },
    {
      ...selected,
      membershipRole: "SITE_ADMIN",
      membershipId: "forged-membership",
    },
    {
      ...selected,
      capabilities: { ...selected.capabilities, configureReceiving: true },
    },
    {
      ...selected,
      capabilities: { ...selected.capabilities, readFinance: false },
    },
  ])(
    "rejects incompatible server scope instead of manufacturing permissions",
    async (access) => {
      const v = await fixture();
      v.request.mockResolvedValueOnce({ access });
      await expect(
        loadReceivingOwnerAccess("demo-wedding", v.epoch, v.ports),
      ).rejects.toThrow();
    },
  );
  it("discards selected-site access settling after the session changed", async () => {
    const v = await fixture();
    let resolve!: (value: unknown) => void;
    v.request.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const result = loadReceivingOwnerAccess("demo-wedding", v.epoch, v.ports);
    v.owner.invalidate(false);
    resolve({ access: selected });
    expect(await result).toBeNull();
  });
});
