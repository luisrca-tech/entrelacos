import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { quoteGiftV2 } from "../../../packages/contracts/src/giftPricingV2";
import { GIFT_PLATFORM_TARIFFS } from "../../../packages/contracts/src/giftTariffs";
import {
  faqPricingExampleNominalCents,
  faqPricingExamples,
} from "./faqPricingExample";

describe("public pricing example", () => {
  it("uses quoteGiftV2 for every row", () => {
    const nominal = faqPricingExampleNominalCents;
    const expected = [
      quoteGiftV2(nominal, "PIX", 1),
      quoteGiftV2(nominal, "CREDIT_CARD", 1),
      quoteGiftV2(
        nominal,
        "CREDIT_CARD",
        GIFT_PLATFORM_TARIFFS.maxInstallments,
      ),
    ];
    expect(faqPricingExamples).toHaveLength(expected.length);
    faqPricingExamples.forEach((row, index) => {
      const quote = expected[index];
      expect(row.method).toBe(quote.method);
      expect(row.totalCents).toBe(quote.totalCents);
      expect(row.installmentCents).toEqual(quote.installmentCents);
      expect(row.combinedFeesCents).toBe(quote.totalCents - nominal);
      expect(row.recipientNetCents).toBe(nominal);
    });
    expect(faqPricingExamples.at(-1)?.label).toContain(
      `${GIFT_PLATFORM_TARIFFS.maxInstallments}x`,
    );
  });

  it("keeps fixed amounts out of the component copy", () => {
    const source = readFileSync(
      new URL("./components/PricingExample.astro", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/R\$\s*\d/);
    expect(source).not.toMatch(/\d+,\d{2}/);
    expect(source).not.toMatch(/\d\s*%/);
    expect(source).toContain("faqPricingExampleNominalCents");
  });
});
