/**
 * Commercial facts shown on the public landing. Keep them here so the home
 * page, the FAQ and the privacy page cannot drift apart.
 */
export const SITE_PLANS = {
  /** One of the existing styles, personalized with the couple's content. */
  model: {
    priceCents: 30000,
    /** Site payment: Pix or boleto upfront, or card in up to 3 installments. */
    maxInstallments: 3,
    /**
     * Calendar days to build, approve and deliver the site, counted from the
     * day the couple has sent all the content.
     */
    deliveryDays: 15,
    /** The site goes offline and its data is deleted after this period. */
    onlineMonthsAfterWedding: 3,
  },
  /** Structure changed for the couple; price and schedule agreed beforehand. */
  exclusive: { fromCents: 50000 },
} as const;

export const siteDeliveryLabel = `até ${SITE_PLANS.model.deliveryDays} dias`;
/** The Exclusive plan starts from the same window; heavy customization can extend it. */
export const exclusiveDeliveryLabel = `${SITE_PLANS.model.deliveryDays} dias, ajustável conforme a personalização`;
export const siteOnlineLabel = `até ${SITE_PLANS.model.onlineMonthsAfterWedding} meses depois do casamento`;

/** Legal holder of the service until Entrelaços has its own company. */
export const BUSINESS_IDENTITY = {
  holder: "Luis Felipe da Rocha Cruz Alves Oliveira",
  role: "desenvolvedor de software",
  cnpj: "59176064000190",
} as const;

const cnpjDigit = (digits: number[]) => {
  const weights =
    digits.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const rest =
    digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 11;
  return rest < 2 ? 0 : 11 - rest;
};

/** Validates both CNPJ check digits; punctuation is ignored. */
export function isValidCnpj(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const numbers = [...digits].map(Number);
  const first = cnpjDigit(numbers.slice(0, 12));
  const second = cnpjDigit([...numbers.slice(0, 12), first]);
  return numbers[12] === first && numbers[13] === second;
}

export const formatCnpj = (value: string) =>
  value
    .replace(/\D/g, "")
    .replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

/** Site prices read better without ",00" when they are whole reais. */
export const formatPlanPrice = (cents: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
