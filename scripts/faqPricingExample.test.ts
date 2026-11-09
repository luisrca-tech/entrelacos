import { describe, expect, it } from "vitest";
import { quoteGiftPurchaseAmounts } from "../apps/api/src/giftMoney";
import { faqPricingExamples } from "../apps/landing/src/faqPricingExample";

describe("public R$100 illustration", () => {
  it.each([
    ["PIX", 1, 10415],
    ["CREDIT_CARD", 1, 10565],
    ["CREDIT_CARD", 6, 10620],
    ["CREDIT_CARD", 12, 10675],
  ] as const)(
    "matches checkout arithmetic for %s in %i payments",
    (method, count, total) => {
      const example = faqPricingExamples.find(
        (row) => row.method === method && row.installmentCents.length === count,
      );
      expect(example).toBeDefined();
      const quote = quoteGiftPurchaseAmounts(
        {
          nominalCents: 10000,
          method,
          policy: {
            version: "public-example-2026-11-09",
            method,
            commissionBasisPoints: 200,
            processingBasisPoints: method === "PIX" ? 0 : 299,
            processingFixedCents: method === "PIX" ? 215 : 49,
            cardInstallmentBasisPoints: { upToSix: 349, upToTwelve: 399 },
            rounding: "CEILING",
            feeAllocation: "BUYER_GROSS_UP",
          },
        },
        count,
      );
      expect(example?.totalCents).toBe(total);
      expect(example?.totalCents).toBe(quote.totalCents);
      expect(example?.installmentCents).toEqual(
        quote.installmentCents ?? [quote.totalCents],
      );
      expect(example?.installmentSurchargeCents).toBe(
        quote.installmentSurchargeCents ?? 0,
      );
      expect(
        quote.totalCents - quote.commissionCents - quote.processingCents,
      ).toBe(10000);
    },
  );
});
