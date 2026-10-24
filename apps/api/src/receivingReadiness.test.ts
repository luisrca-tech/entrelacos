import { describe, expect, it } from "vitest";
import {
  assertReceivingReady,
  createDefaultReceivingReadiness,
  evaluateReceivingReadiness,
  type ReceivingEvidence,
  type ReceivingProviderBinding,
  type ReceivingReadinessInput,
  ReceivingReadinessServiceError,
} from "./receivingReadiness";

function readyInput(): ReceivingReadinessInput & {
  providerBinding: ReceivingProviderBinding;
  evidence: ReceivingEvidence;
} {
  const providerBinding = {
    siteId: "site-one",
    provider: "provider-one",
    operatorReference: "operator-one",
    environment: "live" as const,
    accountReference: "account-one",
    recipientReference: "recipient-one",
    destinationVersion: 1,
    bankReference: "bank-one",
  };
  return {
    siteId: "site-one",
    isDemo: false,
    environment: "production",
    mode: "live",
    providerBinding,
    evidence: {
      ...providerBinding,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      observedAt: new Date("2026-10-12T12:59:30.000Z"),
      bankObservedAt: new Date("2026-10-12T12:59:00.000Z"),
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
    },
    now: new Date("2026-10-12T13:00:00.000Z"),
    freshnessMs: 60_000,
  };
}

describe("receiving readiness", () => {
  it("starts closed without configuration or provider evidence", () => {
    expect(createDefaultReceivingReadiness("site-one")).toEqual({
      siteId: "site-one",
      state: "NOT_CONFIGURED",
      reason: "NOT_CONFIGURED",
      observedAt: null,
      destinationVersion: null,
      catalogEligible: false,
      mode: "disabled",
    });
  });

  it("projects verified receiving and bank readiness without needing a balance or payment", () => {
    expect(evaluateReceivingReadiness(readyInput())).toEqual({
      siteId: "site-one",
      state: "READY",
      reason: null,
      observedAt: "2026-10-12T12:59:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "live",
    });
  });

  it("allows native live evidence only for the exact opted-in production showcase", () => {
    const input = { ...readyInput(), isDemo: true, liveDemoSiteId: "site-one" };
    expect(evaluateReceivingReadiness(input).state).toBe("READY");
    expect(
      evaluateReceivingReadiness({ ...input, liveDemoSiteId: "other-site" })
        .state,
    ).toBe("BLOCKED");
    expect(
      evaluateReceivingReadiness({
        ...input,
        evidence: { ...input.evidence, provenance: "simulation" },
      }).state,
    ).toBe("BLOCKED");
    expect(input.isDemo).toBe(true);
  });
  it("keeps an absent provider binding unconfigured", () => {
    expect(
      evaluateReceivingReadiness({ ...readyInput(), providerBinding: null }),
    ).toMatchObject({
      state: "NOT_CONFIGURED",
      reason: "NOT_CONFIGURED",
      observedAt: null,
      destinationVersion: null,
      catalogEligible: false,
    });
  });

  it("blocks disabled provider mode even with approved evidence", () => {
    expect(
      evaluateReceivingReadiness({ ...readyInput(), mode: "disabled" }),
    ).toMatchObject({
      state: "BLOCKED",
      reason: "PROVIDER_DISABLED",
      catalogEligible: false,
    });
  });

  it.each(["development", "test", "production"] as const)(
    "never establishes live readiness for a demo in %s",
    (environment) => {
      expect(
        evaluateReceivingReadiness({
          ...readyInput(),
          isDemo: true,
          environment,
        }),
      ).toMatchObject({
        state: "BLOCKED",
        reason: "ENVIRONMENT_MISMATCH",
        catalogEligible: false,
      });
    },
  );

  it.each([
    "siteId",
    "provider",
    "operatorReference",
    "accountReference",
    "recipientReference",
  ] as const)("rejects evidence from a different %s", (field) => {
    const input = readyInput();
    input.evidence[field] = "another-reference";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      observedAt: null,
      catalogEligible: false,
    });
  });

  it("rejects the current binding when it belongs to another site", () => {
    const input = readyInput();
    input.providerBinding.siteId = "another-site";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it.each(["provider", "operatorReference"] as const)(
    "requires a nonempty current %s binding",
    (field) => {
      const input = readyInput();
      input.providerBinding[field] = " ";
      input.evidence[field] = " ";
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BLOCKED",
        reason: "ENVIRONMENT_MISMATCH",
        catalogEligible: false,
      });
    },
  );

  it.each(["accountReference", "recipientReference"] as const)(
    "requires a nonempty current %s before approval",
    (field) => {
      for (const value of [null, "", " "]) {
        const input = readyInput();
        input.providerBinding[field] = value;
        input.evidence[field] = value;
        expect(evaluateReceivingReadiness(input)).toMatchObject({
          state: "ONBOARDING",
          reason: "ONBOARDING_REQUIRED",
          catalogEligible: false,
        });
      }
    },
  );

  it("requires a configured bank reference", () => {
    for (const bankReference of [null, "", " "]) {
      const input = readyInput();
      input.providerBinding.bankReference = bankReference;
      input.evidence.bankReference = bankReference;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BANK_VALIDATION_PENDING",
        reason: "BANK_VERIFICATION_REQUIRED",
        catalogEligible: false,
      });
    }
  });

  it.each(["destinationVersion", "bankReference"] as const)(
    "invalidates approval when the active %s changes",
    (field) => {
      const input = readyInput();
      if (field === "destinationVersion") {
        input.providerBinding.destinationVersion = 2;
      } else {
        input.providerBinding.bankReference = "bank-two";
      }
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BLOCKED",
        reason: "DESTINATION_CHANGED",
        catalogEligible: false,
      });
    },
  );

  it.each([null, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid active destination version %s",
    (destinationVersion) => {
      const input = readyInput();
      input.providerBinding.destinationVersion = destinationVersion;
      input.evidence.destinationVersion = destinationVersion;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BANK_VALIDATION_PENDING",
        reason: "BANK_VERIFICATION_REQUIRED",
        destinationVersion: null,
        catalogEligible: false,
      });
    },
  );

  it("rejects provider environment mismatch", () => {
    const input = readyInput();
    input.evidence.environment = "sandbox";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it("rejects a sandbox binding presented as live mode", () => {
    const input = readyInput();
    input.providerBinding.environment = "sandbox";
    input.evidence.environment = "sandbox";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it("allows labeled simulated evidence only for sandbox demo sites", () => {
    const input = readyInput();
    input.mode = "sandbox";
    input.environment = "test";
    input.isDemo = true;
    input.providerBinding.environment = "sandbox";
    input.evidence.environment = "sandbox";
    input.evidence.provenance = "simulation";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "READY",
      reason: null,
      catalogEligible: true,
      mode: "sandbox",
    });

    input.isDemo = false;
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it("never unlocks production or live mode with simulated evidence", () => {
    const input = readyInput();
    input.isDemo = true;
    input.evidence.provenance = "simulation";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });

    input.mode = "sandbox";
    input.providerBinding.environment = "sandbox";
    input.evidence.environment = "sandbox";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it("fails closed for an unsupported runtime environment", () => {
    const input = readyInput();
    input.environment = "unknown" as ReceivingReadinessInput["environment"];
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it("normalizes unsupported provider mode to disabled even when corrupt bindings match", () => {
    const input = readyInput();
    input.mode = "unknown" as ReceivingReadinessInput["mode"];
    input.providerBinding.environment =
      "unknown" as ReceivingProviderBinding["environment"];
    input.evidence.environment = input.providerBinding.environment;
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "PROVIDER_DISABLED",
      catalogEligible: false,
      mode: "disabled",
    });
  });

  it("requires explicit boolean capabilities and commercial enablement", () => {
    for (const value of [undefined, null, "true", 1]) {
      const input = readyInput();
      input.evidence.capabilities.receiving = value as never;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        reason: "CAPABILITY_UNAVAILABLE",
        catalogEligible: false,
      });
      input.evidence.capabilities.receiving = true;
      input.evidence.commercialEnabled = value as never;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        reason: "PROVIDER_DISABLED",
        catalogEligible: false,
      });
    }
  });

  it("requires explicit verified evidence independently from approved states", () => {
    const input = readyInput();
    input.evidence.verification = "unverified";
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "EVIDENCE_STALE",
      catalogEligible: false,
    });
    expect(
      evaluateReceivingReadiness({ ...readyInput(), evidence: null }),
    ).toMatchObject({
      state: "ONBOARDING",
      reason: "ONBOARDING_REQUIRED",
      observedAt: null,
      catalogEligible: false,
    });
  });

  it.each([
    ["onboarding", "ONBOARDING", "ONBOARDING_REQUIRED"],
    ["under_review", "UNDER_REVIEW", "ACCOUNT_UNDER_REVIEW"],
    ["blocked", "BLOCKED", "ACCOUNT_BLOCKED"],
    ["suspended", "BLOCKED", "ACCOUNT_BLOCKED"],
  ] as const)(
    "maps provider account %s without treating bank approval as account approval",
    (accountState, state, reason) => {
      const input = readyInput();
      input.evidence.accountState = accountState;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state,
        reason,
        catalogEligible: false,
      });
    },
  );

  it.each(["pending", "rejected"] as const)(
    "keeps bank %s separate from an approved account",
    (bankState) => {
      const input = readyInput();
      input.evidence.bankState = bankState;
      input.evidence.bankObservedAt = null;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BANK_VALIDATION_PENDING",
        reason: "BANK_VERIFICATION_REQUIRED",
        catalogEligible: false,
      });
    },
  );

  it.each(["receiving", "withdrawal"] as const)(
    "requires the provider's %s capability",
    (capability) => {
      const input = readyInput();
      input.evidence.capabilities[capability] = false;
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BLOCKED",
        reason: "CAPABILITY_UNAVAILABLE",
        catalogEligible: false,
      });
    },
  );

  it("requires commercial enablement independently from approved capabilities", () => {
    const input = readyInput();
    input.evidence.commercialEnabled = false;
    expect(evaluateReceivingReadiness(input)).toMatchObject({
      state: "BLOCKED",
      reason: "PROVIDER_DISABLED",
      catalogEligible: false,
    });
  });

  it.each(["observedAt", "bankObservedAt"] as const)(
    "expires %s independently from the other observation",
    (field) => {
      const input = readyInput();
      input.evidence[field] = new Date(input.now.getTime() - 60_001);
      expect(evaluateReceivingReadiness(input)).toMatchObject({
        state: "BLOCKED",
        reason: "EVIDENCE_STALE",
        observedAt: "2026-10-12T12:58:59.999Z",
        catalogEligible: false,
      });
    },
  );

  it.each(["observedAt", "bankObservedAt"] as const)(
    "fails closed when %s is absent, invalid or in the future",
    (field) => {
      for (const value of [
        null,
        new Date(Number.NaN),
        new Date("2026-10-12T13:00:00.001Z"),
      ]) {
        const input = readyInput();
        input.evidence[field] = value;
        expect(evaluateReceivingReadiness(input)).toMatchObject({
          state: "BLOCKED",
          reason: "EVIDENCE_STALE",
          observedAt: null,
          catalogEligible: false,
        });
      }
    },
  );

  it("fails closed with an invalid injected clock", () => {
    expect(
      evaluateReceivingReadiness({
        ...readyInput(),
        now: new Date(Number.NaN),
      }),
    ).toMatchObject({
      state: "BLOCKED",
      reason: "EVIDENCE_STALE",
      observedAt: null,
      catalogEligible: false,
    });
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid injected freshness policy %s",
    (freshnessMs) => {
      expect(
        evaluateReceivingReadiness({ ...readyInput(), freshnessMs }),
      ).toMatchObject({
        state: "BLOCKED",
        reason: "EVIDENCE_STALE",
        catalogEligible: false,
      });
    },
  );

  it("uses the injected freshness policy instead of a provider-specific duration", () => {
    expect(
      evaluateReceivingReadiness({ ...readyInput(), freshnessMs: 59_999 }),
    ).toMatchObject({
      state: "BLOCKED",
      reason: "EVIDENCE_STALE",
      catalogEligible: false,
    });
    expect(
      evaluateReceivingReadiness({ ...readyInput(), freshnessMs: 60_000 }),
    ).toMatchObject({ state: "READY", catalogEligible: true });
  });

  it("throws the stable 409 service error for unavailable receiving", () => {
    const projection = createDefaultReceivingReadiness("site-one");
    expect(() => assertReceivingReady(projection)).toThrow(
      ReceivingReadinessServiceError,
    );
    expect(() => assertReceivingReady(projection)).toThrow(
      expect.objectContaining({
        name: "ReceivingReadinessServiceError",
        status: 409,
        code: "RECEIVING_NOT_READY",
        title: "Receiving is not ready",
      }),
    );
  });

  it("accepts only a complete server-generated READY projection", () => {
    const ready = evaluateReceivingReadiness(readyInput());
    expect(() => assertReceivingReady(ready)).not.toThrow();

    for (const malformed of [
      null,
      true,
      { catalogEligible: true },
      { ...ready, state: "BLOCKED" },
      { ...ready, reason: "EVIDENCE_STALE" },
      { ...ready, observedAt: null },
      { ...ready, destinationVersion: null },
      { ...ready, mode: "disabled" },
      { ...ready, catalogEligible: false },
      { ...ready, bankReference: "private-bank-reference" },
    ]) {
      expect(() => assertReceivingReady(malformed)).toThrow(
        ReceivingReadinessServiceError,
      );
    }
  });
});
