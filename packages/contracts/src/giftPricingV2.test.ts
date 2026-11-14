import { describe, expect, it } from "vitest";
import simFixtures from "../test-fixtures/giftPricingV2.fixtures.json";
import {
  getGiftV2TotalCents,
  giftSplitScheduleV2,
  listGiftV2Options,
  quoteGiftV2,
} from "./giftPricingV2";
import { GIFT_PLATFORM_TARIFFS } from "./giftTariffs";

type Column = ["PIX" | "CREDIT_CARD", number];
const columns: Column[] = [
  ["PIX", 1],
  ["CREDIT_CARD", 1],
  ["CREDIT_CARD", 2],
  ["CREDIT_CARD", 3],
  ["CREDIT_CARD", 6],
  ["CREDIT_CARD", 7],
  ["CREDIT_CARD", 12],
];

// Spec b.2 columns recomputed with sim.py and the automatic anticipation
// rates of 2026-11-14 (1x 1.15%/month, 2x..12x 1.6%/month, Pix none). Cents.
const specTotals: Record<number, number[]> = {
  500: [709, 583, 593, 597, 611, 619, 644],
  1000: [1219, 1115, 1134, 1143, 1171, 1187, 1237],
  5000: [5299, 5369, 5466, 5510, 5649, 5727, 5980],
  10000: [10399, 10688, 10880, 10970, 11247, 11402, 11909],
  30000: [30799, 31961, 32538, 32806, 33639, 34102, 35623],
  100000: [102199, 106418, 108339, 109234, 112009, 113555, 118622],
  500000: [510199, 531886, 541488, 545963, 559842, 567567, 592903],
};

// [nominal, method, n, processing, anticipation]: Pix has no anticipation.
const specBreakdowns: [
  number,
  "PIX" | "CREDIT_CARD",
  number,
  number,
  number,
][] = [
  [500, "PIX", 1, 199, 0],
  [500, "CREDIT_CARD", 1, 67, 6],
  [500, "CREDIT_CARD", 12, 75, 59],
  [10000, "PIX", 1, 199, 0],
  [10000, "CREDIT_CARD", 1, 369, 119],
  [10000, "CREDIT_CARD", 6, 442, 605],
  [10000, "CREDIT_CARD", 12, 525, 1184],
  [15000, "CREDIT_CARD", 3, 623, 506],
  [30000, "CREDIT_CARD", 1, 1005, 356],
  [100000, "CREDIT_CARD", 12, 4783, 11839],
];

/**
 * Days from payment to each installment credit date reported by the Asaas
 * Sandbox for a 12x charge paid on 2026-11-13 (Slice 0 probe).
 */
const sandboxCreditDays = [
  32, 66, 96, 129, 160, 192, 224, 256, 290, 320, 353, 384,
];

/** Asaas anticipation of one installment: card fee, then fee for the days. */
function asaasAnticipatedNet(
  installment: number,
  count: number,
  index: number,
): number {
  const tier = count === 1 ? "card1" : count <= 6 ? "card2to6" : "card7to12";
  const tariff = GIFT_PLATFORM_TARIFFS[tier];
  const card =
    installment -
    Math.round((installment * tariff.basisPoints) / 10000) -
    Math.round(tariff.fixedCents / count);
  const days = sandboxCreditDays[index] ?? 0;
  return (
    card -
    Math.round(
      (card * tariff.anticipationMonthlyBasisPoints * days) / (10000 * 30),
    )
  );
}

describe("gift pricing V2 (guest pays every fee)", () => {
  it.each(
    Object.entries(specTotals).flatMap(([nominal, totals]) =>
      totals.map(
        (total, index) =>
          [Number(nominal), ...(columns[index] as Column), total] as const,
      ),
    ),
  )(
    "prices %i cents via %s %ix at %i cents (spec table)",
    (nominal, method, count, total) => {
      expect(getGiftV2TotalCents(nominal, method, count)).toBe(total);
    },
  );

  it.each(specBreakdowns)(
    "splits %i cents %s %ix into processing %i and anticipation %i",
    (nominal, method, count, processing, anticipation) => {
      const quote = quoteGiftV2(nominal, method, count);
      expect(quote.processingCents).toBe(processing);
      expect(quote.anticipationCents).toBe(anticipation);
    },
  );

  it.each(simFixtures)(
    "matches sim.py for $nominalCents cents $method $installmentCount x",
    ({ nominalCents, method, installmentCount, totalCents }) => {
      expect(
        getGiftV2TotalCents(
          nominalCents,
          method as "PIX" | "CREDIT_CARD",
          installmentCount,
        ),
      ).toBe(totalCents);
    },
  );

  it("keeps the landing examples", () => {
    expect(getGiftV2TotalCents(10000, "PIX", 1)).toBe(10399);
    expect(getGiftV2TotalCents(10000, "CREDIT_CARD", 1)).toBe(10688);
    expect(getGiftV2TotalCents(30000, "CREDIT_CARD", 1)).toBe(31961);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 6).installmentCents).toEqual([
      1874, 1874, 1874, 1874, 1874, 1877,
    ]);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 12).installmentCents).toEqual([
      ...Array.from({ length: 11 }, () => 992),
      997,
    ]);
  });

  it("conserves the total and charges anticipation on card only", () => {
    for (let nominal = 1; nominal <= 600_000; nominal += 1_013) {
      for (const method of ["PIX", "CREDIT_CARD"] as const) {
        const counts = method === "PIX" ? [1] : [1, 2, 3, 4, 6, 7, 9, 12];
        for (const count of counts) {
          const quote = quoteGiftV2(nominal, method, count);
          if (method === "PIX") expect(quote.anticipationCents).toBe(0);
          else if (nominal >= 1_000)
            expect(quote.anticipationCents).toBeGreaterThan(0);
          expect(quote.anticipationCents).toBeGreaterThanOrEqual(0);
          expect(
            quote.nominalCents +
              quote.commissionCents +
              quote.processingCents +
              quote.anticipationCents,
          ).toBe(quote.totalCents);
          expect(quote.installmentCents.reduce((a, b) => a + b, 0)).toBe(
            quote.totalCents,
          );
        }
      }
    }
  });

  it("does not offer installments below the minimum installment amount", () => {
    // R$ 5 in 2x = 593 → 296 per installment, below R$ 5.
    expect(quoteGiftV2(500, "CREDIT_CARD", 2).offered).toBe(false);
    expect(quoteGiftV2(500, "CREDIT_CARD", 1).offered).toBe(true);
    const options = listGiftV2Options(1000);
    expect(options.card.map((quote) => quote.installmentCount)).toEqual([1, 2]);
    expect(
      options.card.every(
        (quote) =>
          quote.installmentCount === 1 ||
          Math.floor(quote.totalCents / quote.installmentCount) >=
            GIFT_PLATFORM_TARIFFS.minimumInstallmentCents,
      ),
    ).toBe(true);
  });

  it("rejects unsupported inputs", () => {
    expect(() => quoteGiftV2(-1, "PIX", 1)).toThrow(RangeError);
    expect(() => quoteGiftV2(1.5, "PIX", 1)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "PIX", 2)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "CREDIT_CARD", 13)).toThrow(RangeError);
    expect(() => quoteGiftV2(1000, "CREDIT_CARD", 0)).toThrow(RangeError);
  });
});

describe("gift V2 split schedule", () => {
  it("gives the whole nominal to the couple on Pix and 1x", () => {
    expect(quoteGiftV2(10000, "PIX", 1).recipientSplitCents).toEqual([10000]);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 1).recipientSplitCents).toEqual([
      10000,
    ]);
  });

  it("front-loads the split because later installments cost more to anticipate", () => {
    const three = quoteGiftV2(15000, "CREDIT_CARD", 3);
    expect(three.installmentCents).toEqual([5476, 5476, 5477]);
    expect(three.recipientSplitCents).toEqual([5091, 5000, 4909]);
    const twelve = quoteGiftV2(10000, "CREDIT_CARD", 12);
    expect(twelve.recipientSplitCents.reduce((a, b) => a + b, 0)).toBe(10000);
    twelve.recipientSplitCents.slice(1).forEach((split, index) => {
      expect(split).toBeLessThanOrEqual(twelve.recipientSplitCents[index] ?? 0);
    });
  });

  it("covers every split with the anticipated net at sandbox credit dates", () => {
    for (const nominal of [5000, 15000, 50000, 200000]) {
      for (const count of [1, 2, 3, 6, 7, 12]) {
        const quote = quoteGiftV2(nominal, "CREDIT_CARD", count);
        // R$ 50 in 12x is 5980 / 12 = 498 per installment, below R$ 5.
        expect(quote.offered).toBe(!(nominal === 5000 && count === 12));
        if (!quote.offered) continue;
        quote.recipientSplitCents.forEach((split, index) => {
          const net = asaasAnticipatedNet(
            quote.installmentCents[index] ?? 0,
            count,
            index,
          );
          expect(net).toBeGreaterThanOrEqual(split);
        });
      }
    }
  });

  it("is feasible, conserves the nominal and leaves nonnegative slack", () => {
    let minimumSlack = Number.POSITIVE_INFINITY;
    for (let nominal = 500; nominal <= 500_000; nominal += 997) {
      for (let count = 2; count <= 12; count += 1) {
        const total = getGiftV2TotalCents(nominal, "CREDIT_CARD", count);
        if (Math.floor(total / count) < 500) continue;
        const schedule = giftSplitScheduleV2(
          nominal,
          total,
          "CREDIT_CARD",
          count,
        );
        expect(schedule).not.toBeNull();
        if (!schedule) continue;
        expect(schedule.recipientSplitCents).toHaveLength(count);
        expect(schedule.recipientSplitCents.reduce((a, b) => a + b, 0)).toBe(
          nominal,
        );
        const installments = quoteGiftV2(
          nominal,
          "CREDIT_CARD",
          count,
        ).installmentCents;
        schedule.recipientSplitCents.forEach((split, index) => {
          expect(split).toBeLessThan(installments[index] ?? 0);
        });
        minimumSlack = Math.min(minimumSlack, ...schedule.splitSlackCents);
      }
    }
    expect(minimumSlack).toBeGreaterThanOrEqual(0);
  });
});
