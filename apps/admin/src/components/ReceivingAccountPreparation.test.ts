// @vitest-environment jsdom
import {
  meResponseSchema,
  type ReceivingReadiness,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";

const access: SiteAccess = {
  siteId: "site-one",
  userId: "holder-one",
  membershipId: "membership-one",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    configureReceiving: true,
    manageCatalog: true,
    manageInvitations: true,
    manageMessages: true,
    manageTeam: true,
    readFinance: true,
    requestWithdrawal: false,
  },
};
const ready: ReceivingReadiness = {
  siteId: "site-one",
  mode: "live",
  state: "READY",
  reason: null,
  observedAt: "2026-10-24T20:00:00.000Z",
  destinationVersion: 1,
  catalogEligible: true,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("__APP_ENV__", "production");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function fixture() {
  const actor = meResponseSchema.parse({
    user: {
      id: "holder-one",
      role: "SITE_ADMIN",
      name: "Fixture Holder",
      email: "holder@example.test",
    },
    session: { id: "session-one", expiresAt: "2026-10-25T20:00:00.000Z" },
    siteId: "site-one",
    memberships: [access],
  });
  const snapshot = { status: "verified", sessionEpoch: 1, actor };
  const owner = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    reportFailure: vi.fn(),
    isSuspended: () => false,
  };
  const setup = {
    siteId: "site-one",
    mode: "live",
    policyVersion: "policy-v1",
    holder: { userId: "holder-one", name: "Fixture Holder" },
    isHolder: true,
    consentRecorded: true,
    pixConsentRecorded: true,
    disclosure: receivingSetupDisclosure,
    accountState: "CREATED",
    providerStatus: {
      commercialInfo: "APPROVED",
      bankAccountInfo: "PENDING",
      documentation: "APPROVED",
      general: "APPROVED",
      commercialInfoExpired: false,
      observedAt: "2026-10-24T20:00:00.000Z",
    },
  };
  const request = vi.fn(
    async (
      path: string,
      _options?: { method?: string; body?: unknown },
    ): Promise<unknown> =>
      path === "/v1/me"
        ? actor
        : path.endsWith("/incoming-verification")
          ? { readiness: ready }
          : { setup },
  );
  const ports = {
    owner: owner as never,
    request,
    now: () => Date.parse("2026-10-24T20:00:00.000Z"),
  };
  const changed = vi.fn();
  async function render(readiness: ReceivingReadiness | null) {
    await act(async () => {
      root.render(
        createElement(ReceivingAccountSetup, {
          siteId: "site-one",
          access,
          sessionEpoch: 1,
          ports,
          readiness,
          onReadinessChange: changed,
        }),
      );
    });
  }
  return {
    request,
    render,
    changed,
    posts: () =>
      request.mock.calls.filter(([, options]) => options?.method === "POST"),
  };
}
describe("mounted automatic receiving preparation", () => {
  it("waits for authoritative readiness and does not prepare an already ready account on navigation", async () => {
    const v = fixture();
    await v.render(null);
    expect(v.posts()).toHaveLength(0);
    await v.render(ready);
    expect(v.posts()).toHaveLength(0);
    expect(container.textContent).not.toContain("Configuração indisponível");
    await v.render({ ...ready });
    expect(v.posts()).toHaveLength(0);
  });
  it("automatically prepares a consented unready account once while parent readiness catches up", async () => {
    const v = fixture();
    const pending: ReceivingReadiness = {
      ...ready,
      state: "ONBOARDING",
      reason: "ONBOARDING_REQUIRED",
      catalogEligible: false,
      destinationVersion: null,
    };
    await v.render(pending);
    await vi.waitFor(() => expect(v.posts()).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    await v.render({ ...pending });
    expect(v.posts()).toHaveLength(1);
    await v.render(ready);
    expect(v.posts()).toHaveLength(1);
  });
});
