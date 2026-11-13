import { listGiftV2Options } from "../../../packages/contracts/src/giftPricingV2";

export type FaqPricingExample = {
  label: string;
  method: "PIX" | "CREDIT_CARD";
  totalCents: number;
  installmentCents: number[];
  combinedFeesCents: number;
  recipientNetCents: number;
};

const nominalCents = 10000;
const options = listGiftV2Options(nominalCents);
const example = (
  label: string,
  quote: (typeof options)["pix"],
): FaqPricingExample => ({
  label,
  method: quote.method,
  totalCents: quote.totalCents,
  installmentCents: quote.installmentCents,
  // Commission, processing and anticipation are paid by the guest.
  combinedFeesCents: quote.totalCents - nominalCents,
  recipientNetCents: nominalCents,
});
const card = (count: number) => {
  const quote = options.card.find((entry) => entry.installmentCount === count);
  if (!quote) throw new Error(`Missing ${count}x option`);
  return quote;
};

// Derived from the same V2 pricing the checkout uses (platform tariff table),
// so the public example cannot drift from the guest total.
export const faqPricingExamples: FaqPricingExample[] = [
  example("Pix", options.pix),
  example("Cartão à vista", card(1)),
  example("Cartão em 6x", card(6)),
  example("Cartão em 12x", card(12)),
];
