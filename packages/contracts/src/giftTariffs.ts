import { GIFT_COMMISSION_BASIS_POINTS } from "./giftCommission";

/**
 * Single source of truth for every tariff number used to price a gift under
 * `PLATFORM_ACCOUNT_SPLIT_V2` (API quotes, couple preview and landing).
 *
 * Card percentages and fixed fees are the platform (main) account contract.
 *
 * Anticipation (decision of 2026-11-14): the platform account has AUTOMATIC
 * credit-card anticipation enabled with a special rate of 1.15% a month for
 * one-off charges and 1.6% a month for installments; Pix is never
 * anticipated. The guest pays the payment-method fee, the anticipation fee
 * and the 2% Entrelaços service, so the couple receives 100% of the gift,
 * usually about 2 business days after the card payment. Asaas charges the
 * anticipation on each installment net value for the days until its credit
 * date. If Asaas does not anticipate a charge, each installment still settles
 * normally and the couple split is unchanged.
 */
export const GIFT_PLATFORM_TARIFFS = {
  version: "platform-tariffs-2026-11-14",
  commissionBasisPoints: GIFT_COMMISSION_BASIS_POINTS,
  pix: { basisPoints: 0, fixedCents: 199, anticipationMonthlyBasisPoints: 0 },
  card1: {
    basisPoints: 299,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 115,
  },
  card2to6: {
    basisPoints: 349,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 160,
  },
  card7to12: {
    basisPoints: 399,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 160,
  },
  minimumInstallmentCents: 500,
  maxInstallments: 12,
  /**
   * Conservative anticipation days used only to distribute the couple split
   * across installments: installment i is assumed to be anticipated for
   * `splitScheduleDaysPerInstallment * i + splitScheduleExtraDays` days from
   * the payment date. Sandbox credit dates (2026-11-13 probe) reached
   * 32, 66, 96, …, 290, …, 384 days for a 12x charge; 33·i + 5 keeps 5 to 17
   * days of margin for weekends and holidays, so net_i never drops below the
   * couple split of that installment.
   */
  splitScheduleDaysPerInstallment: 33,
  splitScheduleExtraDays: 5,
} as const;

export type GiftTariffTier = "pix" | "card1" | "card2to6" | "card7to12";
export type GiftTariff = {
  readonly basisPoints: number;
  readonly fixedCents: number;
  readonly anticipationMonthlyBasisPoints: number;
};

export function getGiftTariffTier(
  method: "PIX" | "CREDIT_CARD",
  installmentCount: number,
): GiftTariffTier {
  if (method === "PIX") return "pix";
  if (installmentCount <= 1) return "card1";
  if (installmentCount <= 6) return "card2to6";
  return "card7to12";
}

export function getGiftTariff(tier: GiftTariffTier): GiftTariff {
  return GIFT_PLATFORM_TARIFFS[tier];
}
