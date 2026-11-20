import { GIFT_COMMISSION_BASIS_POINTS } from "./giftCommission";

/** To confirm with Pagar.me: gateway fee on Pix. */
export const PIX_FIXED_CENTS = 55;

/**
 * How the couple split amount is sent on an installment card order:
 * `charge_total` sends the whole couple amount once; `per_installment` sends
 * ceil(amount / installments). The sandbox payables test decides.
 */
export type CouplesSplitMode = "charge_total" | "per_installment";

/**
 * Single source of truth for every tariff number used to price a gift on
 * Pagar.me (API quotes, couple preview and landing).
 *
 * The guest pays the gift, the 2% Entrelaços service and every Pagar.me cost.
 * Card prices are grossed up by the D+2 CET for the installment count (MDR,
 * automatic anticipation and chargeback guarantee) plus the per-transaction
 * gateway and antifraud fees. The couple recipient has automatic anticipation,
 * so its split is grossed up by the monthly anticipation rate to net the gift.
 * Pix is never anticipated.
 */
export const GIFT_PLATFORM_TARIFFS = {
  version: "pagarme-proposal-2026-11",
  commissionBasisPoints: GIFT_COMMISSION_BASIS_POINTS,
  pix: { mdrBasisPoints: 109, fixedCents: PIX_FIXED_CENTS },
  card: {
    /** Gateway 55 + antifraud 44, charged per transaction. */
    fixedCents: 99,
    cetBasisPointsByInstallments: {
      1: 511,
      2: 817,
      3: 947,
      4: 1077,
      5: 1207,
      6: 1338,
    },
    mdrBasisPoints: { 1: 264, "2to6": 429 },
  },
  anticipationMonthlyBasisPoints: 272,
  withdrawalFeeCents: 367,
  minimumInstallmentCents: 500,
  maxInstallments: 6,
  couplesSplitMode: "charge_total" as CouplesSplitMode,
} as const;

export type GiftTariffTier = "pix" | "card1" | "card2to6";
export type CardInstallmentCount = 1 | 2 | 3 | 4 | 5 | 6;
export type GiftTariff = {
  readonly mdrBasisPoints: number;
  readonly fixedCents: number;
};

export function assertCardInstallmentCount(
  installmentCount: number,
): asserts installmentCount is CardInstallmentCount {
  if (
    !Number.isSafeInteger(installmentCount) ||
    installmentCount < 1 ||
    installmentCount > GIFT_PLATFORM_TARIFFS.maxInstallments
  )
    throw new RangeError("Unsupported installment count");
}

export function getGiftTariffTier(
  method: "PIX" | "CREDIT_CARD",
  installmentCount: number,
): GiftTariffTier {
  if (method === "PIX") return "pix";
  assertCardInstallmentCount(installmentCount);
  return installmentCount === 1 ? "card1" : "card2to6";
}

export function getGiftTariff(tier: GiftTariffTier): GiftTariff {
  const { pix, card } = GIFT_PLATFORM_TARIFFS;
  if (tier === "pix") return pix;
  return {
    mdrBasisPoints:
      tier === "card1" ? card.mdrBasisPoints[1] : card.mdrBasisPoints["2to6"],
    fixedCents: card.fixedCents,
  };
}

export function getGiftCardCetBasisPoints(installmentCount: number): number {
  assertCardInstallmentCount(installmentCount);
  return GIFT_PLATFORM_TARIFFS.card.cetBasisPointsByInstallments[
    installmentCount
  ];
}
