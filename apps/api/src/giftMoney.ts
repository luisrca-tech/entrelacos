import {
  allocateGiftInstallmentCents,
  GIFT_PLATFORM_TARIFFS,
  type GiftInstallmentOption,
  type GiftQuote,
  type GiftV2Quote,
  getGiftCommissionCents,
  getGiftTariff,
  getGiftTariffTier,
  giftCentsSchema,
  giftMaximumInstallments,
  giftMinimumInstallmentCents,
  giftPaymentMethodSchema,
  giftQuoteSchema,
  listGiftV2Options,
  quoteGiftV2,
} from "@entrelacos/contracts";

export interface GiftProcessingPolicy {
  version: GiftQuote["policyVersion"];
  method: GiftQuote["method"];
  commissionBasisPoints: 200;
  processingBasisPoints: number;
  processingFixedCents: number;
  rounding: "CEILING";
  feeAllocation?: GiftQuote["feeAllocation"];
  feeBasis?:
    | "OBSERVED_ESTIMATE"
    | "SANDBOX_BUYER_ESTIMATE"
    | "ACCOUNT_BUYER_ESTIMATE"
    | "PLATFORM_TARIFF_TABLE";
  cardInstallmentBasisPoints?: { upToSix?: number; upToTwelve?: number };
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
      injected.feeBasis !== "SANDBOX_BUYER_ESTIMATE" &&
      injected.feeBasis !== "ACCOUNT_BUYER_ESTIMATE") ||
    (injected.feeBasis === "OBSERVED_ESTIMATE" &&
      injected.feeAllocation !== "RECIPIENT_DEDUCTED") ||
    ((injected.feeBasis === "SANDBOX_BUYER_ESTIMATE" ||
      injected.feeBasis === "ACCOUNT_BUYER_ESTIMATE") &&
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

function quoteGiftCardInstallments(
  base: GiftAmounts,
  policy: GiftProcessingPolicy,
): GiftInstallmentOption[] {
  const nominalCents = base.nominalCents;
  const options: GiftInstallmentOption[] = [
    {
      installmentCount: 1,
      totalCents: base.totalCents,
      installmentSurchargeCents: 0,
      installmentCents: [base.totalCents],
    },
  ];
  for (const { start, end, rate } of [
    { start: 2, end: 6, rate: policy.cardInstallmentBasisPoints?.upToSix },
    {
      start: 7,
      end: giftMaximumInstallments,
      rate: policy.cardInstallmentBasisPoints?.upToTwelve,
    },
  ]) {
    if (rate === undefined) continue;
    try {
      const amounts = quoteGiftAmounts({
        nominalCents,
        method: "CREDIT_CARD",
        policy: {
          ...policy,
          processingBasisPoints: rate,
        },
      });
      for (let count = start; count <= end; count++) {
        if (
          Math.floor(amounts.totalCents / count) < giftMinimumInstallmentCents
        )
          break;
        options.push({
          installmentCount: count,
          totalCents: amounts.totalCents,
          installmentSurchargeCents: amounts.totalCents - base.totalCents,
          installmentCents: allocateGiftInstallmentCents(
            amounts.totalCents,
            count,
          ),
        });
      }
    } catch (error) {
      if (!(error instanceof GiftMoneyServiceError)) throw error;
    }
  }
  return options;
}

export function quoteGiftPurchaseAmounts(
  input: QuoteGiftAmountsInput,
  installmentCount?: number,
): GiftAmounts &
  Pick<
    GiftQuote,
    | "installmentCount"
    | "installmentCents"
    | "installmentSurchargeCents"
    | "installmentOptions"
    | "anticipationCents"
  > {
  if (input.policy?.feeBasis === "PLATFORM_TARIFF_TABLE")
    return quoteGiftV2PurchaseAmounts(input, installmentCount);
  const base = quoteGiftAmounts(input);
  if (input.method !== "CREDIT_CARD" || !input.policy) return base;
  const options = quoteGiftCardInstallments(base, input.policy);
  const selected = options.find(
    (option) => option.installmentCount === (installmentCount ?? 1),
  );
  if (!selected) return quoteInvalid();
  return {
    ...base,
    ...selected,
    processingCents:
      selected.totalCents - base.nominalCents - base.commissionCents,
    installmentOptions: options,
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

function quoteGiftV2PurchaseAmounts(
  input: QuoteGiftAmountsInput,
  installmentCount?: number,
): ReturnType<typeof quoteGiftPurchaseAmounts> {
  const nominalResult = giftCentsSchema.safeParse(input.nominalCents);
  if (
    !nominalResult.success ||
    nominalResult.data === 0 ||
    !giftPaymentMethodSchema.safeParse(input.method).success ||
    (input.method === "PIX" && installmentCount !== undefined)
  )
    return quoteInvalid();
  const policy = input.policy;
  if (
    !policy ||
    policy.method !== input.method ||
    policy.commissionBasisPoints !== 200 ||
    policy.feeAllocation !== "BUYER_GROSS_UP" ||
    policy.version !== GIFT_PLATFORM_TARIFFS.version
  )
    return policyUnavailable();
  const fromQuote = (quote: GiftV2Quote) => ({
    nominalCents: quote.nominalCents,
    commissionCents: quote.commissionCents,
    // Anticipation is carried inside processing so allocation checks hold.
    processingCents: quote.processingCents + quote.anticipationCents,
    anticipationCents: quote.anticipationCents,
    totalCents: quote.totalCents,
    policyVersion: policy.version,
    feeAllocation: "BUYER_GROSS_UP" as const,
  });
  if (input.method === "PIX")
    return fromQuote(quoteGiftV2(nominalResult.data, "PIX", 1));
  const card = listGiftV2Options(nominalResult.data).card;
  const first = card[0];
  const selected = card.find(
    (quote) => quote.installmentCount === (installmentCount ?? 1),
  );
  if (!first || first.installmentCount !== 1) return policyUnavailable();
  if (!selected) return quoteInvalid();
  const installmentOptions = card.map((quote) => ({
    installmentCount: quote.installmentCount,
    totalCents: quote.totalCents,
    installmentSurchargeCents: quote.totalCents - first.totalCents,
    installmentCents: quote.installmentCents,
  }));
  return {
    ...fromQuote(selected),
    installmentCount: selected.installmentCount,
    installmentSurchargeCents: selected.totalCents - first.totalCents,
    installmentCents: selected.installmentCents,
    installmentOptions,
  };
}

/** Policy used for every new quote: the platform tariff table, no network. */
export function platformTariffPolicy(
  method: GiftQuote["method"],
): GiftProcessingPolicy {
  const tariff = getGiftTariff(getGiftTariffTier(method, 1));
  return {
    version: GIFT_PLATFORM_TARIFFS.version,
    method,
    commissionBasisPoints: 200,
    processingBasisPoints: tariff.basisPoints,
    processingFixedCents: tariff.fixedCents,
    rounding: "CEILING",
    feeAllocation: "BUYER_GROSS_UP",
    feeBasis: "PLATFORM_TARIFF_TABLE",
  };
}

/** Frozen per-installment couple split for a V2 quote (sums to the nominal). */
export function giftV2RecipientSplitCents(
  quote: Pick<GiftQuote, "nominalCents" | "method" | "installmentCount">,
): number[] {
  const v2 = quoteGiftV2(
    quote.nominalCents,
    quote.method,
    quote.installmentCount ?? 1,
  );
  if (!v2.offered) return policyUnavailable();
  return v2.recipientSplitCents;
}
