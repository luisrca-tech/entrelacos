import { getGiftCommissionCents } from "./giftCommission";
import {
  GIFT_PLATFORM_TARIFFS,
  type GiftTariffTier,
  getGiftTariff,
  getGiftTariffTier,
} from "./giftTariffs";

export type GiftV2PaymentMethod = "PIX" | "CREDIT_CARD";

export interface GiftV2Quote {
  method: GiftV2PaymentMethod;
  installmentCount: number;
  tier: GiftTariffTier;
  tariffVersion: string;
  nominalCents: number;
  commissionCents: number;
  /** Card or Pix processing fee (percentage + fixed). */
  processingCents: number;
  /** Estimated anticipation cost; 0 while the tariff table has no anticipation. */
  anticipationCents: number;
  totalCents: number;
  installmentCents: number[];
  /** Fixed split to the couple wallet per installment; sums to the nominal. */
  recipientSplitCents: number[];
  /** Estimated margin left on each installment after the couple split. */
  splitSlackCents: number[];
  /** True when the option can be offered to a guest. */
  offered: boolean;
}

function assertCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be nonnegative integer cents`);
}

function assertInstallmentCount(
  method: GiftV2PaymentMethod,
  installmentCount: number,
) {
  if (
    !Number.isSafeInteger(installmentCount) ||
    installmentCount < 1 ||
    installmentCount > GIFT_PLATFORM_TARIFFS.maxInstallments ||
    (method === "PIX" && installmentCount !== 1)
  )
    throw new RangeError("Unsupported installment count");
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Same allocation as `allocateGiftInstallmentCents`: remainder goes last. */
function allocateInstallments(totalCents: number, installmentCount: number) {
  const base = Math.floor(totalCents / installmentCount);
  return Array.from({ length: installmentCount }, (_, index) =>
    index === installmentCount - 1
      ? totalCents - base * (installmentCount - 1)
      : base,
  );
}

/**
 * Guest-pays-everything total with a single ceiling (closed form of sim.py):
 *   k = 20000 − m·(n+1)
 *   total = ceil((gc·20000 + f·k)·10000 / (k·(10000 − p)))
 */
export function getGiftV2TotalCents(
  nominalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): number {
  assertCents(nominalCents, "Gift amount");
  assertInstallmentCount(method, installmentCount);
  const tariff = getGiftTariff(getGiftTariffTier(method, installmentCount));
  const gc = BigInt(nominalCents + getGiftCommissionCents(nominalCents));
  const p = BigInt(tariff.basisPoints);
  const f = BigInt(tariff.fixedCents);
  const k =
    20000n -
    BigInt(tariff.anticipationMonthlyBasisPoints) *
      BigInt(installmentCount + 1);
  const total = ceilDiv((gc * 20000n + f * k) * 10000n, k * (10000n - p));
  const result = Number(total);
  if (!Number.isSafeInteger(result) || result > 2_147_483_647)
    throw new RangeError("Gift total exceeds supported cents");
  return result;
}

/**
 * Per-installment couple split for card installments.
 *
 * Asaas fixes the split per child charge. The split is distributed with the
 * largest-remainder method proportionally to a conservative estimate of each
 * installment net value (equal shares when there is no anticipation):
 *   fee_i  = ceil(inst_i·p/10000) + ceil(f/n)   (Slice 0: 0.49 is prorated)
 *   card_i = inst_i − fee_i
 *   net_i  = card_i − ceil(card_i·m·days_i / (10000·30))
 *   days_i = D·i + extra
 * Returns null when any installment would net less than its split.
 */
export function giftSplitScheduleV2(
  nominalCents: number,
  totalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): { recipientSplitCents: number[]; splitSlackCents: number[] } | null {
  assertCents(nominalCents, "Gift amount");
  assertCents(totalCents, "Gift total");
  assertInstallmentCount(method, installmentCount);
  const tariff = getGiftTariff(getGiftTariffTier(method, installmentCount));
  const installments = allocateInstallments(totalCents, installmentCount);
  const p = BigInt(tariff.basisPoints);
  const m = BigInt(tariff.anticipationMonthlyBasisPoints);
  const fixedShare = ceilDiv(
    BigInt(tariff.fixedCents),
    BigInt(installmentCount),
  );
  const nets = installments.map((installment, index) => {
    const value = BigInt(installment);
    const card = value - ceilDiv(value * p, 10000n) - fixedShare;
    const days = BigInt(
      GIFT_PLATFORM_TARIFFS.splitScheduleDaysPerInstallment * (index + 1) +
        GIFT_PLATFORM_TARIFFS.splitScheduleExtraDays,
    );
    const anticipation =
      card > 0n ? ceilDiv(card * m * days, 10000n * 30n) : 0n;
    return card - anticipation;
  });
  if (nets.some((net) => net <= 0n)) return null;
  const netSum = nets.reduce((sum, net) => sum + net, 0n);
  const nominal = BigInt(nominalCents);
  const split = nets.map((net) => (nominal * net) / netSum);
  let remainder = nominal - split.reduce((sum, value) => sum + value, 0n);
  const order = nets
    .map((net, index) => ({ index, rest: (nominal * net) % netSum }))
    .sort((a, b) =>
      a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1,
    );
  for (const { index } of order) {
    if (remainder === 0n) break;
    split[index] = (split[index] ?? 0n) + 1n;
    remainder -= 1n;
  }
  const slack = nets.map((net, index) => net - (split[index] ?? 0n));
  if (slack.some((value) => value < 0n)) return null;
  return {
    recipientSplitCents: split.map(Number),
    splitSlackCents: slack.map(Number),
  };
}

export function quoteGiftV2(
  nominalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): GiftV2Quote {
  const tier = getGiftTariffTier(method, installmentCount);
  const tariff = getGiftTariff(tier);
  const totalCents = getGiftV2TotalCents(
    nominalCents,
    method,
    installmentCount,
  );
  const commissionCents = getGiftCommissionCents(nominalCents);
  const guestFeesCents = totalCents - nominalCents - commissionCents;
  // Without anticipation the single-ceiling rounding residue belongs to the
  // processing fee, so new quotes always store anticipation = 0.
  const processingCents =
    tariff.anticipationMonthlyBasisPoints === 0
      ? guestFeesCents
      : tariff.fixedCents +
        Number(
          ceilDiv(BigInt(totalCents) * BigInt(tariff.basisPoints), 10000n),
        );
  const anticipationCents = guestFeesCents - processingCents;
  if (anticipationCents < 0)
    throw new RangeError("Gift V2 quote produced negative anticipation");
  const installmentCents = allocateInstallments(totalCents, installmentCount);
  const schedule =
    installmentCount === 1
      ? {
          recipientSplitCents: [nominalCents],
          splitSlackCents: [
            totalCents - processingCents - anticipationCents - nominalCents,
          ],
        }
      : giftSplitScheduleV2(nominalCents, totalCents, method, installmentCount);
  const offered =
    nominalCents > 0 &&
    schedule !== null &&
    (installmentCount === 1 ||
      Math.floor(totalCents / installmentCount) >=
        GIFT_PLATFORM_TARIFFS.minimumInstallmentCents);
  return {
    method,
    installmentCount,
    tier,
    tariffVersion: GIFT_PLATFORM_TARIFFS.version,
    nominalCents,
    commissionCents,
    processingCents,
    anticipationCents,
    totalCents,
    installmentCents,
    recipientSplitCents: schedule?.recipientSplitCents ?? [],
    splitSlackCents: schedule?.splitSlackCents ?? [],
    offered,
  };
}

/** Pix plus every offered card option (1x..12x) for a nominal gift amount. */
export function listGiftV2Options(nominalCents: number): {
  pix: GiftV2Quote;
  card: GiftV2Quote[];
} {
  const pix = quoteGiftV2(nominalCents, "PIX", 1);
  const card = Array.from(
    { length: GIFT_PLATFORM_TARIFFS.maxInstallments },
    (_, index) => quoteGiftV2(nominalCents, "CREDIT_CARD", index + 1),
  ).filter((quote) => quote.offered);
  return { pix, card };
}
