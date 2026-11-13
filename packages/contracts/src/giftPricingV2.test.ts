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

// Spec b.2 fixture table (cents).
const specTotals: Record<number, number[]> = {
  500: [709, 583, 593, 597, 611, 619, 644],
  1000: [1219, 1115, 1134, 1143, 1171, 1187, 1237],
  5000: [5299, 5369, 5466, 5510, 5649, 5727, 5980],
  10000: [10399, 10688, 10880, 10970, 11247, 11402, 11909],
  30000: [30799, 31961, 32538, 32806, 33639, 34102, 35623],
  100000: [102199, 106418, 108339, 109234, 112009, 113555, 118622],
  500000: [510199, 531886, 541488, 545963, 559842, 567567, 592903],
};

// [nominal, method, n, processing, anticipation] from the spec table.
const specBreakdowns: [
  number,
  "PIX" | "CREDIT_CARD",
  number,
  number,
  number,
][] = [
  [500, "PIX", 1, 199, 0],
  [500, "CREDIT_CARD", 1, 67, 6],
  [500, "CREDIT_CARD", 2, 70, 13],
  [500, "CREDIT_CARD", 3, 70, 17],
  [500, "CREDIT_CARD", 6, 71, 30],
  [500, "CREDIT_CARD", 7, 74, 35],
  [500, "CREDIT_CARD", 12, 75, 59],
  [1000, "CREDIT_CARD", 1, 83, 12],
  [1000, "CREDIT_CARD", 12, 99, 118],
  [10000, "CREDIT_CARD", 1, 369, 119],
  [10000, "CREDIT_CARD", 2, 429, 251],
  [10000, "CREDIT_CARD", 3, 432, 338],
  [10000, "CREDIT_CARD", 6, 442, 605],
  [10000, "CREDIT_CARD", 7, 504, 698],
  [10000, "CREDIT_CARD", 12, 525, 1184],
  [30000, "CREDIT_CARD", 1, 1005, 356],
  [30000, "CREDIT_CARD", 6, 1224, 1815],
  [30000, "CREDIT_CARD", 12, 1471, 3552],
  [100000, "CREDIT_CARD", 1, 3231, 1187],
  [100000, "CREDIT_CARD", 12, 4783, 11839],
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

  it("keeps the brief and landing examples", () => {
    expect(getGiftV2TotalCents(30000, "CREDIT_CARD", 1)).toBe(31961);
    expect(getGiftV2TotalCents(10000, "PIX", 1)).toBe(10399);
    expect(getGiftV2TotalCents(10000, "CREDIT_CARD", 1)).toBe(10688);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 6).installmentCents).toEqual([
      1874, 1874, 1874, 1874, 1874, 1877,
    ]);
    expect(quoteGiftV2(10000, "CREDIT_CARD", 12).installmentCents).toEqual([
      ...Array.from({ length: 11 }, () => 992),
      997,
    ]);
  });

  it("conserves the total and never produces negative anticipation", () => {
    for (let nominal = 1; nominal <= 600_000; nominal += 1_013) {
      for (const method of ["PIX", "CREDIT_CARD"] as const) {
        const counts = method === "PIX" ? [1] : [1, 2, 3, 4, 6, 7, 9, 12];
        for (const count of counts) {
          const quote = quoteGiftV2(nominal, method, count);
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
          if (method === "PIX") expect(quote.anticipationCents).toBe(0);
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

  it("decreases the split per installment (prorated fixed fee, +3 days)", () => {
    expect(quoteGiftV2(30000, "CREDIT_CARD", 3).recipientSplitCents).toEqual([
      10177, 10000, 9823,
    ]);
    const twelve = quoteGiftV2(10000, "CREDIT_CARD", 12);
    expect(twelve.recipientSplitCents).toEqual([
      921, 905, 889, 873, 857, 841, 825, 809, 793, 777, 761, 749,
    ]);
    expect(Math.min(...twelve.splitSlackCents)).toBe(6);
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
        for (let index = 1; index < count; index += 1)
          expect(schedule.recipientSplitCents[index]).toBeLessThanOrEqual(
            (schedule.recipientSplitCents[index - 1] ?? 0) + 1,
          );
        minimumSlack = Math.min(minimumSlack, ...schedule.splitSlackCents);
      }
    }
    expect(minimumSlack).toBeGreaterThanOrEqual(0);
  });
});
