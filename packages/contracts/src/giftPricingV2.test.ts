import { describe, expect, it } from "vitest";
import { getGiftCommissionCents } from "./giftCommission";
import {
  couplesSplitAmountCents,
  getGiftV2CoupleSplitCents,
  getGiftV2TotalCents,
  listGiftV2Options,
  quoteGiftV2,
} from "./giftPricingV2";
import {
  GIFT_PLATFORM_TARIFFS,
  getGiftCardCetBasisPoints,
  getGiftTariffTier,
  PIX_FIXED_CENTS,
} from "./giftTariffs";

/**
 * R$ 100.00 gift, hand-computed from the pricing formula (all ceilings):
 *   comm = 200; card fixed = 99; Pix fixed = 55
 *   Pix:  G = ceil(10255 / (1 − 1.09%))           = 10369, C = V = 10000
 *   Card: G = ceil(10299 / (1 − CET[n]))
 *         C = ceil(V / (1 − ANT[n])), ANT[n] = 2.72% · (15n + 13) / 30
 *   n | CET    | G     | ANT        | C
 *   1 | 5.11%  | 10854 | 2.538667%  | 10261
 *   2 | 8.17%  | 11216 | 3.898667%  | 10406
 *   3 | 9.47%  | 11377 | 5.258667%  | 10556
 *   4 | 10.77% | 11543 | 6.618667%  | 10709
 *   5 | 12.07% | 11713 | 7.978667%  | 10868
 *   6 | 13.38% | 11890 | 9.338667%  | 11031
 */
const hundredReais: ["PIX" | "CREDIT_CARD", number, number, number][] = [
  ["PIX", 1, 10369, 10000],
  ["CREDIT_CARD", 1, 10854, 10261],
  ["CREDIT_CARD", 2, 11216, 10406],
  ["CREDIT_CARD", 3, 11377, 10556],
  ["CREDIT_CARD", 4, 11543, 10709],
  ["CREDIT_CARD", 5, 11713, 10868],
  ["CREDIT_CARD", 6, 11890, 11031],
];

const cardCounts = [1, 2, 3, 4, 5, 6] as const;

/** Exact couple net after anticipation is ≥ V: C·(1 − ANT[n]) ≥ V. */
function coupleNetCoversGift(nominal: number, couple: number, n: number) {
  const denominator = 300_000n;
  const factor =
    denominator -
    BigInt(GIFT_PLATFORM_TARIFFS.anticipationMonthlyBasisPoints) *
      BigInt(15 * n + 13);
  return BigInt(couple) * factor >= BigInt(nominal) * denominator;
}

function ceilBasisPoints(amount: number, basisPoints: number) {
  return Math.ceil((amount * basisPoints) / 10_000);
}

describe("Pagar.me tariff table", () => {
  it("encodes the proposal numbers", () => {
    expect(GIFT_PLATFORM_TARIFFS).toMatchObject({
      version: "pagarme-proposal-2026-11",
      commissionBasisPoints: 200,
      pix: { mdrBasisPoints: 109, fixedCents: 55 },
      card: {
        fixedCents: 99,
        cetBasisPointsByInstallments: {
          1: 511,
          2: 817,
          3: 947,
          4: 1077,
          5: 1207,
          6: 1338,
        },
        mdrBasisPoints: { 1: 264, "2to6": 429 },
      },
      anticipationMonthlyBasisPoints: 272,
      withdrawalFeeCents: 367,
      minimumInstallmentCents: 500,
      maxInstallments: 6,
      couplesSplitMode: "charge_total",
    });
    expect(PIX_FIXED_CENTS).toBe(55);
    expect(GIFT_PLATFORM_TARIFFS).not.toHaveProperty("card7to12");
    expect(GIFT_PLATFORM_TARIFFS).not.toHaveProperty(
      "splitScheduleDaysPerInstallment",
    );
  });

  it("maps methods to tiers and rejects more than six installments", () => {
    expect(getGiftTariffTier("PIX", 1)).toBe("pix");
    expect(getGiftTariffTier("CREDIT_CARD", 1)).toBe("card1");
    expect(getGiftTariffTier("CREDIT_CARD", 6)).toBe("card2to6");
    expect(() => getGiftTariffTier("CREDIT_CARD", 7)).toThrow(RangeError);
    expect(() => getGiftTariffTier("CREDIT_CARD", 0)).toThrow(RangeError);
    expect(getGiftCardCetBasisPoints(4)).toBe(1077);
    expect(() => getGiftCardCetBasisPoints(7)).toThrow(RangeError);
  });
});

describe("gift pricing V2 on Pagar.me", () => {
  it.each(hundredReais)(
    "prices R$ 100.00 via %s %ix at G=%i and C=%i cents",
    (method, count, total, couple) => {
      expect(getGiftV2TotalCents(10000, method, count)).toBe(total);
      expect(getGiftV2CoupleSplitCents(10000, method, count)).toBe(couple);
      const quote = quoteGiftV2(10000, method, count);
      expect(quote.totalCents).toBe(total);
      expect(quote.coupleSplitCents).toBe(couple);
      expect(quote.offered).toBe(true);
    },
  );

  it("keeps platform net ≥ commission and couple net ≥ gift", () => {
    for (let nominal = 1; nominal <= 2_000_000; nominal += 997) {
      const commission = getGiftCommissionCents(nominal);
      const pix = quoteGiftV2(nominal, "PIX", 1);
      expect(pix.coupleSplitCents).toBe(nominal);
      expect(
        pix.totalCents -
          ceilBasisPoints(
            pix.totalCents,
            GIFT_PLATFORM_TARIFFS.pix.mdrBasisPoints,
          ) -
          PIX_FIXED_CENTS -
          nominal,
      ).toBeGreaterThanOrEqual(commission);
      for (const n of cardCounts) {
        const quote = quoteGiftV2(nominal, "CREDIT_CARD", n);
        // The CET already contains the couple anticipation (C − V).
        const platformNet =
          quote.totalCents -
          ceilBasisPoints(quote.totalCents, getGiftCardCetBasisPoints(n)) -
          GIFT_PLATFORM_TARIFFS.card.fixedCents -
          nominal;
        expect(platformNet).toBeGreaterThanOrEqual(commission);
        expect(quote.platformNetCents).toBe(platformNet);
        expect(coupleNetCoversGift(nominal, quote.coupleSplitCents, n)).toBe(
          true,
        );
        // The couple split never exceeds what the guest pays.
        expect(quote.coupleSplitCents).toBeLessThan(quote.totalCents);
      }
    }
  });

  it("conserves the total across its components and installments", () => {
    for (let nominal = 1; nominal <= 600_000; nominal += 1_013) {
      for (const [method, counts] of [
        ["PIX", [1]],
        ["CREDIT_CARD", cardCounts],
      ] as const) {
        for (const count of counts) {
          const quote = quoteGiftV2(nominal, method, count);
          expect(quote.anticipationCents).toBe(
            quote.coupleSplitCents - nominal,
          );
          if (method === "PIX") expect(quote.anticipationCents).toBe(0);
          expect(quote.processingCents).toBeGreaterThan(0);
          expect(
            quote.nominalCents +
              quote.commissionCents +
              quote.processingCents +
              quote.anticipationCents,
          ).toBe(quote.totalCents);
          expect(quote.installmentCents).toHaveLength(count);
          expect(quote.installmentCents.reduce((a, b) => a + b, 0)).toBe(
            quote.totalCents,
          );
          expect(quote.recipientSplitCents).toHaveLength(count);
          expect(quote.recipientSplitCents.reduce((a, b) => a + b, 0)).toBe(
            nominal,
          );
        }
      }
    }
  });

  it("prices large gifts without precision loss", () => {
    // ceil(102_000_055 / 0.9891): exact BigInt ceiling, no float drift.
    expect(getGiftV2TotalCents(100_000_000, "PIX", 1)).toBe(103_124_108);
  });

  it("splits installments with the remainder on the last one", () => {
    expect(quoteGiftV2(10000, "CREDIT_CARD", 6).installmentCents).toEqual([
      1981, 1981, 1981, 1981, 1981, 1985,
    ]);
  });

  it("does not offer installments below the minimum installment amount", () => {
    // R$ 5 in 2x: G = ceil(609 / 0.9183) = 664 → 332 per installment.
    expect(quoteGiftV2(500, "CREDIT_CARD", 2).offered).toBe(false);
    expect(quoteGiftV2(500, "CREDIT_CARD", 1).offered).toBe(true);
    const options = listGiftV2Options(1000);
    expect(options.card.map((quote) => quote.installmentCount)).toEqual([1, 2]);
    expect(
      listGiftV2Options(1_000_000).card.map((quote) => quote.installmentCount),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects unsupported inputs", () => {
    expect(() => quoteGiftV2(-1, "PIX", 1)).toThrow(RangeError);
    expect(() => quoteGiftV2(1.5, "PIX", 1)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "PIX", 2)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "CREDIT_CARD", 7)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "CREDIT_CARD", 0)).toThrow(RangeError);
    expect(() => getGiftV2TotalCents(1000, "CREDIT_CARD", 12)).toThrow(
      RangeError,
    );
  });
});

describe("couple split amount sent to Pagar.me", () => {
  it("sends the whole couple amount on the charge in charge_total mode", () => {
    expect(couplesSplitAmountCents(11031, 6, "charge_total")).toBe(11031);
    expect(couplesSplitAmountCents(10261, 1, "charge_total")).toBe(10261);
  });

  it("sends the rounded-up per-installment amount in per_installment mode", () => {
    // ceil(11031 / 6) = 1839
    expect(couplesSplitAmountCents(11031, 6, "per_installment")).toBe(1839);
    expect(couplesSplitAmountCents(10406, 2, "per_installment")).toBe(5203);
    expect(couplesSplitAmountCents(10000, 1, "per_installment")).toBe(10000);
  });

  it("defaults to the configured mode and rejects invalid input", () => {
    expect(couplesSplitAmountCents(11031, 6)).toBe(11031);
    expect(() => couplesSplitAmountCents(-1, 1, "charge_total")).toThrow(
      RangeError,
    );
    expect(() => couplesSplitAmountCents(100, 7, "charge_total")).toThrow(
      RangeError,
    );
    expect(() =>
      couplesSplitAmountCents(100, 2, "other" as "charge_total"),
    ).toThrow(RangeError);
  });
});
