import { getGiftCommissionCents } from "./giftCommission";
import {
  type CouplesSplitMode,
  GIFT_PLATFORM_TARIFFS,
  type GiftTariffTier,
  getGiftCardCetBasisPoints,
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
  /** Payment-method costs funded by the guest (MDR/CET part and fixed fees). */
  processingCents: number;
  /** Couple anticipation funded by the guest: C − V (0 on Pix). */
  anticipationCents: number;
  /** G: what the guest pays. */
  totalCents: number;
  installmentCents: number[];
  /** C: couple amount on the order split, grossed up for anticipation. */
  coupleSplitCents: number;
  /** Couple net per installment after anticipation; sums to the nominal. */
  recipientSplitCents: number[];
  /** Conservative platform net: G − rate·G − fixed − V (≥ commission). */
  platformNetCents: number;
  /** True when the option can be offered to a guest. */
  offered: boolean;
}

const BASIS = 10_000n;

function assertCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be nonnegative integer cents`);
}

function assertInstallmentCount(
  method: GiftV2PaymentMethod,
  installmentCount: number,
) {
  if (method === "PIX") {
    if (installmentCount !== 1)
      throw new RangeError("Unsupported installment count");
    return;
  }
  getGiftCardCetBasisPoints(installmentCount);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function toCents(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 2_147_483_647)
    throw new RangeError("Gift total exceeds supported cents");
  return result;
}

/** Remainder goes to the last installment. */
function allocateInstallments(totalCents: number, installmentCount: number) {
  const base = Math.floor(totalCents / installmentCount);
  return Array.from({ length: installmentCount }, (_, index) =>
    index === installmentCount - 1
      ? totalCents - base * (installmentCount - 1)
      : base,
  );
}

/** Basis points the guest total is grossed up by (Pix MDR or card CET[n]). */
function grossUpBasisPoints(
  method: GiftV2PaymentMethod,
  installmentCount: number,
) {
  return method === "PIX"
    ? GIFT_PLATFORM_TARIFFS.pix.mdrBasisPoints
    : getGiftCardCetBasisPoints(installmentCount);
}

function fixedCents(method: GiftV2PaymentMethod) {
  return method === "PIX"
    ? GIFT_PLATFORM_TARIFFS.pix.fixedCents
    : GIFT_PLATFORM_TARIFFS.card.fixedCents;
}

/**
 * Guest total G = ceil((V + comm + fixed) / (1 − rate)), where rate is the
 * Pix MDR or the card CET for the installment count.
 */
export function getGiftV2TotalCents(
  nominalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): number {
  assertCents(nominalCents, "Gift amount");
  assertInstallmentCount(method, installmentCount);
  const base = BigInt(
    nominalCents + getGiftCommissionCents(nominalCents) + fixedCents(method),
  );
  const rate = BigInt(grossUpBasisPoints(method, installmentCount));
  return toCents(ceilDiv(base * BASIS, BASIS - rate));
}

/**
 * Couple split C. Pix is never anticipated, so C = V. On card,
 * C = ceil(V / (1 − ANT[n])) with ANT[n] = m · mean_i((30·i − 2) / 30),
 * i = 1..n: installment i is anticipated from day 30·i to D+2.
 */
export function getGiftV2CoupleSplitCents(
  nominalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): number {
  assertCents(nominalCents, "Gift amount");
  assertInstallmentCount(method, installmentCount);
  if (method === "PIX") return nominalCents;
  const n = BigInt(installmentCount);
  let days = 0n;
  for (let i = 1n; i <= n; i += 1n) days += 30n * i - 2n;
  // ANT = m · days / (10000 · 30 · n)
  const denominator = BASIS * 30n * n;
  const anticipation =
    BigInt(GIFT_PLATFORM_TARIFFS.anticipationMonthlyBasisPoints) * days;
  return toCents(
    ceilDiv(BigInt(nominalCents) * denominator, denominator - anticipation),
  );
}

/**
 * Amount sent on the couple split rule. `charge_total` sends C once;
 * `per_installment` sends ceil(C / n).
 */
export function couplesSplitAmountCents(
  coupleSplitCents: number,
  installmentCount: number,
  mode: CouplesSplitMode = GIFT_PLATFORM_TARIFFS.couplesSplitMode,
): number {
  assertCents(coupleSplitCents, "Couple split");
  assertInstallmentCount("CREDIT_CARD", installmentCount);
  if (mode === "charge_total") return coupleSplitCents;
  if (mode === "per_installment")
    return toCents(ceilDiv(BigInt(coupleSplitCents), BigInt(installmentCount)));
  throw new RangeError("Unsupported couple split mode");
}

export function quoteGiftV2(
  nominalCents: number,
  method: GiftV2PaymentMethod,
  installmentCount: number,
): GiftV2Quote {
  const totalCents = getGiftV2TotalCents(
    nominalCents,
    method,
    installmentCount,
  );
  const coupleSplitCents = getGiftV2CoupleSplitCents(
    nominalCents,
    method,
    installmentCount,
  );
  const commissionCents = getGiftCommissionCents(nominalCents);
  const anticipationCents = coupleSplitCents - nominalCents;
  const processingCents =
    totalCents - nominalCents - commissionCents - anticipationCents;
  if (processingCents < 0)
    throw new RangeError("Gift V2 quote produced negative processing");
  const platformNetCents =
    totalCents -
    toCents(
      ceilDiv(
        BigInt(totalCents) *
          BigInt(grossUpBasisPoints(method, installmentCount)),
        BASIS,
      ),
    ) -
    fixedCents(method) -
    nominalCents;
  const offered =
    nominalCents > 0 &&
    (installmentCount === 1 ||
      Math.floor(totalCents / installmentCount) >=
        GIFT_PLATFORM_TARIFFS.minimumInstallmentCents);
  return {
    method,
    installmentCount,
    tier: getGiftTariffTier(method, installmentCount),
    tariffVersion: GIFT_PLATFORM_TARIFFS.version,
    nominalCents,
    commissionCents,
    processingCents,
    anticipationCents,
    totalCents,
    installmentCents: allocateInstallments(totalCents, installmentCount),
    coupleSplitCents,
    recipientSplitCents: allocateInstallments(nominalCents, installmentCount),
    platformNetCents,
    offered,
  };
}

/** Pix plus every offered card option (1x..6x) for a nominal gift amount. */
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
