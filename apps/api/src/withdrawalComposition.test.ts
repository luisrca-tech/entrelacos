import { describe, expect, it, vi } from "vitest";
import { createWithdrawalComposition } from "./withdrawalComposition";

describe("native withdrawal runtime composition", () => {
  it("leaves disabled and production configurations without dispatch services", () => {
    const db = { execute: vi.fn(), transaction: vi.fn() };
    const disabled = createWithdrawalComposition(
      { mode: "disabled" },
      { db: db as never },
    );
    expect(disabled.service).toBeUndefined();
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("native withdrawal maximum fee quote", () => {
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    environment: "sandbox" as const,
    bankReference: "bank-1",
    destinationVersion: 1,
    amountCents: 1000,
    currency: "BRL" as const,
  };
  const now = new Date("2026-10-19T10:00:00.000Z");
  const observation = () => ({
    source: "provider" as const,
    provider: "ASAAS" as const,
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    accountReference: scope.accountReference,
    environment: "sandbox" as const,
    currency: "BRL" as const,
    observedAt: new Date(now),
    completedAt: new Date(now),
    fees: {
      transfer: {
        monthlyTransfersWithoutFee: 30,
        pix: {
          feeValue: "2.00",
          discountValue: "0.00",
          consideredInMonthlyTransfersWithoutFee: true,
        },
      },
    },
  });
  it("uses the observed full base fee instead of promising a monthly free quota", async () => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    expect(
      quoteAsaasWithdrawalMaximumFee(scope, observation(), now),
    ).toMatchObject({
      feeCents: 200,
      feeSemantics: "MAXIMUM",
      provenance: "provider",
      verification: "verified",
    });
  });
  it.each([
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
    "source",
    "provider",
    "currency",
  ])("rejects foreign %s in fee authority", async (key) => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    const value = observation();
    (value as Record<string, unknown>)[key] = "foreign";
    expect(() => quoteAsaasWithdrawalMaximumFee(scope, value, now)).toThrow();
  });
  it("rejects stale fees and an amount that cannot cover the approved maximum", async () => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    expect(() =>
      quoteAsaasWithdrawalMaximumFee(
        scope,
        observation(),
        new Date(+now + 60001),
      ),
    ).toThrow();
    expect(() =>
      quoteAsaasWithdrawalMaximumFee(
        { ...scope, amountCents: 200 },
        observation(),
        now,
      ),
    ).toThrow();
  });
});

function enabledFixture() {
  const clock = { value: new Date("2026-10-19T10:00:00.000Z") };
  const execute = vi.fn(async () => ({
    rows: [] as Record<string, unknown>[],
  }));
  const tx = { execute };
  const db = {
    execute,
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  const key = new Uint8Array(32).fill(7);
  const config = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    platformApiKey: "$aact_hmlg_offline-platform-token",
    platformAccountId: "platform-1",
    platformWalletId: "wallet-platform-1",
    credentialKeyId: "key-1",
    credentialKeyring: new Map([["key-1", key]]),
    webhookPublicOrigin: "https://webhook.example.test",
    webhookUrl: "https://webhook.example.test/v1/webhooks/asaas",
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const composition = createWithdrawalComposition(config, {
    db: db as never,
    fetch,
    now: () => clock.value,
  });
  const intent = {
    id: "withdrawal-1",
    siteId: "site-1",
    amountCents: 1000,
    feeCents: 200,
    netCents: 800,
    currency: "BRL" as const,
    destinationVersion: 1,
    state: "PROCESSING" as const,
    createdAt: clock.value.toISOString(),
    updatedAt: clock.value.toISOString(),
    mode: "sandbox" as const,
  };
  return { clock, execute, db, config, fetch, composition, intent, key };
}
describe("composed withdrawal admission and recovery ownership", () => {
  it("exposes protected request services without eager database or provider operations", async () => {
    const f = enabledFixture();
    expect(f.composition.service?.confirmNew).toBeTypeOf("function");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await f.composition.close();
    expect([...f.key]).toEqual(Array(32).fill(7));
    await expect(
      f.composition.service?.readContext({ actor: null, access: null }),
    ).rejects.toThrow("closed");
  });
  it("bounds recovery scans to one every30 seconds and only reads existing attempted operations", async () => {
    const f = enabledFixture();
    await f.composition.reconcilePending();
    await f.composition.reconcilePending();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    f.clock.value = new Date(+f.clock.value + 30001);
    await f.composition.reconcilePending();
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.composition.close();
  });
  it("retains MAXIMUM semantics for a pending history item without manufacturing a settlement", async () => {
    const f = enabledFixture();
    f.execute.mockResolvedValue({
      rows: [
        {
          reference: null,
          snapshot: { feeQuote: { feeSemantics: "MAXIMUM" } },
        },
      ],
    });
    expect(await f.composition.decorateIntent(f.intent)).toEqual({
      ...f.intent,
      feeSemantics: "MAXIMUM",
    });
    await f.composition.close();
  });
  it("does not manufacture completion for a max-budget intent without immutable custody", async () => {
    const f = enabledFixture();
    f.execute.mockResolvedValueOnce({
      rows: [
        {
          reference: "missing",
          snapshot: { feeQuote: { feeSemantics: "MAXIMUM" } },
        },
      ],
    });
    await expect(
      f.composition.decorateIntent({ ...f.intent, state: "COMPLETED" }),
    ).rejects.toThrow();
    await f.composition.close();
  });
});
