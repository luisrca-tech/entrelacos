import {
  type GiftQuote,
  getGiftCommissionCents,
  giftCentsSchema,
  giftPaymentMethodSchema,
  giftQuoteSchema,
} from "@entrelacos/contracts";

export interface GiftProcessingPolicy {
  version: GiftQuote["policyVersion"];
  method: GiftQuote["method"];
  commissionBasisPoints: 200;
  processingBasisPoints: number;
  processingFixedCents: number;
  rounding: "CEILING";
  feeAllocation?: GiftQuote["feeAllocation"];
  feeBasis?: "OBSERVED_ESTIMATE" | "SANDBOX_BUYER_ESTIMATE";
}

export interface QuoteGiftAmountsInput {
  nominalCents: number;
  method: GiftQuote["method"];
  policy: GiftProcessingPolicy | null;
}

export type GiftAmounts = Pick<
  GiftQuote,
  | "nominalCents"
  | "commissionCents"
  | "processingCents"
  | "totalCents"
  | "policyVersion"
  | "feeAllocation"
>;

export class GiftMoneyServiceError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: "QUOTE_INVALID" | "POLICY_UNAVAILABLE",
    readonly title: string,
  ) {
    super(title);
    this.name = "GiftMoneyServiceError";
  }
}

const BASIS_POINTS = 10_000n;

function ceilingDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function policyUnavailable(): never {
  throw new GiftMoneyServiceError(
    409,
    "POLICY_UNAVAILABLE",
    "Gift processing policy is unavailable",
  );
}

function quoteInvalid(): never {
  throw new GiftMoneyServiceError(
    400,
    "QUOTE_INVALID",
    "Gift amount or payment method is invalid",
  );
}

// This injected arithmetic policy does not represent approved provider fees.
export function quoteGiftAmounts(input: QuoteGiftAmountsInput): GiftAmounts {
  const nominalResult = giftCentsSchema.safeParse(input.nominalCents);
  if (
    !nominalResult.success ||
    nominalResult.data === 0 ||
    !giftPaymentMethodSchema.safeParse(input.method).success
  ) {
    return quoteInvalid();
  }
  const injected = input.policy;
  if (
    !injected ||
    injected.method !== input.method ||
    injected.commissionBasisPoints !== 200 ||
    (injected.feeBasis !== undefined &&
      injected.feeBasis !== "OBSERVED_ESTIMATE" &&
      injected.feeBasis !== "SANDBOX_BUYER_ESTIMATE") ||
    (injected.feeBasis === "OBSERVED_ESTIMATE" &&
      injected.feeAllocation !== "RECIPIENT_DEDUCTED") ||
    (injected.feeBasis === "SANDBOX_BUYER_ESTIMATE" &&
      injected.feeAllocation !== "BUYER_GROSS_UP") ||
    injected.rounding !== "CEILING" ||
    !giftQuoteSchema.shape.feeAllocation.safeParse(injected.feeAllocation)
      .success ||
    !giftQuoteSchema.shape.policyVersion.safeParse(injected.version).success ||
    !Number.isInteger(injected.processingBasisPoints) ||
    injected.processingBasisPoints < 0 ||
    injected.processingBasisPoints >= 10_000 ||
    !giftCentsSchema.safeParse(injected.processingFixedCents).success
  ) {
    return policyUnavailable();
  }
  const nominal = BigInt(nominalResult.data);
  const rate = BigInt(injected.processingBasisPoints);
  const fixed = BigInt(injected.processingFixedCents);
  const commission = BigInt(getGiftCommissionCents(nominalResult.data));
  if (injected.feeAllocation === "RECIPIENT_DEDUCTED") {
    const processing = fixed + ceilingDivide(nominal * rate, BASIS_POINTS);
    if (nominal <= commission + processing) return policyUnavailable();
    return {
      nominalCents: nominalResult.data,
      commissionCents: Number(commission),
      processingCents: Number(processing),
      totalCents: nominalResult.data,
      policyVersion: injected.version,
      feeAllocation: injected.feeAllocation,
    };
  }

  // Unmarked policies retain the arithmetic of immutable historical quotes.
  // T - ceil(T * rate / D) = floor(T * (D - rate) / D).
  const total = ceilingDivide(
    (nominal + commission + fixed) * BASIS_POINTS,
    BASIS_POINTS - rate,
  );
  const totalResult = giftCentsSchema.safeParse(Number(total));
  if (!totalResult.success) {
    return policyUnavailable();
  }
  const processing = fixed + ceilingDivide(total * rate, BASIS_POINTS);
  return {
    nominalCents: nominalResult.data,
    commissionCents: Number(commission),
    processingCents: Number(processing),
    totalCents: totalResult.data,
    policyVersion: injected.version,
    ...(injected.feeAllocation
      ? { feeAllocation: injected.feeAllocation }
      : {}),
  };
}

export function serializeBrlCents(cents: number): string {
  const result = giftCentsSchema.safeParse(cents);
  if (!result.success) {
    return quoteInvalid();
  }
  const value = BigInt(result.data);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export function parseBrlCents(value: string): number {
  const match =
    typeof value === "string"
      ? /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value)
      : null;
  if (!match || match[0] !== value) {
    return quoteInvalid();
  }
  const cents =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  const result = giftCentsSchema.safeParse(Number(cents));
  if (!result.success) {
    return quoteInvalid();
  }
  return result.data;
}
