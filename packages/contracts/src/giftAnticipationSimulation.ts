import {
  allocateGiftInstallmentCents,
  giftMaximumInstallments,
} from "./internalGifts";

const BASIS_POINTS = 10_000n;
const MONTH_DAYS = 30n;

export interface GiftAnticipationSimulationInput {
  nominalCents: number;
  commissionBasisPoints: number;
  processingBasisPoints: number;
  fixedCents: number;
  monthlyAnticipationBasisPoints: number;
  installmentDays: readonly number[];
}

function ceilingDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// Planning hypothesis: simple daily discount on equal shares of the amount
// after processing, before the platform split. The buyer covers all fees.
export function simulateGiftAnticipation({
  nominalCents,
  commissionBasisPoints,
  processingBasisPoints,
  fixedCents,
  monthlyAnticipationBasisPoints,
  installmentDays,
}: GiftAnticipationSimulationInput) {
  const installmentCount = installmentDays.length;
  if (
    !Number.isSafeInteger(nominalCents) ||
    nominalCents <= 0 ||
    !Number.isSafeInteger(fixedCents) ||
    fixedCents < 0 ||
    ![
      commissionBasisPoints,
      processingBasisPoints,
      monthlyAnticipationBasisPoints,
    ].every((rate) => Number.isInteger(rate) && rate >= 0 && rate < 10_000) ||
    installmentCount < 1 ||
    installmentCount > giftMaximumInstallments
  ) {
    throw new RangeError("Invalid gift anticipation simulation input");
  }

  const monthlyRate = BigInt(monthlyAnticipationBasisPoints);
  const dailyDenominator = BASIS_POINTS * MONTH_DAYS;
  let totalDiscount = 0n;
  for (const days of installmentDays) {
    if (!Number.isSafeInteger(days) || days < 0) {
      throw new RangeError("Installment days must be nonnegative integers");
    }
    const discount = monthlyRate * BigInt(days);
    if (discount >= dailyDenominator) {
      throw new RangeError("Installment discount must be below 100 percent");
    }
    totalDiscount += discount;
  }

  const nominal = BigInt(nominalCents);
  const commission =
    (nominal * BigInt(commissionBasisPoints) + BASIS_POINTS / 2n) /
    BASIS_POINTS;
  const giftWithCommission = nominal + commission;
  const averageDenominator = dailyDenominator * BigInt(installmentCount);

  // Invert each fee separately so its ceiling to cents preserves the gift.
  const afterProcessing = ceilingDivide(
    giftWithCommission * averageDenominator,
    averageDenominator - totalDiscount,
  );
  const total = ceilingDivide(
    (afterProcessing + BigInt(fixedCents)) * BASIS_POINTS,
    BASIS_POINTS - BigInt(processingBasisPoints),
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Simulated total exceeds safe integer cents");
  }
  const totalCents = Number(total);
  if (totalCents < installmentCount) {
    throw new RangeError("Each installment must be at least one cent");
  }

  return {
    planningOnly: true as const,
    totalCents,
    surchargeCents: totalCents - nominalCents,
    commissionCents: Number(commission),
    processingFeeCents: Number(total - afterProcessing),
    anticipationFeeCents: Number(afterProcessing - giftWithCommission),
    installmentCents: allocateGiftInstallmentCents(
      totalCents,
      installmentCount,
    ),
    netCoupleCents: nominalCents,
  };
}
