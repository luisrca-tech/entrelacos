import { z } from "zod";
import { giftCreateInputSchema } from "./internalGifts";

export const giftPricingSettingsSchema = z
  .object({
    siteId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    feeAllocation: z.enum(["RECIPIENT_DEDUCTED", "BUYER_GROSS_UP"]),
    revision: z.number().int().min(0).max(2147483647),
    buyerGrossUpAvailable: z.literal(false),
    blockedReason: z.string().min(1),
  })
  .strict();
export type GiftPricingSettings = z.infer<typeof giftPricingSettingsSchema>;
export const giftPricingSettingsResponseSchema = z
  .object({ settings: giftPricingSettingsSchema })
  .strict();
export const giftPricingSettingsInputSchema = giftPricingSettingsSchema.pick({
  feeAllocation: true,
  revision: true,
});
export type GiftPricingSettingsInput = z.infer<
  typeof giftPricingSettingsInputSchema
>;

export const giftPricingPreviewInputSchema = z
  .object({
    nominalCents: giftCreateInputSchema.shape.nominalCents,
    feeAllocation: giftPricingSettingsInputSchema.shape.feeAllocation,
  })
  .strict();
