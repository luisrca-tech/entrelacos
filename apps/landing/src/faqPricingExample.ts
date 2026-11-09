export type FaqPricingExample = {
  label: string;
  method: "PIX" | "CREDIT_CARD";
  totalCents: number;
  installmentCents: number[];
  installmentSurchargeCents: number;
};
// Static illustration, not account tariffs: https://www.asaas.com/precos-e-taxas
// Public non-promotional reference checked on 2026-11-09; checkout math is verified in scripts/faqPricingExample.test.ts.
export const faqPricingExamples: FaqPricingExample[] = [
  {
    label: "Pix",
    method: "PIX",
    totalCents: 10415,
    installmentCents: [10415],
    installmentSurchargeCents: 0,
  },
  {
    label: "Cartão à vista",
    method: "CREDIT_CARD",
    totalCents: 10565,
    installmentCents: [10565],
    installmentSurchargeCents: 0,
  },
  {
    label: "Cartão em 6x",
    method: "CREDIT_CARD",
    totalCents: 10620,
    installmentCents: [1770, 1770, 1770, 1770, 1770, 1770],
    installmentSurchargeCents: 55,
  },
  {
    label: "Cartão em 12x",
    method: "CREDIT_CARD",
    totalCents: 10675,
    installmentCents: [
      889, 889, 889, 889, 889, 889, 889, 889, 889, 889, 889, 896,
    ],
    installmentSurchargeCents: 110,
  },
];
