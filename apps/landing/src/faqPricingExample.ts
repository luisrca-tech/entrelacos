export type FaqPricingExample = {
  label: string;
  method: "PIX" | "CREDIT_CARD";
  totalCents: number;
  installmentCents: number[];
  combinedFeesCents: number;
  recipientNetCents: number;
};

// Standard account references checked on 2026-11-09, without promotions or anticipation.
// scripts/faqPricingExample.test.ts verifies these fixtures against actual checkout math.
export const faqPricingExamples: FaqPricingExample[] = [
  {
    label: "Pix",
    method: "PIX",
    totalCents: 10399,
    installmentCents: [10399],
    combinedFeesCents: 399,
    recipientNetCents: 10000,
  },
  {
    label: "Cartão à vista",
    method: "CREDIT_CARD",
    totalCents: 10565,
    installmentCents: [10565],
    combinedFeesCents: 565,
    recipientNetCents: 10000,
  },
  {
    label: "Cartão em 6x",
    method: "CREDIT_CARD",
    totalCents: 10620,
    installmentCents: [1770, 1770, 1770, 1770, 1770, 1770],
    combinedFeesCents: 620,
    recipientNetCents: 10000,
  },
  {
    label: "Cartão em 12x",
    method: "CREDIT_CARD",
    totalCents: 10675,
    installmentCents: [
      889, 889, 889, 889, 889, 889, 889, 889, 889, 889, 889, 896,
    ],
    combinedFeesCents: 675,
    recipientNetCents: 10000,
  },
];
