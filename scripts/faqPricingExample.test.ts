import { describe, expect, it } from "vitest";
import { quoteGiftPurchaseAmounts } from "../apps/api/src/giftMoney";
import {
  faqPricingExamples,
  faqPricingScenario,
} from "../apps/landing/src/faqPricingExample";

describe("public R$100 planning illustration", () => {
  it("marks the anticipation hypothesis as planning only", () => {
    expect(faqPricingScenario.planningOnly).toBe(true);
    expect(faqPricingScenario.cardMonthlyBasisPoints).toEqual({
      single: 115,
      installments: 160,
    });
  });

  it.each([
    ["PIX", 1, 10399],
    ["CREDIT_CARD", 1, 10688],
    ["CREDIT_CARD", 6, 11248],
    ["CREDIT_CARD", 12, 11909],
  ] as const)(
    "preserves cents and the target net for %s in %i payments",
    (method, count, total) => {
      const row = faqPricingExamples.find(
        (example) =>
          example.method === method &&
          example.installmentCents.length === count,
      );
      expect(row?.totalCents).toBe(total);
      expect(
        row?.installmentCents.reduce((sum, amount) => sum + amount, 0),
      ).toBe(total);
      expect(row?.recipientNetCents).toBe(10000);
      expect(row?.combinedFeesCents).toBe(total - 10000);
    },
  );

  it("keeps the planning hypothesis out of live checkout pricing", () => {
    const quote = quoteGiftPurchaseAmounts(
      {
        nominalCents: 10000,
        method: "CREDIT_CARD",
        policy: {
          version: "processing-only-reference",
          method: "CREDIT_CARD",
          commissionBasisPoints: 200,
          processingBasisPoints: 299,
          processingFixedCents: 49,
          cardInstallmentBasisPoints: { upToSix: 349, upToTwelve: 399 },
          rounding: "CEILING",
          feeAllocation: "BUYER_GROSS_UP",
        },
      },
      12,
    );
    expect(quote.totalCents).toBe(10675);
    expect(
      quote.totalCents - quote.commissionCents - quote.processingCents,
    ).toBe(10000);
  });
});
