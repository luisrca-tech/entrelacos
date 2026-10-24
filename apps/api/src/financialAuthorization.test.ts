import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  assertFinancialReadAccess,
  assertRecipientFinancialAction,
  type FinancialActor,
  FinancialAuthorizationError,
  type FinancialRecipientBinding,
  type RecentFinancialAuthenticationEvidence,
  type RecipientFinancialActionInput,
} from "./financialAuthorization";
import {
  createDefaultReceivingReadiness,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";

function adminAccess(): SiteAccess {
  return {
    siteId: "site-one",
    userId: "recipient-user",
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
}

function recipientAction(): RecipientFinancialActionInput & {
  access: SiteAccess;
  actor: FinancialActor;
  recipientBinding: FinancialRecipientBinding;
  recentAuth: RecentFinancialAuthenticationEvidence;
  readiness: ReceivingReadiness;
} {
  return {
    action: "REQUEST_WITHDRAWAL",
    siteId: "site-one",
    environment: "live",
    access: adminAccess(),
    actor: {
      userId: "recipient-user",
      siteId: "site-one",
      sessionId: "session-one",
    },
    recipientBinding: {
      siteId: "site-one",
      operatorUserId: "recipient-user",
      environment: "live",
      accountReference: "account-one",
      recipientReference: "recipient-one",
      destinationVersion: 1,
    },
    recentAuth: {
      userId: "recipient-user",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      verification: "verified",
      provenance: "backend",
      authenticatedAt: new Date("2026-10-12T12:59:00.000Z"),
      expiresAt: new Date("2026-10-12T13:05:00.000Z"),
    },
    readiness: {
      siteId: "site-one",
      state: "READY",
      reason: null,
      observedAt: "2026-10-12T12:59:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "live",
    },
    now: new Date("2026-10-12T13:00:00.000Z"),
    maxAuthAgeMs: 300_000,
  };
}

describe("financial read access", () => {
  it("allows a freshly resolved OWNER with no membership to read, while recipient actions still deny", () => {
    const access = {
      ...adminAccess(),
      membershipId: null,
      membershipRole: "OWNER",
      capabilities: {
        ...adminAccess().capabilities,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    expect(() => assertFinancialReadAccess(access, "site-one")).not.toThrow();
    for (const action of [
      "CONFIGURE_RECEIVING",
      "REQUEST_WITHDRAWAL",
    ] as const) {
      expect(() =>
        assertRecipientFinancialAction({
          ...recipientAction(),
          action,
          access,
        }),
      ).toThrow(expect.objectContaining({ code: "MEMBERSHIP_DENIED" }));
    }
  });
  it("allows the selected site's resolved admin membership with readFinance", () => {
    expect(() =>
      assertFinancialReadAccess(adminAccess(), "site-one"),
    ).not.toThrow();
  });

  it.each([
    null,
    undefined,
    {},
    { membershipRole: "SITE_ADMIN", readFinance: true },
  ])("denies missing or browser-shaped access %j", (access) => {
    expect(() => assertFinancialReadAccess(access, "site-one")).toThrow(
      FinancialAuthorizationError,
    );
    expect(() => assertFinancialReadAccess(access, "site-one")).toThrow(
      expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
    );
  });

  it.each(["SITE_ASSISTANT", "OWNER"] as const)(
    "denies %s even with a membership ID and asserted finance capabilities",
    (membershipRole) => {
      expect(() =>
        assertFinancialReadAccess(
          { ...adminAccess(), membershipRole },
          "site-one",
        ),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
      );
    },
  );

  it("denies cross-site, absent membership and absent read capability", () => {
    const access = adminAccess();
    for (const invalid of [
      { ...access, siteId: "another-site" },
      { ...access, membershipId: null },
      {
        ...access,
        capabilities: { ...access.capabilities, readFinance: false },
      },
      {
        ...access,
        capabilities: { ...access.capabilities, readFinance: "true" },
      },
      { ...access, role: "SITE_ADMIN" },
    ]) {
      expect(() => assertFinancialReadAccess(invalid, "site-one")).toThrow(
        expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
      );
    }
  });
});

describe("recipient financial actions", () => {
  it("rejects initial receiving session evidence for withdrawals", () => {
    const input = recipientAction();
    Object.assign(input.recentAuth ?? {}, {
      proofKind: "SESSION_AUTHENTICATION",
    });
    expect(() => assertRecipientFinancialAction(input)).toThrow(
      expect.objectContaining({ code: "RECENT_AUTH_REQUIRED" }),
    );
  });
  it("authorizes a withdrawal from B's false flag only after recipient, proof and READY checks", () => {
    const input = recipientAction();
    expect(input.access.capabilities.requestWithdrawal).toBe(false);
    expect(() => assertRecipientFinancialAction(input)).not.toThrow();
    expect(input.access.capabilities.requestWithdrawal).toBe(false);
  });

  it("allows receiving configuration before READY while keeping withdrawal closed", () => {
    const input = recipientAction();
    input.action = "CONFIGURE_RECEIVING";
    input.readiness = createDefaultReceivingReadiness("site-one");
    expect(() => assertRecipientFinancialAction(input)).not.toThrow();
    expect(() =>
      assertRecipientFinancialAction({ ...input, readiness: undefined }),
    ).not.toThrow();
    input.action = "REQUEST_WITHDRAWAL";
    expect(() => assertRecipientFinancialAction(input)).toThrow(
      ReceivingReadinessServiceError,
    );
  });

  it.each(["SITE_ASSISTANT", "OWNER"] as const)(
    "denies %s actions even with every flag and financial proof",
    (membershipRole) => {
      const input = recipientAction();
      input.access.membershipRole = membershipRole;
      input.access.capabilities.requestWithdrawal = true;
      expect(() => assertRecipientFinancialAction(input)).toThrow(
        expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
      );
    },
  );

  it("requires the action's explicit operational authority", () => {
    const withdrawal = recipientAction();
    withdrawal.access.capabilities.readFinance = false;
    withdrawal.access.capabilities.requestWithdrawal = true;
    expect(() => assertRecipientFinancialAction(withdrawal)).toThrow(
      expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
    );

    const configuration = recipientAction();
    configuration.action = "CONFIGURE_RECEIVING";
    configuration.access.capabilities.configureReceiving = false;
    expect(() => assertRecipientFinancialAction(configuration)).toThrow(
      expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
    );
  });

  it("binds financial membership to the selected site and authenticated actor", () => {
    const original = recipientAction();
    for (const input of [
      { ...original, access: null },
      { ...original, access: { ...original.access, membershipId: null } },
      { ...original, access: { ...original.access, siteId: "another-site" } },
      { ...original, actor: null },
      { ...original, actor: { ...original.actor, userId: "another-user" } },
      { ...original, actor: { ...original.actor, siteId: "another-site" } },
    ]) {
      expect(() => assertRecipientFinancialAction(input)).toThrow(
        expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
      );
    }
  });

  it("never implicitly designates a recipient from admin role or withdrawal flag", () => {
    const original = recipientAction();
    original.access.capabilities.requestWithdrawal = true;
    for (const recipientBinding of [
      null,
      { ...original.recipientBinding, siteId: "another-site" },
      { ...original.recipientBinding, operatorUserId: "another-user" },
      { ...original.recipientBinding, accountReference: " " },
      { ...original.recipientBinding, recipientReference: "" },
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, recipientBinding }),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "RECIPIENT_REQUIRED" }),
      );
    }
  });

  it("rejects a designation in another environment or without a valid destination version", () => {
    const original = recipientAction();
    for (const recipientBinding of [
      { ...original.recipientBinding, environment: "sandbox" as const },
      { ...original.recipientBinding, destinationVersion: 0 },
      { ...original.recipientBinding, destinationVersion: 0.5 },
      {
        ...original.recipientBinding,
        destinationVersion: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, recipientBinding }),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          code: "DESTINATION_UNVERIFIED",
        }),
      );
    }
  });

  it("requires authoritative READY tied to the current site, environment and destination", () => {
    const original = recipientAction();
    for (const readiness of [
      null,
      undefined,
      createDefaultReceivingReadiness("site-one"),
      { catalogEligible: true } as never,
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, readiness }),
      ).toThrow(
        expect.objectContaining({ status: 409, code: "RECEIVING_NOT_READY" }),
      );
    }
    for (const readiness of [
      { ...original.readiness, siteId: "another-site" },
      { ...original.readiness, mode: "sandbox" as const },
      { ...original.readiness, destinationVersion: 2 },
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, readiness }),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          code: "DESTINATION_UNVERIFIED",
        }),
      );
    }
  });

  it("does not treat a withdrawal flag or a browser proof as recent authentication", () => {
    const original = recipientAction();
    original.access.capabilities.requestWithdrawal = true;
    for (const recentAuth of [
      null,
      { verified: true, authenticatedAt: original.now } as never,
      { ...original.recentAuth, provenance: "client" as never },
      { ...original.recentAuth, verification: "unverified" as const },
      { ...original.recentAuth, proofKind: "SESSION_CREATED" as never },
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, recentAuth }),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
      );
    }
  });

  it.each(["userId", "siteId", "sessionId"] as const)(
    "rejects a recent proof tied to another %s",
    (field) => {
      const input = recipientAction();
      input.recentAuth[field] = "another-reference";
      expect(() => assertRecipientFinancialAction(input)).toThrow(
        expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
      );
    },
  );

  it("requires a nonempty authenticated session ID", () => {
    const input = recipientAction();
    input.actor.sessionId = " ";
    input.recentAuth.sessionId = " ";
    expect(() => assertRecipientFinancialAction(input)).toThrow(
      expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
    );
  });

  it("rejects stale, future, missing and invalid authentication observations", () => {
    const original = recipientAction();
    for (const recentAuth of [
      { ...original.recentAuth, authenticatedAt: null },
      { ...original.recentAuth, authenticatedAt: new Date(Number.NaN) },
      {
        ...original.recentAuth,
        authenticatedAt: new Date("2026-10-12T13:00:00.001Z"),
      },
      {
        ...original.recentAuth,
        authenticatedAt: new Date("2026-10-12T12:54:59.999Z"),
      },
      {
        ...original.recentAuth,
        authenticatedAt: "2026-10-12T12:59:00.000Z" as never,
      },
      { ...original.recentAuth, expiresAt: null },
      { ...original.recentAuth, expiresAt: new Date(Number.NaN) },
      {
        ...original.recentAuth,
        expiresAt: new Date("2026-10-12T13:00:00.000Z"),
      },
      {
        ...original.recentAuth,
        expiresAt: new Date("2026-10-12T12:58:00.000Z"),
      },
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, recentAuth }),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
      );
    }
  });

  it("validates the injected clock and authentication age policy", () => {
    const original = recipientAction();
    expect(() =>
      assertRecipientFinancialAction({
        ...original,
        now: new Date(Number.NaN),
      }),
    ).toThrow(
      expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
    );
    for (const maxAuthAgeMs of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        assertRecipientFinancialAction({ ...original, maxAuthAgeMs }),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
      );
    }
  });

  it("accepts completed MFA reauthentication exactly at the allowed age boundary", () => {
    const input = recipientAction();
    input.recentAuth.proofKind = "MFA_REAUTHENTICATION";
    input.recentAuth.authenticatedAt = new Date("2026-10-12T12:55:00.000Z");
    expect(() => assertRecipientFinancialAction(input)).not.toThrow();
  });

  it("requires designation and recent authentication even for pre-readiness configuration", () => {
    const input = recipientAction();
    input.action = "CONFIGURE_RECEIVING";
    input.readiness = createDefaultReceivingReadiness("site-one");
    expect(() =>
      assertRecipientFinancialAction({ ...input, recipientBinding: null }),
    ).toThrow(
      expect.objectContaining({ status: 403, code: "RECIPIENT_REQUIRED" }),
    );
    expect(() =>
      assertRecipientFinancialAction({ ...input, recentAuth: null }),
    ).toThrow(
      expect.objectContaining({ status: 403, code: "RECENT_AUTH_REQUIRED" }),
    );
  });

  it("denies unsupported actions and recipient environments", () => {
    const input = recipientAction();
    expect(() =>
      assertRecipientFinancialAction({ ...input, action: "TRANSFER" as never }),
    ).toThrow(
      expect.objectContaining({ status: 403, code: "MEMBERSHIP_DENIED" }),
    );
    input.action = "CONFIGURE_RECEIVING";
    input.environment = "unknown" as never;
    input.recipientBinding.environment = "unknown" as never;
    expect(() => assertRecipientFinancialAction(input)).toThrow(
      expect.objectContaining({ status: 409, code: "DESTINATION_UNVERIFIED" }),
    );
  });
});
