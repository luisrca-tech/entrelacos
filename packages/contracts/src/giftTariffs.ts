import { GIFT_COMMISSION_BASIS_POINTS } from "./giftCommission";

/**
 * Single source of truth for every tariff number used to price a gift under
 * `PLATFORM_ACCOUNT_SPLIT_V2` (API quotes, couple preview and landing).
 *
 * Card percentages and fixed fees are the platform (main) account contract.
 *
 * Anticipation rates are the AUTOMATIC credit-card anticipation rates of the
 * platform account: 1.15%/month for one-shot card and 1.60%/month for
 * installments. `GET /v3/myAccount/fees/` reports 1.25%/1.70%, but those are
 * the detached (on-demand) anticipation rates; the account uses automatic
 * anticipation. The Slice 0 Sandbox probe confirmed automatic anticipations
 * charged at exactly 1.15% and 1.60% per month over the card net value
 * (docs/plans/asaas-platform-split-probe.md).
 */
export const GIFT_PLATFORM_TARIFFS = {
  version: "platform-tariffs-2026-11-13",
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
   * `splitScheduleDaysPerInstallment * i + splitScheduleExtraDays` days. The
   * Sandbox probe observed 32, 66, 96, 129 … 384 days for a 12x purchase, so
   * the extra days absorb weekend/holiday shifts of the credit date.
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
