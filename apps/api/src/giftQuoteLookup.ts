import { readGiftPricingSettings } from "./giftPricingSettings";
import type { StoredGiftForQuote } from "./giftQuotes";
import { type GiftServiceOptions, lookupPublishedGift } from "./gifts";

export async function findPublishedGiftForQuote(
  db: Parameters<typeof lookupPublishedGift>[0],
  siteId: string,
  giftId: string,
  options: GiftServiceOptions = {},
): Promise<StoredGiftForQuote> {
  const gift = await lookupPublishedGift(db, siteId, giftId, options);
  const { feeAllocation, revision } = await readGiftPricingSettings(db, siteId);
  return {
    gift,
    pricingSettings: { feeAllocation, revision },
    publicationState: "PUBLISHED",
    siteActive: true,
  };
}
