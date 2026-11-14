import { describe, expect, it, vi } from "vitest";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import { buildGiftV2Settlement, type GiftQuoteSnapshot } from "./giftQuotes";
import {
  fixSplitDivergence,
  type SplitDivergenceRecord,
  type SplitDivergenceStore,
} from "./splitDivergenceFix";

const key = "$aact_hmlg_secret_fixture";
const options = {
  environment: "sandbox" as const,
  platformApiKey: key,
  platformWalletId: "platform_wallet",
};

function v2Snapshot(
  method: "PIX" | "CREDIT_CARD" = "PIX",
  installmentCount?: number,
): GiftQuoteSnapshot {
  const quote = {
    id: "quote-one",
    siteId: "site-one",
    giftId: "gift-one",
    title: "A contribution",
    mode: "sandbox" as const,
    method,
    currency: "BRL" as const,
    commissionBasisPoints: 200 as const,
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2" as const,
    expiresAt: "2026-11-06T12:05:00.000Z",
    ...quoteGiftPurchaseAmounts(
      { nominalCents: 10_000, method, policy: platformTariffPolicy(method) },
      installmentCount,
    ),
  };
  return {
    quote,
    settlement: buildGiftV2Settlement(quote),
    receiving: { recipientReference: "couple_wallet" },
  } as unknown as GiftQuoteSnapshot;
}

function createStore(changes: Partial<SplitDivergenceRecord> = {}) {
  const row: SplitDivergenceRecord = {
    paymentId: "payment-one",
    siteId: "site-one",
    accountId: "account-one",
    installmentNumber: null,
    platformAdjustmentCents: null,
    adjustmentDispatched: false,
    blocked: true,
    alertOpen: true,
    credited: false,
    snapshot: v2Snapshot(),
    ...changes,
  };
  const recordTopUp = vi.fn(async (_: SplitDivergenceRecord, cents: number) => {
    if (row.platformAdjustmentCents !== null) return false;
    row.platformAdjustmentCents = cents;
    return true;
  });
  const resolveAlert = vi.fn(async () => {
    const open = row.alertOpen;
    row.alertOpen = false;
    return open;
  });
  const transaction = vi.fn();
  const store: SplitDivergenceStore = {
    load: async () => structuredClone(row),
    async transaction(work) {
      transaction();
      return work({
        load: async () => structuredClone(row),
        recordTopUp,
        resolveAlert,
      });
    },
  };
  return { row, store, recordTopUp, resolveAlert, transaction };
}

function charge(fixedValue: number, changes: Record<string, unknown> = {}) {
  return {
    id: "pay_one",
    status: "RECEIVED",
    value: 102.5,
    netValue: 90,
    split: [
      {
        id: "split-one",
        walletId: "couple_wallet",
        fixedValue,
        status: "BLOCKED_BY_VALUE_DIVERGENCE",
      },
    ],
    ...changes,
  };
}

function createFetch(...responses: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses)
    fetch.mockResolvedValueOnce(Response.json(response));
  return fetch;
}

describe("fixSplitDivergence", () => {
  it("plans the fit and top-up without writing on a dry run", async () => {
    const { store, transaction } = createStore();
    const fetch = createFetch(charge(100));
    const result = await fixSplitDivergence(
      store,
      { ...options, fetch },
      { paymentReference: "pay_one", apply: false },
    );
    expect(result).toMatchObject({
      applied: false,
      plan: {
        expectedSplitCents: 10_000,
        currentSplitCents: 10_000,
        netCents: 9_000,
        fitCents: 9_000,
        topUpCents: 1_000,
        splitUpdateRequired: true,
        coupleWallet: "couple_wallet",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_one",
    );
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("lowers the split, verifies it, records the top-up and resolves the alert", async () => {
    const { row, store, resolveAlert } = createStore();
    const fetch = createFetch(charge(100), charge(100), charge(90));
    const result = await fixSplitDivergence(
      store,
      { ...options, fetch },
      { paymentReference: "pay_one", apply: true },
    );
    expect(result).toMatchObject({
      applied: true,
      splitUpdated: true,
      topUpRecorded: true,
      alertResolved: true,
    });
    const put = fetch.mock.calls[1];
    expect(put?.[0]).toBe("https://api-sandbox.asaas.com/v3/payments/pay_one");
    expect(put?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      split: [{ walletId: "couple_wallet", fixedValue: 90 }],
    });
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("GET");
    expect(row.platformAdjustmentCents).toBe(1_000);
    expect(resolveAlert).toHaveBeenCalledWith(
      "pay_one",
      "fixSplitDivergence fit=9000 topUp=1000",
    );
  });

  it("converges on a re-run after the split was lowered but nothing was recorded", async () => {
    const { row, store } = createStore();
    const fetch = createFetch(charge(90));
    const result = await fixSplitDivergence(
      store,
      { ...options, fetch },
      { paymentReference: "pay_one", apply: true },
    );
    expect(result).toMatchObject({ splitUpdated: false, topUpRecorded: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(row.platformAdjustmentCents).toBe(1_000);
  });

  it("uses the frozen split of the blocked installment", async () => {
    const snapshot = v2Snapshot("CREDIT_CARD", 3);
    const splits = snapshot.settlement?.recipientSplitCents ?? [];
    expect(splits).toHaveLength(3);
    const { store } = createStore({ snapshot, installmentNumber: 2 });
    const fetch = createFetch(
      charge(splits[1] / 100, {
        status: "CONFIRMED",
        netValue: (splits[1] - 7) / 100,
      }),
    );
    const { plan } = await fixSplitDivergence(
      store,
      { ...options, fetch },
      { paymentReference: "pay_one", apply: false },
    );
    expect(plan).toMatchObject({
      expectedSplitCents: splits[1],
      fitCents: splits[1] - 7,
      topUpCents: 7,
    });
  });

  it("does not record anything when the edited split cannot be verified", async () => {
    const { row, store, transaction } = createStore();
    const fetch = createFetch(charge(100), charge(100), charge(100));
    await expect(
      fixSplitDivergence(
        store,
        { ...options, fetch },
        { paymentReference: "pay_one", apply: true },
      ),
    ).rejects.toMatchObject({ code: "SPLIT_UPDATE_UNVERIFIED" });
    expect(transaction).not.toHaveBeenCalled();
    expect(row.platformAdjustmentCents).toBeNull();
  });

  it.each([
    ["PAYMENT_NOT_BLOCKED", { blocked: false, alertOpen: false }, charge(100)],
    ["PAYMENT_ALREADY_CREDITED", { credited: true }, charge(100)],
    ["TOPUP_CONFLICT", { platformAdjustmentCents: 999 }, charge(100)],
    ["PAYMENT_NOT_EDITABLE", {}, charge(100, { status: "PENDING" })],
    ["PAYMENT_RESTRICTED", {}, charge(100, { refunds: [{}] })],
    ["NET_VALUE_UNAVAILABLE", {}, charge(100, { netValue: null })],
    [
      "SPLIT_UNEXPECTED",
      {},
      charge(100, { split: [{ walletId: "other", fixedValue: 100 }] }),
    ],
    ["SPLIT_UNEXPECTED", {}, charge(80)],
  ] as const)("refuses %s", async (code, changes, payment) => {
    const { store, transaction } = createStore(changes);
    const fetch = createFetch(payment);
    await expect(
      fixSplitDivergence(
        store,
        { ...options, fetch },
        { paymentReference: "pay_one", apply: true },
      ),
    ).rejects.toMatchObject({ code });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a V1 record before calling Asaas", async () => {
    const snapshot = v2Snapshot();
    const { store } = createStore({
      snapshot: {
        ...snapshot,
        quote: {
          ...snapshot.quote,
          settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
        },
      },
    });
    const fetch = createFetch();
    await expect(
      fixSplitDivergence(
        store,
        { ...options, fetch },
        { paymentReference: "pay_one", apply: false },
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_V2" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a key whose prefix does not match the mode and never echoes it", async () => {
    const { store } = createStore();
    const fetch = createFetch();
    const error = await fixSplitDivergence(
      store,
      { ...options, environment: "live", fetch },
      { paymentReference: "pay_one", apply: false },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(String((error as Error).message)).not.toContain(key);
    expect(fetch).not.toHaveBeenCalled();
  });
});
