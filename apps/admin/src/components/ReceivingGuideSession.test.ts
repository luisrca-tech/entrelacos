// @vitest-environment jsdom
import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import { loadGiftsReadiness } from "./giftsReadiness";
import { panelActorOwner } from "./panelActor";
import { ReceivingSection } from "./ReceivingSection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) =>
    createElement("a", null, children),
}));
vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
vi.mock("./giftsReadiness", () => ({ loadGiftsReadiness: vi.fn() }));
vi.mock("./FinanceSection", () => ({ FinanceSection: vi.fn(() => null) }));
vi.mock("./ReceivingAccountSetup", () => ({
  ReceivingAccountSetup: vi.fn(() => null),
}));

import { FinanceSection } from "./FinanceSection";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";

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
  reason: "NOT_CONFIGURED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "sandbox",
};
let root: Root;
let container: HTMLDivElement;
let epoch: number;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__APP_ENV__", "development");
  vi.mocked(apiRequest).mockResolvedValueOnce({
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.test",
      role: "SITE_ADMIN",
    },
    session: {
      id: "session-1",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    siteId: "wedding-1",
    memberships: [access],
  });
  await panelActorOwner.load();
  epoch = panelActorOwner.getSnapshot().sessionEpoch as number;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  panelActorOwner.invalidate(false);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
function mount(candidate = access) {
  return act(async () =>
    root.render(
      createElement(ReceivingSection, {
        siteId: "wedding-1",
        access: candidate,
        sessionEpoch: epoch,
        guide: true,
      }),
    ),
  );
}

describe("receiving guide authorized runtime context", () => {
  it("uses the existing readiness read without mounting financial actions", async () => {
    vi.mocked(loadGiftsReadiness).mockResolvedValueOnce(readiness);
    await mount();
    expect(loadGiftsReadiness).toHaveBeenCalledExactlyOnceWith("wedding-1");
    expect(container.innerHTML).toContain(
      "https://sandbox.asaas.com/login/auth",
    );
    expect(container.textContent).toContain("e-mail da conta principal");
    expect(FinanceSection).not.toHaveBeenCalled();
    expect(ReceivingAccountSetup).not.toHaveBeenCalled();
  });
  it("does not expose an environment after readiness fails", async () => {
    vi.mocked(loadGiftsReadiness).mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(container.innerHTML).not.toContain("/login/auth");
    expect(container.textContent).not.toContain("e-mail da conta principal");
  });
  it("does not request provider context for a different-site membership", async () => {
    await mount({ ...access, siteId: "other" });
    expect(loadGiftsReadiness).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("/login/auth");
  });
  it("discards provider context when the session expires during the read", async () => {
    let resolve!: (value: ReceivingReadiness) => void;
    vi.mocked(loadGiftsReadiness).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await mount();
    panelActorOwner.invalidate(false);
    await act(async () => {
      resolve(readiness);
    });
    expect(container.innerHTML).not.toContain("/login/auth");
    expect(container.textContent).not.toContain("e-mail da conta principal");
  });
});
