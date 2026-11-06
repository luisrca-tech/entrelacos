import {
  getGiftCommissionCents,
  giftPricingPreviewInputSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { quoteGiftAmounts, quoteGiftPurchaseAmounts } from "./giftMoney";
import {
  type GiftQuoteServiceDependencies,
  GiftQuoteServiceError,
  loadGiftPricingEvidence,
} from "./giftQuotes";

// This private simulation reuses receiving and account-fee validation, but never stores
// a purchasable quote or upgrades observed fees into a contractual guarantee.
export async function previewGiftPricing(
  dependencies: GiftQuoteServiceDependencies,
  site: string,
  input: unknown,
) {
  const body = giftPricingPreviewInputSchema.safeParse(input);
  const siteId = siteIdSchema.safeParse(site);
  if (!body.success || !siteId.success)
    throw new GiftQuoteServiceError(
      400,
      "QUOTE_INVALID",
      "Invalid pricing preview",
    );
  const { nominalCents, feeAllocation } = body.data;
  const methods = await Promise.all(
    (["PIX", "CREDIT_CARD"] as const).map(async (method) => {
      const base = {
        method,
        nominalCents,
        commissionCents: getGiftCommissionCents(nominalCents),
      };
      try {
        const { pricing } = await loadGiftPricingEvidence(
          dependencies,
          siteId.data,
          method,
          feeAllocation,
        );
        const pricingInput = {
          nominalCents,
          method,
          policy: {
            ...pricing.policy,
            feeBasis: undefined,
            feeAllocation,
          },
        };
        const amounts =
          feeAllocation === "BUYER_GROSS_UP"
            ? quoteGiftPurchaseAmounts(pricingInput)
            : {
                ...quoteGiftAmounts(pricingInput),
                installmentOptions: undefined,
              };
        return {
          ...base,
          available: true,
          processingCents: amounts.processingCents,
          totalCents: amounts.totalCents,
          ...(amounts.installmentOptions
            ? { installmentOptions: amounts.installmentOptions }
            : {}),
          recipientNetCents:
            amounts.totalCents -
            amounts.commissionCents -
            amounts.processingCents,
        };
      } catch {
        return {
          ...base,
          available: false,
          processingCents: null,
          totalCents: null,
          recipientNetCents: null,
          installmentOptions: undefined,
        };
      }
    }),
  );
  const totals = methods
    .flatMap((method) =>
      !method.available
        ? []
        : [
            method.totalCents,
            ...(method.installmentOptions?.map((option) => option.totalCents) ??
              []),
          ],
    )
    .filter((total): total is number => total !== null);
  return {
    siteId: siteId.data,
    feeAllocation,
    methods,
    startingAtCents: totals.length ? Math.min(...totals) : null,
    guaranteed: false as const,
  };
}
