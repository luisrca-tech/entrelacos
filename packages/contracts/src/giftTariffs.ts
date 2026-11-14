import { GIFT_COMMISSION_BASIS_POINTS } from "./giftCommission";

/**
 * Single source of truth for every tariff number used to price a gift under
 * `PLATFORM_ACCOUNT_SPLIT_V2` (API quotes, couple preview and landing).
 *
 * Card percentages and fixed fees are the platform (main) account contract.
 *
 * Anticipation rates are 0 on purpose (2026-11-13): Asaas confirmed it does
 * not anticipate gift or donation charges, so the couple receives each card
 * installment when the card settles it (about 32 days per installment) and the
 * guest does not pay for anticipation. The fields stay so the rates can be
 * restored by changing values only if Asaas ever approves anticipation for
 * gifts; this is not a feature flag.
 */
export const GIFT_PLATFORM_TARIFFS = {
  version: "platform-tariffs-2026-11-13",
  commissionBasisPoints: GIFT_COMMISSION_BASIS_POINTS,
  pix: { basisPoints: 0, fixedCents: 199, anticipationMonthlyBasisPoints: 0 },
  card1: {
    basisPoints: 299,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 0,
  },
  card2to6: {
    basisPoints: 349,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 0,
  },
  card7to12: {
    basisPoints: 399,
    fixedCents: 49,
    anticipationMonthlyBasisPoints: 0,
  },
  minimumInstallmentCents: 500,
  maxInstallments: 12,
  /**
   * Anticipation days used only to distribute the couple split across
   * installments when an anticipation rate is non-zero: installment i is
   * assumed to be anticipated for
   * `splitScheduleDaysPerInstallment * i + splitScheduleExtraDays` days.
   * With every anticipation rate at 0 they have no effect.
   */
  splitScheduleDaysPerInstallment: 32,
  splitScheduleExtraDays: 3,
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
