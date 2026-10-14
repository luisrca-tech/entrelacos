import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import { loadGiftsReadiness } from "./giftsReadiness";
import { panelActorOwner } from "./panelActor";
import { ReceivingSectionView, readReceivingSection } from "./ReceivingSection";

vi.mock("./ReceivingSetup", () => ({
  ReceivingSetup: ({ sessionEpoch }: { sessionEpoch: number | null }) =>
    createElement("div", { "data-setup-epoch": sessionEpoch }),
}));

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
vi.mock("./giftsReadiness", () => ({ loadGiftsReadiness: vi.fn() }));
vi.mock("../features/receiving/ReceivingStatusCard", () => ({
  ReceivingStatusCard: ({ access }: { access: SiteAccess | null }) =>
    createElement("div", { "data-receiving-access": !!access }),
}));
vi.mock("./FinanceSection", () => ({
  FinanceSection: ({
    access,
    sessionEpoch,
  }: {
    access: SiteAccess | null;
    sessionEpoch: number | null;
  }) =>
    createElement("div", {
      "data-finance-access": !!access,
      "data-finance-epoch": sessionEpoch,
    }),
}));
const access: SiteAccess = {
  siteId: "wedding-1",
  userId: "admin-1",
  membershipId: "membership-1",
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
const readiness: ReceivingReadiness = {
  siteId: "wedding-1",
  state: "NOT_CONFIGURED",
  reason: "PROVIDER_DISABLED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "disabled",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
});
afterEach(() => {
  panelActorOwner.invalidate(false);
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function verify() {
  vi.mocked(apiRequest).mockResolvedValueOnce({
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.test",
      role: "SITE_ADMIN",
    },
    session: { id: "session-1", expiresAt: "2026-10-19T00:00:00.000Z" },
    siteId: "wedding-1",
    memberships: [access],
  });
  await panelActorOwner.load();
  return panelActorOwner.getSnapshot().sessionEpoch as number;
}
describe("receiving asynchronous session ownership", () => {
  it("does not start readiness while authority is unknown", async () => {
    await readReceivingSection("wedding-1", null, vi.fn());
    expect(loadGiftsReadiness).not.toHaveBeenCalled();
  });
  it("discards readiness settling after the session is invalidated", async () => {
    const epoch = await verify();
    let resolve!: (value: ReceivingReadiness) => void;
    vi.mocked(loadGiftsReadiness).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const receive = vi.fn();
    const work = readReceivingSection("wedding-1", epoch, receive);
    panelActorOwner.invalidate(false);
    resolve(readiness);
    await work;
    expect(receive).not.toHaveBeenCalled();
  });
  it("discards a response from an unmounted effect", async () => {
    const epoch = await verify();
    let resolve!: (value: ReceivingReadiness) => void;
    let active = true;
    vi.mocked(loadGiftsReadiness).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const receive = vi.fn();
    const work = readReceivingSection(
      "wedding-1",
      epoch,
      receive,
      () => active,
    );
    active = false;
    resolve(readiness);
    await work;
    expect(receive).not.toHaveBeenCalled();
  });
  it("invalidates a current resource denial before exposing its result", async () => {
    const epoch = await verify();
    vi.mocked(loadGiftsReadiness).mockRejectedValueOnce(
      new ApiError(403, "ACCESS_DENIED"),
    );
    const receive = vi.fn();
    await readReceivingSection("wedding-1", epoch, receive);
    expect(panelActorOwner.getSnapshot().status).toBe("denied");
    expect(receive).not.toHaveBeenCalled();
  });
  it("publishes current readiness and keeps unavailable reads retryable", async () => {
    const epoch = await verify();
    const value = readiness;
    vi.mocked(loadGiftsReadiness).mockResolvedValueOnce(value);
    const receive = vi.fn();
    await readReceivingSection("wedding-1", epoch, receive);
    expect(receive).toHaveBeenCalledWith({
      siteId: "wedding-1",
      epoch,
      readiness: value,
      failed: false,
    });
    vi.mocked(loadGiftsReadiness).mockRejectedValueOnce(new Error("offline"));
    await readReceivingSection("wedding-1", epoch, receive);
    expect(receive).toHaveBeenLastCalledWith({
      siteId: "wedding-1",
      epoch,
      readiness: null,
      failed: true,
    });
  });
});
describe("receiving session boundary", () => {
  it("mounts onboarding only for a verified same-site configuring administrator", () => {
    expect(render(null)).not.toContain("data-setup-epoch");
    expect(render(9)).toContain('data-setup-epoch="9"');
    expect(
      render(9, { ...access, membershipRole: "SITE_ASSISTANT" }),
    ).not.toContain("data-setup-epoch");
    expect(
      render(9, {
        ...access,
        capabilities: { ...access.capabilities, configureReceiving: false },
      }),
    ).not.toContain("data-setup-epoch");
  });
  function render(sessionEpoch: number | null, candidate = access) {
    return renderToStaticMarkup(
      createElement(ReceivingSectionView, {
        siteId: "wedding-1",
        access: candidate,
        sessionEpoch,
        readiness: null,
        failed: false,
        onRetry: vi.fn(),
      }),
    );
  }
  it("withholds receiving and finance authority while the session is unverified", () => {
    expect(render(null)).toContain('data-receiving-access="false"');
    expect(render(null)).toContain('data-finance-access="false"');
  });
  it("passes current same-site access to the existing read views", () => {
    expect(render(9)).toContain('data-finance-epoch="9"');
    expect(render(9)).toContain('data-finance-access="true"');
    expect(render(9)).toContain('data-receiving-access="true"');
  });
  it("denies a different-site membership", () => {
    expect(render(9, { ...access, siteId: "other" })).toContain(
      'data-finance-access="false"',
    );
  });
});
