import {
  type GiftV2PaymentMethod,
  quoteGiftV2,
} from "../../../packages/contracts/src/giftPricingV2";
import { GIFT_PLATFORM_TARIFFS } from "../../../packages/contracts/src/giftTariffs";

export type FaqPricingExample = {
  label: string;
  method: GiftV2PaymentMethod;
  totalCents: number;
  installmentCents: number[];
  combinedFeesCents: number;
  recipientNetCents: number;
};

/** Gift amount the couple registers in the public example (R$ 100,00). */
export const faqPricingExampleNominalCents = 10000;

const example = (
  label: string,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): FaqPricingExample => {
  const quote = quoteGiftV2(
    faqPricingExampleNominalCents,
    method,
    installmentCount,
  );
  return {
    label,
    method,
    totalCents: quote.totalCents,
    installmentCents: quote.installmentCents,
    // The guest pays the payment fees, card anticipation and the Entrelaços
    // service; the couple keeps the whole gift.
    combinedFeesCents: quote.totalCents - quote.nominalCents,
    recipientNetCents: quote.nominalCents,
  };
};

// Derived from the same pricing the checkout uses, so the public example
// cannot drift from the guest total.
export const faqPricingExamples: FaqPricingExample[] = [
  example("Pix", "PIX", 1),
  example("Cartão à vista", "CREDIT_CARD", 1),
  example(
    `Cartão em ${GIFT_PLATFORM_TARIFFS.maxInstallments}x`,
    "CREDIT_CARD",
    GIFT_PLATFORM_TARIFFS.maxInstallments,
  ),
];

export const formatBrl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
