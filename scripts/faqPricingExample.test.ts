import { describe, expect, it } from "vitest";
import { faqPricingExamples } from "../apps/landing/src/faqPricingExample";
import { quoteGiftV2 } from "../packages/contracts/src/giftPricingV2";

describe("public R$100 illustration (Pagar.me V2 pricing)", () => {
  it("lists Pix, card in full and the largest installment plan only", () => {
    expect(
      faqPricingExamples.map((row) => [
        row.method,
        row.installmentCents.length,
      ]),
    ).toEqual([
      ["PIX", 1],
      ["CREDIT_CARD", 1],
      ["CREDIT_CARD", 6],
    ]);
  });

  it.each([
    ["PIX", 1, 10369],
    ["CREDIT_CARD", 1, 10854],
    ["CREDIT_CARD", 6, 11890],
  ] as const)(
    "matches checkout pricing and preserves cents for %s in %i payments",
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
      if (method === "PIX") expect(quote.anticipationCents).toBe(0);
      else expect(quote.anticipationCents).toBeGreaterThan(0);
    },
  );
});
