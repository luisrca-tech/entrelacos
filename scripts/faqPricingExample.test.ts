import { describe, expect, it } from "vitest";
import { faqPricingExamples } from "../apps/landing/src/faqPricingExample";
import { quoteGiftV2 } from "../packages/contracts/src/giftPricingV2";

describe("public R$100 illustration with automatic anticipation (V2)", () => {
  it.each([
    ["PIX", 1, 10399],
    ["CREDIT_CARD", 1, 10688],
    ["CREDIT_CARD", 6, 11247],
    ["CREDIT_CARD", 12, 11909],
  ] as const)(
    "matches V2 checkout pricing and preserves cents for %s in %i payments",
    (method, count, total) => {
      const row = faqPricingExamples.find(
        (example) =>
          example.method === method &&
          example.installmentCents.length === count,
      );
      const quote = quoteGiftV2(10000, method, count);
      expect(row?.totalCents).toBe(total);
      expect(row?.totalCents).toBe(quote.totalCents);
      expect(row?.installmentCents).toEqual(quote.installmentCents);
      expect(
        row?.installmentCents.reduce((sum, amount) => sum + amount, 0),
      ).toBe(total);
      // The guest pays every fee; the couple receives the full nominal value.
      expect(row?.combinedFeesCents).toBe(
        quote.commissionCents + quote.processingCents + quote.anticipationCents,
      );
      expect(row?.recipientNetCents).toBe(10000);
      expect(quote.recipientSplitCents.reduce((sum, v) => sum + v, 0)).toBe(
        10000,
      );
    },
  );
});
