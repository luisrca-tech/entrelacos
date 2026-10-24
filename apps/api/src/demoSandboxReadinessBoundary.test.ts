import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { assertRecipientFinancialAction } from "./financialAuthorization";
import {
  evaluateReceivingReadiness,
  type ReceivingReadinessInput,
} from "./receivingReadiness";

const now = new Date("2026-10-16T12:00:00.000Z");
const binding = {
  siteId: "demo-wedding",
  provider: "ASAAS",
  operatorReference: "demo-holder",
  environment: "sandbox" as const,
  accountReference: "sandbox-account",
  recipientReference: "sandbox-wallet",
  destinationVersion: 1,
  bankReference: "simulation-checkout-destination",
};
function simulated(withdrawal: boolean): ReceivingReadinessInput {
  return {
    siteId: "demo-wedding",
    isDemo: true,
    environment: "development",
    mode: "sandbox",
    now,
    freshnessMs: 60000,
    providerBinding: binding,
    evidence: {
      ...binding,
      verification: "verified",
      provenance: "simulation",
      accountState: "approved",
      bankState: "verified",
      observedAt: now,
      bankObservedAt: now,
      capabilities: { receiving: true, withdrawal },
      commercialEnabled: true,
    },
  };
}
// Documents the current isolation boundary before adding any operational fixture writer.
// No database, provider credentials, account creation or simulated bank rows are involved.
describe("demo sandbox readiness isolation boundary", () => {
  it("cannot enable demo checkout while keeping simulated withdrawal capability false", () => {
    expect(evaluateReceivingReadiness(simulated(false))).toMatchObject({
      state: "BLOCKED",
      reason: "CAPABILITY_UNAVAILABLE",
      catalogEligible: false,
    });
  });
  it("makes the shared readiness projection ready only after enabling withdrawals", () => {
    expect(evaluateReceivingReadiness(simulated(true))).toMatchObject({
      state: "READY",
      catalogEligible: true,
    });
  });
  it("does not preserve simulation provenance at the shared withdrawal authorization boundary", () => {
    const access: SiteAccess = {
      siteId: "demo-wedding",
      userId: "holder-user",
      membershipId: "membership-one",
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
    const actor = {
      siteId: "demo-wedding",
      userId: "holder-user",
      sessionId: "session-one",
    };
    expect(() =>
      assertRecipientFinancialAction({
        action: "REQUEST_WITHDRAWAL",
        siteId: "demo-wedding",
        environment: "sandbox",
        access,
        actor,
        recipientBinding: {
          siteId: "demo-wedding",
          operatorUserId: "holder-user",
          environment: "sandbox",
          accountReference: binding.accountReference,
          recipientReference: binding.recipientReference,
          destinationVersion: 1,
        },
        recentAuth: {
          ...actor,
          proofKind: "PASSWORD_REAUTHENTICATION",
          verification: "verified",
          provenance: "backend",
          authenticatedAt: now,
          expiresAt: new Date(now.getTime() + 60000),
        },
        readiness: evaluateReceivingReadiness(simulated(true)),
        now,
        maxAuthAgeMs: 60000,
      }),
    ).not.toThrow();
  });
});
