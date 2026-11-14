import { GIFT_PLATFORM_TARIFFS, type GiftQuote } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  GiftMoneyServiceError,
  giftV2RecipientSplitCents,
  platformTariffPolicy,
  quoteGiftPurchaseAmounts,
} from "./giftMoney";
import {
  buildGiftV2Settlement,
  isPlatformAccountSplit,
  readGiftV2Settlement,
} from "./giftQuotes";

function v2Quote(
  nominalCents: number,
  method: GiftQuote["method"],
  installmentCount?: number,
): GiftQuote {
  const amounts = quoteGiftPurchaseAmounts(
    { nominalCents, method, policy: platformTariffPolicy(method) },
    installmentCount,
  );
  return {
    id: "quote-v2",
    siteId: "site-one",
    giftId: "gift-one",
    title: "Gift",
    method,
    currency: "BRL",
    commissionBasisPoints: 200,
    expiresAt: "2026-11-13T12:05:00.000Z",
    mode: "sandbox",
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
    ...amounts,
  } as GiftQuote;
}

describe("V2 platform tariff pricing", () => {
  it.each([
    [30000, "CREDIT_CARD", 1, 31594],
    [10000, "PIX", undefined, 10399],
    [10000, "CREDIT_CARD", 12, 10675],
  ] as const)(
    "prices %i %s x%s to %i cents",
    (nominal, method, count, total) => {
      const amounts = quoteGiftPurchaseAmounts(
        { nominalCents: nominal, method, policy: platformTariffPolicy(method) },
        count,
      );
      expect(amounts.totalCents).toBe(total);
      expect(amounts.policyVersion).toBe(GIFT_PLATFORM_TARIFFS.version);
      expect(amounts.feeAllocation).toBe("BUYER_GROSS_UP");
      // No anticipation: processing holds every guest fee besides commission.
      expect(
        amounts.nominalCents +
          amounts.commissionCents +
          amounts.processingCents,
      ).toBe(total);
      expect(amounts.anticipationCents ?? 0).toBe(0);
    },
  );

  it("charges no anticipation for Pix and refuses Pix installments", () => {
    const pix = quoteGiftPurchaseAmounts({
      nominalCents: 10000,
      method: "PIX",
      policy: platformTariffPolicy("PIX"),
    });
    expect(pix.anticipationCents).toBe(0);
    expect(() =>
      quoteGiftPurchaseAmounts(
        {
          nominalCents: 10000,
          method: "PIX",
          policy: platformTariffPolicy("PIX"),
        },
        1,
      ),
    ).toThrow(GiftMoneyServiceError);
  });

  it("refuses a tariff policy with a stale version or another allocation", () => {
    for (const policy of [
      { ...platformTariffPolicy("PIX"), version: "platform-tariffs-old" },
      {
        ...platformTariffPolicy("PIX"),
        feeAllocation: "RECIPIENT_DEDUCTED" as const,
      },
      platformTariffPolicy("CREDIT_CARD"),
    ])
      expect(() =>
        quoteGiftPurchaseAmounts({
          nominalCents: 10000,
          method: "PIX",
          policy,
        }),
      ).toThrow(GiftMoneyServiceError);
  });

  it("lists card options with surcharges relative to one installment", () => {
    const card = quoteGiftPurchaseAmounts({
      nominalCents: 10000,
      method: "CREDIT_CARD",
      policy: platformTariffPolicy("CREDIT_CARD"),
    });
    const options = card.installmentOptions ?? [];
    expect(options[0]).toMatchObject({
      installmentCount: 1,
      installmentSurchargeCents: 0,
    });
    for (const option of options) {
      expect(option.installmentSurchargeCents).toBe(
        option.totalCents - card.totalCents,
      );
      expect(option.installmentCents.reduce((a, b) => a + b, 0)).toBe(
        option.totalCents,
      );
    }
  });
});

describe("V2 settlement snapshot", () => {
  it("freezes a couple split that sums to the nominal value", () => {
    const quote = v2Quote(30000, "CREDIT_CARD", 3);
    const settlement = buildGiftV2Settlement(quote);
    expect(settlement).toMatchObject({
      version: "PLATFORM_ACCOUNT_SPLIT_V2",
      tariffVersion: GIFT_PLATFORM_TARIFFS.version,
      tier: "card2to6",
    });
    expect(settlement.recipientSplitCents).toHaveLength(3);
    expect(settlement.recipientSplitCents.reduce((a, b) => a + b, 0)).toBe(
      30000,
    );
    expect(settlement.recipientSplitCents).toEqual(
      giftV2RecipientSplitCents(quote),
    );
    expect(isPlatformAccountSplit({ quote })).toBe(true);
  });

  it("round-trips a matching settlement and rejects tampered ones", () => {
    const quote = v2Quote(10000, "CREDIT_CARD", 12);
    const settlement = buildGiftV2Settlement(quote);
    expect(readGiftV2Settlement(quote, settlement)).toEqual(settlement);
    expect(() => readGiftV2Settlement(quote, undefined)).toThrow();
    const split = [...settlement.recipientSplitCents];
    split[0] += 1;
    split[1] -= 1;
    expect(() =>
      readGiftV2Settlement(quote, {
        ...settlement,
        recipientSplitCents: split,
      }),
    ).toThrow();
    expect(() =>
      readGiftV2Settlement(quote, {
        ...settlement,
        anticipationCents: settlement.anticipationCents + 1,
      }),
    ).toThrow();
  });

  it("rejects a V2 settlement attached to a V1 quote", () => {
    const quote = v2Quote(10000, "PIX");
    const settlement = buildGiftV2Settlement(quote);
    const v1 = {
      ...quote,
      settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
    } as GiftQuote;
    expect(readGiftV2Settlement(v1, undefined)).toBeUndefined();
    expect(() => readGiftV2Settlement(v1, settlement)).toThrow();
    expect(isPlatformAccountSplit({ quote: v1 })).toBe(false);
  });
});
