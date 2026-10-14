import { financialOverviewSchema } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AsaasBalanceObservation } from "./asaasHttpClient";
import {
  type FinancialOverviewInput,
  FinancialOverviewServiceError,
  loadFinancialOverview,
  type StoredFinancialTotalsSnapshot,
} from "./financialOverview";

const now = new Date("2026-10-12T12:00:00.000Z");
const binding = {
  provider: "ASAAS" as const,
  siteId: "site-1",
  accountBindingId: "account-1",
  accountReference: "remote-account-1",
  environment: "sandbox" as const,
};
const totals = {
  nominalReceivedCents: 10_000,
  netReceivedCents: 10_000,
  processingCents: 355,
  commissionCents: 200,
  awaitingReleaseCents: 1_700,
  pendingCommitmentsCents: 1_200,
  withdrawnCents: 2_000,
  refundedCents: 500,
};

function observation(
  overrides: Partial<AsaasBalanceObservation> = {},
): AsaasBalanceObservation {
  return {
    source: "provider",
    ...binding,
    currency: "BRL",
    observedAt: new Date(now),
    balanceCents: 7_300,
    ...overrides,
  };
}

function fixture() {
  const snapshot: StoredFinancialTotalsSnapshot = {
    binding: { ...binding },
    currency: "BRL",
    totals: { ...totals },
    observedAt: new Date("2026-10-12T11:59:00.000Z"),
    lastBalanceObservation: null,
    unresolvedFinancialEventCount: 0,
  };
  const loadStoredTotals = vi.fn().mockResolvedValue(snapshot);
  const getBalance = vi.fn().mockResolvedValue(observation());
  const checkBalanceConsistency = vi
    .fn()
    .mockImplementation(async (account, observedAt) => ({
      binding: { ...account },
      balanceObservedAt: new Date(observedAt),
      checkedAt: new Date(now),
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    }));
  const input: FinancialOverviewInput = {
    mode: "sandbox",
    binding: { ...binding },
    repository: { loadStoredTotals, checkBalanceConsistency },
    providerBalance: { getBalance },
    now: () => new Date(now),
    freshnessMs: 60_000,
  };
  return {
    input,
    snapshot,
    loadStoredTotals,
    getBalance,
    checkBalanceConsistency,
  };
}

async function unavailable(action: Promise<unknown>) {
  const error = await action.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(FinancialOverviewServiceError);
  expect(error).toMatchObject({
    status: 503,
    code: "FINANCIAL_OVERVIEW_UNAVAILABLE",
    message: "Financial overview is unavailable",
  });
  expect(error).not.toHaveProperty("cause");
  return error;
}

describe("stored financial overview projection", () => {
  it.each(["account.one", "account:one"])(
    "reads canonical local financial account ID %s without relaxing the site ID",
    async (accountBindingId) => {
      const { input, snapshot, getBalance } = fixture();
      input.binding.accountBindingId = accountBindingId;
      snapshot.binding.accountBindingId = accountBindingId;
      getBalance.mockResolvedValueOnce(observation({ accountBindingId }));
      expect(await loadFinancialOverview(input)).toMatchObject({
        ...totals,
        availableCents: 7300,
        availability: "CURRENT",
      });
    },
  );
  it("does not publish a stale balance as CURRENT when an actual debit completes during the GET", async () => {
    const { input, snapshot, getBalance, checkBalanceConsistency } = fixture();
    getBalance.mockImplementationOnce(async () => {
      expect(snapshot.unresolvedFinancialEventCount).toBe(0);
      checkBalanceConsistency.mockResolvedValueOnce({
        binding: { ...binding },
        balanceObservedAt: new Date(now),
        checkedAt: new Date(now),
        unresolvedFinancialEventCount: 0,
        balanceEffectsAfterObservationCount: 1,
      });
      return observation();
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...totals,
      availableCents: null,
      availability: "UNKNOWN",
    });
    expect(checkBalanceConsistency).toHaveBeenCalledExactlyOnceWith(
      binding,
      now,
    );
  });

  it("requires an explicit post-fetch consistency port before claiming CURRENT", async () => {
    const { input } = fixture();
    delete input.repository.checkBalanceConsistency;
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...totals,
      availableCents: null,
      availability: "UNKNOWN",
    });
  });

  it.each([
    null,
    { unresolvedFinancialEventCount: 1 },
    { balanceEffectsAfterObservationCount: undefined },
    { balanceEffectsAfterObservationCount: -1 },
    { balanceEffectsAfterObservationCount: 0.5 },
    { binding: { ...binding, accountReference: "other_remote" } },
    { balanceObservedAt: new Date(now.getTime() - 1) },
    { checkedAt: new Date(now.getTime() - 1) },
    { checkedAt: new Date(now.getTime() + 1) },
  ])(
    "suppresses availability on missing, inconsistent or later scoped proof: %j",
    async (changes) => {
      const { input, checkBalanceConsistency } = fixture();
      checkBalanceConsistency.mockResolvedValueOnce(
        changes === null
          ? null
          : {
              binding: { ...binding },
              balanceObservedAt: new Date(now),
              checkedAt: new Date(now),
              unresolvedFinancialEventCount: 0,
              balanceEffectsAfterObservationCount: 0,
              ...changes,
            },
      );
      expect(await loadFinancialOverview(input)).toMatchObject({
        ...totals,
        availableCents: null,
        availability: "UNKNOWN",
      });
    },
  );

  it("keeps actual historical totals readable when post-fetch revalidation is unavailable", async () => {
    const { input, checkBalanceConsistency } = fixture();
    checkBalanceConsistency.mockRejectedValueOnce(
      new Error("private SQL/provider credential"),
    );
    const result = await loadFinancialOverview(input);
    expect(result).toMatchObject({
      ...totals,
      availableCents: null,
      availability: "UNKNOWN",
    });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("rechecks balance freshness after the asynchronous consistency read", async () => {
    const { input, checkBalanceConsistency } = fixture();
    let current = now.getTime();
    input.now = () => new Date(current);
    checkBalanceConsistency.mockImplementationOnce(async () => {
      current += 60_001;
      return {
        binding: { ...binding },
        balanceObservedAt: new Date(now),
        checkedAt: new Date(current),
        unresolvedFinancialEventCount: 0,
        balanceEffectsAfterObservationCount: 0,
      };
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...totals,
      availableCents: null,
      availability: "STALE",
    });
  });

  it("does not relax Date-only consistency evidence into arbitrary timestamp text", async () => {
    const { input, checkBalanceConsistency } = fixture();
    checkBalanceConsistency.mockResolvedValueOnce({
      binding: { ...binding },
      balanceObservedAt: now.toISOString(),
      checkedAt: new Date(now),
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      availability: "UNKNOWN",
    });
  });

  it("rejects a consistency snapshot taken before the provider GET completed", async () => {
    const { input, getBalance, checkBalanceConsistency } = fixture();
    let current = now.getTime();
    input.now = () => new Date(current);
    getBalance.mockImplementationOnce(async () => {
      current += 1000;
      return observation();
    });
    checkBalanceConsistency.mockResolvedValueOnce({
      binding: { ...binding },
      balanceObservedAt: new Date(now),
      checkedAt: new Date(now),
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...totals,
      availableCents: null,
      availability: "UNKNOWN",
    });
  });

  it("suppresses current available funds while unresolved financial events preserve the actual historical totals", async () => {
    const { input, snapshot, getBalance } = fixture();
    snapshot.unresolvedFinancialEventCount = 2;
    getBalance.mockImplementationOnce(async () => {
      snapshot.unresolvedFinancialEventCount = 0;
      return observation();
    });
    const result = await loadFinancialOverview(input);
    expect(result).toEqual({
      siteId: "site-1",
      currency: "BRL",
      ...totals,
      availableCents: null,
      synchronizedAt: now.toISOString(),
      availability: "UNKNOWN",
      mode: "sandbox",
    });
    expect(result).not.toHaveProperty("unresolvedFinancialEventCount");
  });

  it.each([
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
  ])(
    "rejects missing or invalid unresolved financial event count without provider access: %j",
    async (count) => {
      const { input, snapshot, loadStoredTotals, getBalance } = fixture();
      loadStoredTotals.mockResolvedValueOnce({
        ...snapshot,
        unresolvedFinancialEventCount: count,
      });
      await unavailable(loadFinancialOverview(input));
      expect(getBalance).not.toHaveBeenCalled();
    },
  );

  it("requires unresolved financial event count to be explicitly present instead of assuming zero", async () => {
    const { input, snapshot, loadStoredTotals, getBalance } = fixture();
    const { unresolvedFinancialEventCount: _count, ...missing } = snapshot;
    loadStoredTotals.mockResolvedValueOnce(missing);
    await unavailable(loadFinancialOverview(input));
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("keeps unresolved financial history readable while disabled without provider initialization", async () => {
    const { input, snapshot, getBalance } = fixture();
    input.mode = "disabled";
    snapshot.unresolvedFinancialEventCount = 1;
    snapshot.lastBalanceObservation = observation({
      observedAt: new Date("2026-10-12T11:00:00.000Z"),
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...totals,
      mode: "disabled",
      availableCents: null,
      availability: "UNKNOWN",
      synchronizedAt: "2026-10-12T11:00:00.000Z",
    });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("returns complete stored totals and independently observed current provider balance", async () => {
    const { input, loadStoredTotals, getBalance } = fixture();
    const result = await loadFinancialOverview(input);
    expect(result).toEqual({
      siteId: "site-1",
      currency: "BRL",
      ...totals,
      availableCents: 7_300,
      synchronizedAt: now.toISOString(),
      availability: "CURRENT",
      mode: "sandbox",
    });
    expect(financialOverviewSchema.safeParse(result).success).toBe(true);
    expect(loadStoredTotals).toHaveBeenCalledExactlyOnceWith(binding);
    expect(getBalance).toHaveBeenCalledExactlyOnceWith(binding);
  });

  it("keeps explicitly stored zero totals and actual zero provider balance known", async () => {
    const { input, snapshot, getBalance } = fixture();
    snapshot.totals = {
      nominalReceivedCents: 0,
      netReceivedCents: 0,
      processingCents: 0,
      commissionCents: 0,
      awaitingReleaseCents: 0,
      pendingCommitmentsCents: 0,
      withdrawnCents: 0,
      refundedCents: 0,
    };
    getBalance.mockResolvedValueOnce(observation({ balanceCents: 0 }));
    expect(await loadFinancialOverview(input)).toMatchObject({
      ...snapshot.totals,
      availableCents: 0,
      availability: "CURRENT",
    });
  });

  it("allows stored historical reads after deactivation without a READY or withdrawal grant", async () => {
    const { input, snapshot, getBalance } = fixture();
    input.mode = "disabled";
    snapshot.lastBalanceObservation = observation({
      observedAt: new Date("2026-10-12T11:00:00.000Z"),
    });
    const result = await loadFinancialOverview(input);
    expect(result).toEqual({
      siteId: "site-1",
      currency: "BRL",
      ...totals,
      availableCents: null,
      synchronizedAt: "2026-10-12T11:00:00.000Z",
      availability: "UNKNOWN",
      mode: "disabled",
    });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("does not query the provider or fabricate synchronization in disabled mode without earlier evidence", async () => {
    const { input, getBalance } = fixture();
    input.mode = "disabled";
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      synchronizedAt: null,
      availability: "UNKNOWN",
    });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("does not initialize an unused provider reader for a disabled historical read", async () => {
    const { input } = fixture();
    input.mode = "disabled";
    const touched = vi.fn(() => {
      throw new Error("provider credential must not be loaded");
    });
    input.providerBalance = Object.defineProperty({}, "getBalance", {
      get: touched,
    }) as NonNullable<FinancialOverviewInput["providerBalance"]>;
    expect(await loadFinancialOverview(input)).toMatchObject({
      mode: "disabled",
      availability: "UNKNOWN",
      availableCents: null,
    });
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(["missing", "error", "no port"])(
    "keeps balance unknown when %s has no previous trusted observation",
    async (scenario) => {
      const { input, getBalance } = fixture();
      if (scenario === "missing") getBalance.mockResolvedValueOnce(null);
      if (scenario === "error")
        getBalance.mockRejectedValueOnce(
          new Error("access_token=secret; payer=private"),
        );
      if (scenario === "no port") input.providerBalance = undefined;
      const result = await loadFinancialOverview(input);
      expect(result).toEqual({
        siteId: "site-1",
        currency: "BRL",
        ...totals,
        availableCents: null,
        synchronizedAt: null,
        availability: "UNKNOWN",
        mode: "sandbox",
      });
      expect(JSON.stringify(result)).not.toMatch(
        /access_token|secret|payer|private/,
      );
    },
  );

  it.each(["missing", "error"])(
    "keeps the actual last synchronization but no cached available funds after provider %s",
    async (scenario) => {
      const { input, snapshot, getBalance } = fixture();
      snapshot.lastBalanceObservation = observation({
        observedAt: new Date("2026-10-12T11:59:55.000Z"),
        balanceCents: 1,
      });
      if (scenario === "missing") getBalance.mockResolvedValueOnce(null);
      else getBalance.mockRejectedValueOnce(new Error("private"));
      expect(await loadFinancialOverview(input)).toMatchObject({
        availableCents: null,
        synchronizedAt: "2026-10-12T11:59:55.000Z",
        availability: "STALE",
      });
    },
  );

  it("returns fresh actual provider funds independently of awaiting release and pending commitments", async () => {
    const { input, snapshot, getBalance } = fixture();
    snapshot.totals.pendingCommitmentsCents = 100_000;
    snapshot.totals.awaitingReleaseCents = 20_000;
    getBalance.mockResolvedValueOnce(observation({ balanceCents: 7_300 }));
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: 7_300,
      pendingCommitmentsCents: 100_000,
      awaitingReleaseCents: 20_000,
    });
  });

  it("marks stale fetched evidence with its actual timestamp and suppresses its amount", async () => {
    const { input, getBalance } = fixture();
    getBalance.mockResolvedValueOnce(
      observation({ observedAt: new Date("2026-10-12T11:58:59.999Z") }),
    );
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      synchronizedAt: "2026-10-12T11:58:59.999Z",
      availability: "STALE",
    });
  });

  it("accepts the exact injected freshness boundary", async () => {
    const { input, getBalance } = fixture();
    getBalance.mockResolvedValueOnce(
      observation({ observedAt: new Date("2026-10-12T11:59:00.000Z") }),
    );
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: 7_300,
      synchronizedAt: "2026-10-12T11:59:00.000Z",
      availability: "CURRENT",
    });
  });

  it("rechecks the clock after provider await so an observation that expired in flight cannot be CURRENT", async () => {
    const { input, getBalance } = fixture();
    let current = new Date(now);
    input.now = () => new Date(current);
    getBalance.mockImplementationOnce(async () => {
      current = new Date("2026-10-12T12:01:00.001Z");
      return observation();
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      synchronizedAt: now.toISOString(),
      availability: "STALE",
    });
  });

  it.each([
    { source: "browser" },
    { provider: "OTHER" },
    { siteId: "other-site" },
    { accountBindingId: "other-local-account" },
    { accountReference: "other-remote-account" },
    { environment: "live" },
    { currency: "USD" },
    { balanceCents: undefined },
    { balanceCents: null },
    { balanceCents: -1 },
    { balanceCents: 1.5 },
    { balanceCents: 2_147_483_648 },
    { balanceCents: Number.NaN },
    { observedAt: new Date("invalid") },
    { observedAt: new Date(-8_640_000_000_000_000) },
    { observedAt: now.toISOString() },
    { observedAt: new Date(now.getTime() + 1) },
    { accessToken: "secret" },
  ])(
    "never marks malformed, future or foreign provider evidence current: %j",
    async (overrides) => {
      const { input, getBalance } = fixture();
      getBalance.mockResolvedValueOnce({ ...observation(), ...overrides });
      const result = await loadFinancialOverview(input);
      expect(result).toMatchObject({
        availableCents: null,
        synchronizedAt: null,
        availability: "UNKNOWN",
      });
      expect(financialOverviewSchema.safeParse(result).success).toBe(true);
    },
  );

  it("falls back only to a valid stored observation when the new provider observation has foreign scope", async () => {
    const { input, snapshot, getBalance } = fixture();
    snapshot.lastBalanceObservation = observation({
      observedAt: new Date("2026-10-12T11:57:00.000Z"),
    });
    getBalance.mockResolvedValueOnce(observation({ siteId: "other-site" }));
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      synchronizedAt: "2026-10-12T11:57:00.000Z",
      availability: "STALE",
    });
  });

  it("does not regress the last synchronization or expose an older amount when a fetched observation predates retained evidence", async () => {
    const { input, snapshot, getBalance } = fixture();
    snapshot.lastBalanceObservation = observation({
      observedAt: new Date("2026-10-12T11:59:55.000Z"),
    });
    getBalance.mockResolvedValueOnce(
      observation({
        observedAt: new Date("2026-10-12T11:59:50.000Z"),
        balanceCents: 1,
      }),
    );
    expect(await loadFinancialOverview(input)).toMatchObject({
      availableCents: null,
      synchronizedAt: "2026-10-12T11:59:55.000Z",
      availability: "STALE",
    });
  });

  it.each([
    { siteId: "foreign" },
    { accountBindingId: "foreign" },
    { accountReference: "foreign" },
    { environment: "live" },
    { source: "browser" },
    { currency: "USD" },
    { observedAt: new Date(now.getTime() + 1) },
    { observedAt: new Date("invalid") },
    { balanceCents: -1 },
    { private: "secret" },
  ])(
    "ignores an invalid retained observation without claiming synchronization: %j",
    async (overrides) => {
      const { input, snapshot, getBalance } = fixture();
      Object.assign(snapshot, {
        lastBalanceObservation: { ...observation(), ...overrides },
      });
      getBalance.mockResolvedValueOnce(null);
      expect(await loadFinancialOverview(input)).toMatchObject({
        availableCents: null,
        synchronizedAt: null,
        availability: "UNKNOWN",
      });
    },
  );

  it.each([
    null,
    { binding: { ...binding, siteId: "other-site" } },
    { binding: { ...binding, accountBindingId: "other-account" } },
    { binding: { ...binding, accountReference: "other-remote" } },
    { binding: { ...binding, environment: "live" } },
    { currency: "USD" },
    { observedAt: new Date("invalid") },
    { observedAt: new Date(now.getTime() + 1) },
    { lastBalanceObservation: undefined },
    { totals: { nominalReceivedCents: 1 } },
    { totals: { ...totals, pendingCommitmentsCents: undefined } },
    { totals: { ...totals, netReceivedCents: -1 } },
    { totals: { ...totals, processingCents: 0.5 } },
    { totals: { ...totals, refundedCents: 2_147_483_648 } },
    { totals: { ...totals, accountReference: "private" } },
    { credentials: "private" },
  ])(
    "rejects missing, foreign or incomplete stored totals without provider access: %j",
    async (overrides) => {
      const { input, snapshot, loadStoredTotals, getBalance } = fixture();
      loadStoredTotals.mockResolvedValueOnce(
        overrides === null ? null : { ...snapshot, ...overrides },
      );
      const error = await unavailable(loadFinancialOverview(input));
      expect(JSON.stringify(error)).not.toContain("private");
      expect(getBalance).not.toHaveBeenCalled();
    },
  );

  it("sanitizes repository failures and never fills missing totals with zeros", async () => {
    const { input, loadStoredTotals, getBalance } = fixture();
    loadStoredTotals.mockRejectedValueOnce(
      new Error("postgresql://user:secret@private; payer=private"),
    );
    const error = await unavailable(loadFinancialOverview(input));
    expect(String(error)).not.toMatch(/postgresql|secret|payer|private/);
    expect(getBalance).not.toHaveBeenCalled();
  });

  it.each([
    [
      "mode mismatch",
      (i: FinancialOverviewInput) => {
        i.mode = "live";
      },
    ],
    [
      "unknown mode",
      (i: FinancialOverviewInput) => {
        Object.assign(i, { mode: "browser" });
      },
    ],
    [
      "invalid identity",
      (i: FinancialOverviewInput) => {
        i.binding.siteId = "site/foreign";
      },
    ],
    [
      "unknown provider",
      (i: FinancialOverviewInput) => {
        Object.assign(i.binding, { provider: "OTHER" });
      },
    ],
    [
      "missing remote account",
      (i: FinancialOverviewInput) => {
        i.binding.accountReference = "";
      },
    ],
    [
      "extra account claim",
      (i: FinancialOverviewInput) => {
        Object.assign(i.binding, { approved: true });
      },
    ],
    [
      "zero freshness",
      (i: FinancialOverviewInput) => {
        i.freshnessMs = 0;
      },
    ],
    [
      "fractional freshness",
      (i: FinancialOverviewInput) => {
        i.freshnessMs = 0.5;
      },
    ],
    [
      "unbounded freshness",
      (i: FinancialOverviewInput) => {
        i.freshnessMs = 300_001;
      },
    ],
    [
      "invalid clock",
      (i: FinancialOverviewInput) => {
        i.now = () => new Date("invalid");
      },
    ],
  ])(
    "rejects unsafe server input before querying stored totals: %s",
    async (_name, change) => {
      const { input, loadStoredTotals, getBalance } = fixture();
      change(input);
      await unavailable(loadFinancialOverview(input));
      expect(loadStoredTotals).not.toHaveBeenCalled();
      expect(getBalance).not.toHaveBeenCalled();
    },
  );

  it("accepts live mode only with exact stored and observed live bindings", async () => {
    const { input, snapshot, getBalance } = fixture();
    input.mode = "live";
    input.binding.environment = "live";
    snapshot.binding.environment = "live";
    getBalance.mockResolvedValueOnce(observation({ environment: "live" }));
    expect(await loadFinancialOverview(input)).toMatchObject({
      mode: "live",
      availability: "CURRENT",
      availableCents: 7_300,
    });
  });

  it.each(["repository", "provider"])(
    "fails closed when the clock becomes invalid or rewinds after %s await",
    async (phase) => {
      for (const later of [new Date("invalid"), new Date(now.getTime() - 1)]) {
        const { input, snapshot, loadStoredTotals, getBalance } = fixture();
        let current = new Date(now);
        input.now = () => new Date(current);
        if (phase === "repository")
          loadStoredTotals.mockImplementationOnce(async () => {
            current = later;
            return snapshot;
          });
        else
          getBalance.mockImplementationOnce(async () => {
            current = later;
            return observation();
          });
        await unavailable(loadFinancialOverview(input));
      }
    },
  );

  it("captures scope, policy and complete stored totals across awaits", async () => {
    const { input, snapshot, loadStoredTotals, getBalance } = fixture();
    loadStoredTotals.mockImplementationOnce(async () => {
      input.binding.siteId = "foreign";
      input.mode = "live";
      input.freshnessMs = 300_001;
      return snapshot;
    });
    getBalance.mockImplementationOnce(async () => {
      snapshot.totals.netReceivedCents = -1;
      return observation();
    });
    expect(await loadFinancialOverview(input)).toMatchObject({
      siteId: "site-1",
      mode: "sandbox",
      netReceivedCents: 10_000,
      availability: "CURRENT",
    });
    expect(getBalance).toHaveBeenCalledExactlyOnceWith(binding);
  });
});
