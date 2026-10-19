export const GIFT_COMMISSION_BASIS_POINTS = 200;

export function getGiftCommissionCents(nominalCents: number): number {
  if (!Number.isSafeInteger(nominalCents) || nominalCents < 0) {
    throw new RangeError("Gift amount must be nonnegative integer cents");
  }
  return Number(
    (BigInt(nominalCents) * BigInt(GIFT_COMMISSION_BASIS_POINTS) + 5000n) /
      10000n,
  );
}

export function getGiftPriceWithCommission(nominalCents: number): number {
  const price = nominalCents + getGiftCommissionCents(nominalCents);
  if (!Number.isSafeInteger(price)) {
    throw new RangeError("Gift price exceeds safe integer cents");
  }
  return price;
}
