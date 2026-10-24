import type { SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import { loadGiftsReadiness } from "./giftsReadiness";
import { panelActorOwner } from "./panelActor";
import { readHomeReceiving, SiteHomeView } from "./SiteHome";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { siteId: string };
    children: React.ReactNode;
  }) =>
    createElement(
      "a",
      { ...props, href: params ? to.replace("$siteId", params.siteId) : to },
      children,
    ),
}));
vi.mock("./giftsReadiness", () => ({ loadGiftsReadiness: vi.fn() }));
vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
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
const site = {
  id: "wedding-a",
  displayName: "Ana e João",
  coupleNames: ["Ana", "João"],
  eventDate: "2027-09-18",
  lifecycle: "ACTIVE" as const,
  publicationState: "PUBLISHED" as const,
  isDemo: false,
  publicUrl: "https://wedding.example.test",
  termEndsOn: null,
  rsvpDeadlineAt: null,
};
const readiness = {
  siteId: site.id,
  state: "NOT_CONFIGURED",
  reason: "NOT_CONFIGURED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "sandbox",
} as const;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
});
afterEach(() => {
  panelActorOwner.invalidate(false);
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function verify() {
  vi.mocked(apiRequest).mockResolvedValueOnce({
    user: {
      id: "admin-a",
      name: "Ana",
      email: "ana@example.test",
      role: "SITE_ADMIN",
    },
    session: { id: "session-a", expiresAt: "2026-10-25T12:00:00Z" },
    siteId: null,
    memberships: [access],
  });
  await panelActorOwner.load();
  const epoch = panelActorOwner.getSnapshot().sessionEpoch;
  if (epoch === null) throw new Error("Expected verified test actor");
  return epoch;
}
describe("site home", () => {
  it("discards a late status when the verified session has already expired", async () => {
    const epoch = await verify();
    let resolve!: (value: typeof readiness) => void;
    vi.mocked(loadGiftsReadiness).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const receive = vi.fn();
    const work = readHomeReceiving(
      { siteId: site.id, access, owner: false, sessionEpoch: epoch },
      receive,
    );
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    resolve(readiness);
    await work;
    expect(receive).not.toHaveBeenCalled();
  });
  it("explains available areas with a real next action and no made-up totals", () => {
    const html = renderToStaticMarkup(
      createElement(SiteHomeView, {
        site,
        access,
        owner: false,
        readiness,
        loading: false,
        failed: false,
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain("Prepare os recebimentos dos presentes");
    expect(html).toContain("/sites/wedding-a/receiving/activation");
    expect(html).toContain("Organize os convidados");
    expect(html).not.toContain("Configurações");
    expect(html).not.toContain("0 convidados");
  });
  it("keeps finance and owner guidance out of assistant orientation", () => {
    const assistant = {
      ...access,
      membershipRole: "SITE_ASSISTANT" as const,
      capabilities: {
        ...access.capabilities,
        configureReceiving: false,
        readFinance: false,
        manageTeam: false,
      },
    };
    const html = renderToStaticMarkup(
      createElement(SiteHomeView, {
        site,
        access: assistant,
        owner: false,
        readiness: null,
        loading: false,
        failed: false,
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain("Organizar convites");
    expect(html).not.toContain("/receiving");
    expect(html).not.toContain("/settings");
    expect(html).not.toContain("saldo");
  });
  it("never requests receiving status without a verified matching epoch", async () => {
    await readHomeReceiving(
      { siteId: site.id, access, owner: false, sessionEpoch: null },
      vi.fn(),
    );
    expect(loadGiftsReadiness).not.toHaveBeenCalled();
  });
  it("publishes a current response but discards results after unmount or invalidation", async () => {
    const epoch = await verify();
    vi.mocked(loadGiftsReadiness).mockResolvedValueOnce(readiness);
    const receive = vi.fn();
    await readHomeReceiving(
      { siteId: site.id, access, owner: false, sessionEpoch: epoch },
      receive,
    );
    expect(receive).toHaveBeenCalledWith(readiness, false);
    let resolve!: (value: typeof readiness) => void;
    vi.mocked(loadGiftsReadiness).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const stale = vi.fn();
    const work = readHomeReceiving(
      { siteId: site.id, access, owner: false, sessionEpoch: epoch },
      stale,
    );
    panelActorOwner.invalidate(false);
    resolve(readiness);
    await work;
    expect(stale).not.toHaveBeenCalled();
  });
  it("does not request finance for an assistant even if site IDs match", async () => {
    const epoch = await verify();
    const receive = vi.fn();
    await readHomeReceiving(
      {
        siteId: site.id,
        access: {
          ...access,
          membershipRole: "SITE_ASSISTANT",
          capabilities: {
            ...access.capabilities,
            configureReceiving: false,
            readFinance: false,
          },
        },
        owner: false,
        sessionEpoch: epoch,
      },
      receive,
    );
    expect(loadGiftsReadiness).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });
  it("keeps orientation usable after an optional receiving read fails", async () => {
    const epoch = await verify();
    vi.mocked(loadGiftsReadiness).mockRejectedValueOnce(new Error("Offline"));
    const receive = vi.fn();
    await readHomeReceiving(
      { siteId: site.id, access, owner: false, sessionEpoch: epoch },
      receive,
    );
    expect(receive).toHaveBeenCalledWith(null, true);
    expect(panelActorOwner.getSnapshot().status).toBe("verified");
  });
});
