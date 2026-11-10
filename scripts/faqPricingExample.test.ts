import { describe, expect, it } from "vitest";
import { quoteGiftPurchaseAmounts } from "../apps/api/src/giftMoney";
import { faqPricingExamples } from "../apps/landing/src/faqPricingExample";

describe("public R$100 illustration without anticipation", () => {
  it.each([
    ["PIX", 1, 10399],
    ["CREDIT_CARD", 1, 10565],
    ["CREDIT_CARD", 6, 10620],
    ["CREDIT_CARD", 12, 10675],
  ] as const)(
    "matches current checkout pricing and preserves cents for %s in %i payments",
    (method, count, total) => {
      const row = faqPricingExamples.find(
        (example) =>
          example.method === method &&
          example.installmentCents.length === count,
      );
      const quote = quoteGiftPurchaseAmounts(
        {
          nominalCents: 10000,
          method,
          policy: {
            version: "public-reference-2026-11-09",
            method,
            commissionBasisPoints: 200,
            processingBasisPoints: method === "PIX" ? 0 : 299,
            processingFixedCents: method === "PIX" ? 199 : 49,
            cardInstallmentBasisPoints: { upToSix: 349, upToTwelve: 399 },
            rounding: "CEILING",
            feeAllocation: "BUYER_GROSS_UP",
          },
        },
        count,
      );
      expect(row?.totalCents).toBe(total);
      expect(row?.totalCents).toBe(quote.totalCents);
      expect(row?.installmentCents).toEqual(
        quote.installmentCents ?? [quote.totalCents],
      );
      expect(
        row?.installmentCents.reduce((sum, amount) => sum + amount, 0),
      ).toBe(total);
      expect(row?.combinedFeesCents).toBe(
        quote.commissionCents + quote.processingCents,
      );
      expect(row?.recipientNetCents).toBe(10000);
      expect(
        quote.totalCents - quote.commissionCents - quote.processingCents,
      ).toBe(10000);
    },
  );
});
