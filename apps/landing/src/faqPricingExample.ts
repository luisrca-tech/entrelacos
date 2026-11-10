import {
  getGiftCommissionCents,
  simulateGiftAnticipation,
} from "@entrelacos/contracts";

export type FaqPricingExample = {
  label: string;
  method: "PIX" | "CREDIT_CARD";
  totalCents: number;
  installmentCents: number[];
  combinedFeesCents: number;
  recipientNetCents: number;
};

// Planning references from the platform account, not approved receiver tariffs.
// Keep this hypothetical scenario separate from live checkout quotes.
export const faqPricingScenario = {
  planningOnly: true,
  nominalCents: 10000,
  commissionBasisPoints: 200,
  cardFixedCents: 49,
  cardMonthlyBasisPoints: { single: 115, installments: 160 },
  pixFixedCents: 199,
} as const;

const pixFeesCents =
  getGiftCommissionCents(faqPricingScenario.nominalCents) +
  faqPricingScenario.pixFixedCents;
const pixTotalCents = faqPricingScenario.nominalCents + pixFeesCents;

export const faqPricingExamples: FaqPricingExample[] = [
  {
    label: "Pix",
    method: "PIX",
    totalCents: pixTotalCents,
    installmentCents: [pixTotalCents],
    combinedFeesCents: pixFeesCents,
    recipientNetCents: faqPricingScenario.nominalCents,
  },
  ...(
    [
      { count: 1, processingBasisPoints: 299, label: "Cartão à vista" },
      { count: 6, processingBasisPoints: 349, label: "Cartão em 6x" },
      { count: 12, processingBasisPoints: 399, label: "Cartão em 12x" },
    ] as const
  ).map(({ count, processingBasisPoints, label }) => {
    const example = simulateGiftAnticipation({
      nominalCents: faqPricingScenario.nominalCents,
      commissionBasisPoints: faqPricingScenario.commissionBasisPoints,
      processingBasisPoints,
      fixedCents: faqPricingScenario.cardFixedCents,
      monthlyAnticipationBasisPoints:
        count === 1
          ? faqPricingScenario.cardMonthlyBasisPoints.single
          : faqPricingScenario.cardMonthlyBasisPoints.installments,
      installmentDays: Array.from(
        { length: count },
        (_, index) => (index + 1) * 30,
      ),
    });
    return {
      label,
      method: "CREDIT_CARD" as const,
      totalCents: example.totalCents,
      installmentCents: example.installmentCents,
      combinedFeesCents: example.surchargeCents,
      recipientNetCents: example.netCoupleCents,
    };
  }),
];
