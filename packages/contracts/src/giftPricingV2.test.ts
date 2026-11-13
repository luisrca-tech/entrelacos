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

// Spec b.2 columns recomputed with sim.py and mrate = 0 (addendum
// 2026-11-13: no anticipation). Cents.
const specTotals: Record<number, number[]> = {
  500: [709, 577, 580, 580, 580, 583, 583],
  1000: [1219, 1102, 1108, 1108, 1108, 1114, 1114],
  5000: [5299, 5308, 5336, 5336, 5336, 5363, 5363],
  10000: [10399, 10565, 10620, 10620, 10620, 10675, 10675],
  30000: [30799, 31594, 31758, 31758, 31758, 31923, 31923],
  100000: [102199, 105195, 105740, 105740, 105740, 106290, 106290],
  500000: [510199, 525770, 528494, 528494, 528494, 531246, 531246],
};

// [nominal, method, n, processing, anticipation]: anticipation is always 0.
const specBreakdowns: [
  number,
  "PIX" | "CREDIT_CARD",
  number,
  number,
  number,
][] = [
  [500, "PIX", 1, 199, 0],
  [500, "CREDIT_CARD", 1, 67, 0],
  [500, "CREDIT_CARD", 12, 73, 0],
  [10000, "PIX", 1, 199, 0],
  [10000, "CREDIT_CARD", 1, 365, 0],
  [10000, "CREDIT_CARD", 6, 420, 0],
  [10000, "CREDIT_CARD", 12, 475, 0],
  [30000, "CREDIT_CARD", 1, 994, 0],
  [100000, "CREDIT_CARD", 12, 4290, 0],
];

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

  it("keeps the landing examples without anticipation", () => {
    expect(getGiftV2TotalCents(10000, "PIX", 1)).toBe(10399);
    expect(getGiftV2TotalCents(10000, "CREDIT_CARD", 1)).toBe(10565);
    expect(getGiftV2TotalCents(30000, "CREDIT_CARD", 1)).toBe(31594);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 6).installmentCents).toEqual([
      1770, 1770, 1770, 1770, 1770, 1770,
    ]);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 12).installmentCents).toEqual([
      ...Array.from({ length: 11 }, () => 889),
      896,
    ]);
  });

  it("conserves the total and never produces negative anticipation", () => {
    for (let nominal = 1; nominal <= 600_000; nominal += 1_013) {
      for (const method of ["PIX", "CREDIT_CARD"] as const) {
        const counts = method === "PIX" ? [1] : [1, 2, 3, 4, 6, 7, 9, 12];
        for (const count of counts) {
          const quote = quoteGiftV2(nominal, method, count);
          expect(quote.anticipationCents).toBe(0);
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
    // R$ 5 in 2x = 580 → 290 per installment, below R$ 5.
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

  it("matches the per-installment split accepted by the Slice 0 probe", () => {
    expect(quoteGiftV2(30000, "CREDIT_CARD", 3).recipientSplitCents).toEqual([
      10000, 10000, 10000,
    ]);
    const twelve = quoteGiftV2(10000, "CREDIT_CARD", 12);
    expect(twelve.recipientSplitCents).toEqual([
      833, 833, 833, 833, 833, 833, 833, 833, 833, 832, 832, 839,
    ]);
    expect(Math.min(...twelve.splitSlackCents)).toBe(15);
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
