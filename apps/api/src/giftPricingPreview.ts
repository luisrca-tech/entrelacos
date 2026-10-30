import {
  getGiftCommissionCents,
  giftPricingPreviewInputSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { quoteGiftAmounts } from "./giftMoney";
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
          feeAllocation === "BUYER_GROSS_UP" &&
            dependencies.sandboxBuyerGrossUpSiteId === siteId.data
            ? feeAllocation
            : undefined,
        );
        const amounts = quoteGiftAmounts({
          nominalCents,
          method,
          policy: {
            ...pricing.policy,
            feeBasis: undefined,
            feeAllocation,
          },
        });
        return {
          ...base,
          available: true,
          processingCents: amounts.processingCents,
          totalCents: amounts.totalCents,
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
        };
      }
    }),
  );
  return {
    siteId: siteId.data,
    feeAllocation,
    methods,
    guaranteed: false as const,
  };
}
