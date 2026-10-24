import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  getPanelLanding,
  getSelectedSiteAccess,
  loadAssignedSiteName,
} from "./panelMemberships";

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "user-a",
  membershipId: "membership-a",
  membershipRole: "SITE_ASSISTANT",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: false,
    readFinance: false,
    configureReceiving: false,
    requestWithdrawal: false,
  },
};
const actor: MeResponse = {
  user: {
    id: "user-a",
    name: "Ana",
    email: "ana@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2026-10-19T00:00:00.000Z" },
  siteId: null,
  memberships: [access],
};

describe("panel membership selection", () => {
  it("loads the authoritative wedding name and refuses another site's response", async () => {
    const site = {
      id: "wedding-a",
      displayName: "Ana e João",
      coupleNames: ["Ana", "João"],
      eventDate: "2027-09-18",
      lifecycle: "DRAFT",
      previousLifecycle: null,
      publicationState: "UNPUBLISHED",
      isDemo: false,
      publicUrl: null,
      termStartsOn: null,
      termEndsOn: null,
      rsvpDeadlineAt: null,
      rsvpDeadlineTimezone: null,
    };
    const request = vi.fn().mockResolvedValue({ site });
    await expect(loadAssignedSiteName("wedding-a", request)).resolves.toBe(
      "Ana e João",
    );
    expect(request).toHaveBeenCalledWith("/v1/sites/wedding-a");
    request.mockResolvedValue({ site: { ...site, id: "wedding-b" } });
    await expect(loadAssignedSiteName("wedding-a", request)).rejects.toThrow();
  });
  it("routes only platform owners to the owner site list", () => {
    expect(
      getPanelLanding({ ...actor, user: { ...actor.user, role: "OWNER" } }),
    ).toEqual({ kind: "OWNER" });
    expect(getPanelLanding({ ...actor, memberships: [] })).toEqual({
      kind: "EMPTY",
    });
    expect(
      getPanelLanding({
        ...actor,
        user: { ...actor.user, role: "SITE_ASSISTANT" },
        memberships: [],
      }),
    ).toEqual({ kind: "EMPTY" });
  });
  it("redirects one site and selects among multiple sites without first-row fallback", () => {
    expect(getPanelLanding(actor)).toEqual({
      kind: "SITE",
      siteId: "wedding-a",
    });
    expect(
      getPanelLanding({
        ...actor,
        memberships: [
          access,
          { ...access, siteId: "wedding-b", membershipId: "membership-b" },
        ],
      }),
    ).toEqual({ kind: "SELECT" });
  });
  it("uses the selected membership's permissions and rejects another site or user", () => {
    expect(
      getSelectedSiteAccess(actor, "wedding-a")?.capabilities.readFinance,
    ).toBe(false);
    expect(getSelectedSiteAccess(actor, "wedding-b")).toBeNull();
    expect(
      getSelectedSiteAccess(
        { ...actor, memberships: [{ ...access, userId: "user-b" }] },
        "wedding-a",
      ),
    ).toBeNull();
  });
});
